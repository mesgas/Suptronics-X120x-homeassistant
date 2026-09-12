#!/usr/bin/env python3
"""Check that the X120X hardware is reachable, with no dependencies at all.

Run it wherever you want to know what that context can see -- the SSH add-on,
the Home Assistant container, a plain Raspberry Pi OS shell. It uses nothing
but the standard library, so it does not need libgpiod, gpiodetect, smbus2 or
pip.

    python3 x120x_probe.py [--bus 1] [--address 0x36] [--pld 6] [--chg 16]

It only reads. Nothing is written to the board.
"""

from __future__ import annotations

import argparse
import ctypes
import errno
import fcntl
import glob
import os
import struct
import sys

# --- GPIO character device, uAPI v2 (linux/gpio.h) ---------------------------

GPIO_MAX_NAME_SIZE = 32
SIZEOF_CHIPINFO = 68
SIZEOF_CONFIG_ATTRIBUTE = 24
SIZEOF_LINE_CONFIG = 32 + SIZEOF_CONFIG_ATTRIBUTE * 10
SIZEOF_LINE_REQUEST = 64 * 4 + GPIO_MAX_NAME_SIZE + SIZEOF_LINE_CONFIG + 32

FLAG_INPUT = 1 << 2
FLAG_BIAS_PULL_UP = 1 << 8


def _ioc(direction: int, type_: int, nr: int, size: int) -> int:
    return (direction << 30) | (size << 16) | (type_ << 8) | nr


GPIO_GET_CHIPINFO_IOCTL = _ioc(2, 0xB4, 0x01, SIZEOF_CHIPINFO)
GPIO_V2_GET_LINE_IOCTL = _ioc(3, 0xB4, 0x07, SIZEOF_LINE_REQUEST)
GPIO_V2_LINE_GET_VALUES_IOCTL = _ioc(3, 0xB4, 0x0E, 16)


def chip_info(path: str) -> tuple[str, int]:
    """Return the (label, line count) of a gpiochip."""
    fd = os.open(path, os.O_RDWR | os.O_CLOEXEC)
    try:
        buf = bytearray(SIZEOF_CHIPINFO)
        fcntl.ioctl(fd, GPIO_GET_CHIPINFO_IOCTL, buf, True)
    finally:
        os.close(fd)
    _name, label, lines = struct.unpack("<32s32sI", buf)
    return label.split(b"\x00", 1)[0].decode(errors="replace"), lines


def read_line(chip_path: str, offset: int, pull_up: bool = True) -> int:
    """Read one GPIO line, then release it again."""
    flags = FLAG_INPUT | (FLAG_BIAS_PULL_UP if pull_up else 0)
    config = struct.pack("<QI20x", flags, 0) + bytes(SIZEOF_CONFIG_ATTRIBUTE * 10)
    payload = bytearray(
        struct.pack("<I", offset)
        + bytes(4 * 63)
        + b"x120x-probe".ljust(GPIO_MAX_NAME_SIZE, b"\x00")
        + config
        + struct.pack("<II20xi", 1, 0, 0)
    )

    chip_fd = os.open(chip_path, os.O_RDWR | os.O_CLOEXEC)
    try:
        fcntl.ioctl(chip_fd, GPIO_V2_GET_LINE_IOCTL, payload, True)
    finally:
        os.close(chip_fd)

    line_fd = struct.unpack_from("<i", payload, SIZEOF_LINE_REQUEST - 4)[0]
    try:
        values = bytearray(struct.pack("<QQ", 0, 1))
        fcntl.ioctl(line_fd, GPIO_V2_LINE_GET_VALUES_IOCTL, values, True)
    finally:
        os.close(line_fd)
    return struct.unpack("<QQ", values)[0] & 1


# --- SMBus word reads, straight through the i2c-dev ioctls -------------------

I2C_SLAVE = 0x0703
I2C_SMBUS = 0x0720
I2C_SMBUS_READ = 1
I2C_SMBUS_WORD_DATA = 3


class _SmbusIoctlData(ctypes.Structure):
    _fields_ = [
        ("read_write", ctypes.c_ubyte),
        ("command", ctypes.c_ubyte),
        ("size", ctypes.c_uint32),
        ("data", ctypes.c_void_p),
    ]


