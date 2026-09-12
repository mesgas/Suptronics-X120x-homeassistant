"""A tiny pure-Python binding for the Linux GPIO character device (uAPI v2).

The vendor scripts use ``gpiod``/``gpiozero``, but neither installs cleanly in
every Home Assistant flavour: Home Assistant OS runs on Alpine (musl) and the
``gpiod`` wheels published on PyPI are glibc-only, so the dependency would have
to be compiled on the device.  The subset of the kernel ABI we actually need is
small -- request two lines, read their values, and change the bias of one of
them -- so we talk to ``/dev/gpiochipN`` directly via ``ioctl``.

Everything in this module blocks on file descriptors and must be called from an
executor thread, never from the event loop.
"""

from __future__ import annotations

import errno
import fcntl
import glob
import os
import struct
from types import TracebackType

# --- Kernel ABI constants (linux/gpio.h) -------------------------------------

_GPIO_MAX_NAME_SIZE = 32
_GPIO_V2_LINES_MAX = 64
_GPIO_V2_LINE_NUM_ATTRS_MAX = 10

# struct sizes, laid out by hand below
_SIZEOF_CHIPINFO = 68  # char[32] + char[32] + __u32
_SIZEOF_LINE_ATTRIBUTE = 16  # __u32 + __u32 + union __u64
_SIZEOF_CONFIG_ATTRIBUTE = _SIZEOF_LINE_ATTRIBUTE + 8  # + __u64 mask
_SIZEOF_LINE_CONFIG = 32 + _SIZEOF_CONFIG_ATTRIBUTE * _GPIO_V2_LINE_NUM_ATTRS_MAX
_SIZEOF_LINE_REQUEST = (
    _GPIO_V2_LINES_MAX * 4 + _GPIO_MAX_NAME_SIZE + _SIZEOF_LINE_CONFIG + 32
)
_OFFSET_REQUEST_FD = _SIZEOF_LINE_REQUEST - 4

# struct gpio_v2_line_flag
FLAG_ACTIVE_LOW = 1 << 1
FLAG_INPUT = 1 << 2
FLAG_OUTPUT = 1 << 3
FLAG_BIAS_PULL_UP = 1 << 8
FLAG_BIAS_PULL_DOWN = 1 << 9
FLAG_BIAS_DISABLED = 1 << 10

# enum gpio_v2_line_attr_id
_ATTR_ID_FLAGS = 1

BIAS_FLAGS: dict[str | None, int] = {
    "pull_up": FLAG_BIAS_PULL_UP,
    "pull_down": FLAG_BIAS_PULL_DOWN,
    "disabled": FLAG_BIAS_DISABLED,
    None: 0,
}

# Labels of the pin controller that drives the 40-pin header, newest first.
_HEADER_CHIP_LABELS = (
    "pinctrl-rp1",  # Raspberry Pi 5
    "pinctrl-bcm2712",
    "pinctrl-bcm2711",  # Raspberry Pi 4
    "pinctrl-bcm2835",  # Raspberry Pi 3 and older
)


def _ioc(direction: int, type_: int, nr: int, size: int) -> int:
    return (direction << 30) | (size << 16) | (type_ << 8) | nr


_IOC_WRITE = 1
_IOC_READ = 2
_IOC_RDWR = _IOC_READ | _IOC_WRITE

_GPIO_GET_CHIPINFO_IOCTL = _ioc(_IOC_READ, 0xB4, 0x01, _SIZEOF_CHIPINFO)
_GPIO_V2_GET_LINE_IOCTL = _ioc(_IOC_RDWR, 0xB4, 0x07, _SIZEOF_LINE_REQUEST)
_GPIO_V2_LINE_SET_CONFIG_IOCTL = _ioc(_IOC_RDWR, 0xB4, 0x0D, _SIZEOF_LINE_CONFIG)
_GPIO_V2_LINE_GET_VALUES_IOCTL = _ioc(_IOC_RDWR, 0xB4, 0x0E, 16)


class GpioError(Exception):
    """Raised when the GPIO character device cannot be used."""


def _pack_line_config(base_flags: int, attrs: list[tuple[int, int]]) -> bytes:
    """Pack a struct gpio_v2_line_config.

    ``attrs`` holds ``(flags, mask)`` pairs overriding ``base_flags`` for the
    lines selected by the bitmask, where bit N refers to the Nth line of the
    request (not to the GPIO offset).
    """
    if len(attrs) > _GPIO_V2_LINE_NUM_ATTRS_MAX:
        raise GpioError("too many line attributes")

    # __u64 flags; __u32 num_attrs; __u32 padding[5];
    packed = struct.pack("<QI20x", base_flags, len(attrs))
    for flags, mask in attrs:
        # struct gpio_v2_line_attribute { __u32 id; __u32 padding; __u64 flags; }
        # followed by __u64 mask
        packed += struct.pack("<IIQQ", _ATTR_ID_FLAGS, 0, flags, mask)
    packed += bytes(
        _SIZEOF_CONFIG_ATTRIBUTE * (_GPIO_V2_LINE_NUM_ATTRS_MAX - len(attrs))
    )
    return packed


def chip_info(path: str) -> tuple[str, int]:
    """Return the ``(label, line_count)`` of a gpiochip device."""
    fd = os.open(path, os.O_RDWR | os.O_CLOEXEC)
    try:
        buf = bytearray(_SIZEOF_CHIPINFO)
        fcntl.ioctl(fd, _GPIO_GET_CHIPINFO_IOCTL, buf, True)
    finally:
        os.close(fd)
    _name, label, lines = struct.unpack("<32s32sI", buf)
    return label.split(b"\x00", 1)[0].decode(errors="replace"), lines