def read_word(bus: int, address: int, register: int) -> int:
    """Read one SMBus word, byte-swapped the way the fuel gauge sends it."""
    fd = os.open(f"/dev/i2c-{bus}", os.O_RDWR)
    try:
        fcntl.ioctl(fd, I2C_SLAVE, address)
        buf = ctypes.create_string_buffer(34)
        args = _SmbusIoctlData(
            I2C_SMBUS_READ,
            register,
            I2C_SMBUS_WORD_DATA,
            ctypes.cast(buf, ctypes.c_void_p),
        )
        fcntl.ioctl(fd, I2C_SMBUS, args)
    finally:
        os.close(fd)
    raw = struct.unpack_from("<H", buf.raw)[0]
    return ((raw << 8) & 0xFF00) | (raw >> 8)


# --- Report -------------------------------------------------------------------

HEADER_LABELS = ("pinctrl-rp1", "pinctrl-bcm2712", "pinctrl-bcm2711", "pinctrl-bcm2835")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bus", type=int, default=1)
    parser.add_argument("--address", type=lambda v: int(v, 0), default=0x36)
    parser.add_argument("--pld", type=int, default=6)
    parser.add_argument("--chg", type=int, default=16)
    args = parser.parse_args()

    problems = 0
    print(f"uname: {' '.join(os.uname())}\n")

    # --- GPIO ---
    print("gpiochips")
    chips = sorted(glob.glob("/dev/gpiochip*"))
    if not chips:
        print("  none visible here")
        problems += 1
    header = None
    denied = 0
    for path in chips:
        try:
            label, lines = chip_info(path)
        except OSError as err:
            print(f"  {path:<20} unreadable: {err.strerror}")
            problems += 1
            if err.errno == errno.EPERM:
                denied += 1
            continue
        mark = ""
        if label in HEADER_LABELS and header is None:
            header, mark = path, "   <-- 40-pin header"
        print(f"  {path:<20} {label:<24} {lines:>3} lines{mark}")

    if header is None:
        if denied and denied == len(chips):
            # EPERM on every chip means the container was never granted access
            # to the device, which is a completely different problem from the
            # board being absent or the pins being wrong.
            print(
                "\n  Every chip refused to open with EPERM: this container was not\n"
                "  granted access to the GPIO devices. That is normal in the SSH\n"
                "  add-on, and says nothing about the board. Re-run this inside\n"
                "  the Home Assistant container, which is the only answer that\n"
                "  matters."
            )
        else:
            print("\n  No 40-pin header chip found.")
        problems += 1
    else:
        print(f"\nGPIO {args.pld} (power-loss detect) on {header}")
        try:
            value = read_line(header, args.pld)
        except OSError as err:
            print(f"  cannot read: {err}")
            problems += 1
        else:
            print(f"  value {value} -> {'mains present' if value else 'RUNNING ON BATTERY'}")
        print(f"GPIO {args.chg} (charge enable): left untouched by this probe")

    # --- I2C ---
    print("\ni2c buses")
    buses = sorted(glob.glob("/dev/i2c-*"))
    print("  " + (", ".join(buses) if buses else "none visible here"))
    if not buses:
        print("  Enable I2C (dtparam=i2c_arm=on) and make sure /dev/i2c-1 is passed through.")
        problems += 1

    print(f"\nfuel gauge at 0x{args.address:02x} on i2c-{args.bus}")
    try:
        voltage = read_word(args.bus, args.address, 0x02) * 1.25 / 1000 / 16
        capacity = read_word(args.bus, args.address, 0x04) / 256
    except OSError as err:
        hint = (
            "  (EPERM again: access denied to the device, not an I2C wiring problem)"
            if err.errno == errno.EPERM
            else ""
        )
        print(f"  no reply: {err.strerror}")
        if hint:
            print(hint)
        problems += 1
    else:
        print(f"  voltage  {voltage:.3f} V")
        print(f"  capacity {capacity:.1f} %")

    print("\n" + ("All good." if problems == 0 else f"{problems} problem(s) above."))
    return 0 if problems == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