def find_header_chip() -> str:
    """Locate the gpiochip exposing the Raspberry Pi 40-pin header.

    The numbering is not stable across board revisions and kernel versions --
    on a Pi 5 the header moved from ``gpiochip4`` to ``gpiochip0`` -- so match
    on the pin controller label instead.
    """
    candidates: dict[str, str] = {}
    fallback: str | None = None
    errors: dict[str, OSError] = {}

    paths = sorted(glob.glob("/dev/gpiochip*"))
    for path in paths:
        try:
            label, lines = chip_info(path)
        except OSError as err:
            errors[path] = err
            continue
        if label in _HEADER_CHIP_LABELS:
            candidates.setdefault(label, path)
        elif fallback is None and label.startswith("pinctrl-") and lines >= 32:
            fallback = path

    for label in _HEADER_CHIP_LABELS:
        if label in candidates:
            return candidates[label]
    if fallback:
        return fallback

    if not paths:
        raise GpioError(
            "No /dev/gpiochip* devices at all. The GPIO character device is "
            "not visible from here."
        )
    if len(errors) == len(paths):
        # Every chip refused to open, so we never got to look at any label.
        # EPERM is the signature of a container that was not granted access to
        # the device, as opposed to EACCES for plain file permissions -- worth
        # calling out, because it is not fixed by changing the pin numbers.
        denied = all(err.errno == errno.EPERM for err in errors.values())
        detail = ", ".join(f"{path}: {err.strerror}" for path, err in errors.items())
        raise GpioError(
            (
                "Not allowed to open any GPIO device. This container has not "
                "been granted access to /dev/gpiochip*. "
                if denied
                else "Could not open any GPIO device. "
            )
            + detail
        )
    raise GpioError(
        "No Raspberry Pi header gpiochip found among: " + ", ".join(paths)
    )


class LineRequest:
    """A held request over one or more GPIO lines.

    The request must stay open for its configuration to have any effect: the
    charge-enable pin is driven purely by its internal bias, and the kernel
    restores the default bias as soon as the file descriptor is closed.
    """

    def __init__(
        self,
        chip_path: str,
        offsets: list[int],
        base_flags: int,
        attrs: list[tuple[int, int]] | None = None,
        consumer: str = "x120x",
    ) -> None:
        if not offsets or len(offsets) > _GPIO_V2_LINES_MAX:
            raise GpioError(f"invalid line count: {len(offsets)}")

        self._offsets = list(offsets)
        self._fd: int | None = None

        try:
            chip_fd = os.open(chip_path, os.O_RDWR | os.O_CLOEXEC)
        except OSError as err:
            raise GpioError(f"cannot open {chip_path}: {err}") from err

        try:
            payload = bytearray(
                b"".join(struct.pack("<I", offset) for offset in self._offsets)
                + bytes(4 * (_GPIO_V2_LINES_MAX - len(self._offsets)))
                + consumer.encode()[: _GPIO_MAX_NAME_SIZE - 1].ljust(
                    _GPIO_MAX_NAME_SIZE, b"\x00"
                )
                + _pack_line_config(base_flags, attrs or [])
                # __u32 num_lines; __u32 event_buffer_size; __u32 padding[5]; __s32 fd;
                + struct.pack("<II20xi", len(self._offsets), 0, 0)
            )
            try:
                fcntl.ioctl(chip_fd, _GPIO_V2_GET_LINE_IOCTL, payload, True)
            except OSError as err:
                raise GpioError(
                    f"cannot request GPIO lines {self._offsets} on {chip_path}: {err}"
                ) from err
        finally:
            os.close(chip_fd)

        line_fd = struct.unpack_from("<i", payload, _OFFSET_REQUEST_FD)[0]
        if line_fd < 0:
            raise GpioError(f"kernel returned an invalid line fd ({line_fd})")
        self._fd = line_fd

    @property
    def offsets(self) -> list[int]:
        """The GPIO offsets held by this request, in request order."""
        return list(self._offsets)

    def get_values(self) -> list[int]:
        """Read every line, returned in the same order as ``offsets``."""
        if self._fd is None:
            raise GpioError("line request is closed")
        mask = (1 << len(self._offsets)) - 1
        buf = bytearray(struct.pack("<QQ", 0, mask))
        try:
            fcntl.ioctl(self._fd, _GPIO_V2_LINE_GET_VALUES_IOCTL, buf, True)
        except OSError as err:
            raise GpioError(f"cannot read GPIO values: {err}") from err
        bits = struct.unpack("<QQ", buf)[0]
        return [(bits >> index) & 1 for index in range(len(self._offsets))]

    def set_config(
        self, base_flags: int, attrs: list[tuple[int, int]] | None = None
    ) -> None:
        """Reconfigure the held lines, keeping the request (and its bias) alive."""
        if self._fd is None:
            raise GpioError("line request is closed")
        config = bytearray(_pack_line_config(base_flags, attrs or []))
        try:
            fcntl.ioctl(self._fd, _GPIO_V2_LINE_SET_CONFIG_IOCTL, config, True)
        except OSError as err:
            raise GpioError(f"cannot reconfigure GPIO lines: {err}") from err

    def close(self) -> None:
        """Release the lines. Their bias reverts to the board default."""
        if self._fd is not None:
            os.close(self._fd)
            self._fd = None

    def __enter__(self) -> LineRequest:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()
