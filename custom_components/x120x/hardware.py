"""Blocking hardware layer for the Suptronics X120X UPS HAT.

Two independent pieces of hardware are involved:

* a MAX17040-family fuel gauge on I2C, holding cell voltage and state of charge;
* two GPIO lines on the 40-pin header -- power-loss detect (input) and charge
  enable, which the board reads as a level driven by the pin's internal bias.

Every method here blocks and is meant to run in an executor thread.
"""

from __future__ import annotations

from dataclasses import dataclass
import logging

from smbus2 import SMBus

from .const import (
    BATTERY_LEVEL_FULL,
    BATTERY_LEVEL_HIGH,
    BATTERY_LEVEL_LOW,
    BATTERY_LEVEL_MEDIUM,
    BATTERY_STATE_CRITICAL,
    BATTERY_STATE_FULL,
    BATTERY_STATE_HIGH,
    BATTERY_STATE_LOW,
    BATTERY_STATE_MEDIUM,
    CHARGE_COMPLETE_CAPACITY,
    REG_SOC,
    REG_VCELL,
    REG_VERSION,
    UPS_STATUS_CHARGING,
    UPS_STATUS_LOW_BATTERY,
    UPS_STATUS_ON_BATTERY,
    UPS_STATUS_ONLINE,
)
from .gpio import (
    BIAS_FLAGS,
    FLAG_BIAS_PULL_DOWN,
    FLAG_BIAS_PULL_UP,
    FLAG_INPUT,
    GpioError,
    LineRequest,
    find_header_chip,
)

_LOGGER = logging.getLogger(__name__)

# Index of each line within the held request.
_PLD_INDEX = 0
_CHG_INDEX = 1
_CHG_MASK = 1 << _CHG_INDEX


class X120XError(Exception):
    """Raised when the UPS cannot be read or configured."""


@dataclass(frozen=True, slots=True)
class X120XData:
    """One sample of the UPS state."""

    voltage: float
    capacity: float
    ac_present: bool
    charging_allowed: bool

    @property
    def battery_state(self) -> str:
        """Coarse battery level, from the gauge's state of charge."""
        if self.capacity >= BATTERY_LEVEL_FULL:
            return BATTERY_STATE_FULL
        if self.capacity >= BATTERY_LEVEL_HIGH:
            return BATTERY_STATE_HIGH
        if self.capacity >= BATTERY_LEVEL_MEDIUM:
            return BATTERY_STATE_MEDIUM
        if self.capacity >= BATTERY_LEVEL_LOW:
            return BATTERY_STATE_LOW
        return BATTERY_STATE_CRITICAL

    @property
    def is_charging(self) -> bool:
        """Whether the pack is being charged.

        The fuel gauge exposes no current register, so this is inferred: the
        board only charges when mains power is present, charging has not been
        switched off, and the pack is not already full.
        """
        return (
            self.ac_present
            and self.charging_allowed
            and self.capacity < CHARGE_COMPLETE_CAPACITY
        )

    def ups_status(self, low_battery_threshold: float) -> str:
        """Single label summarising what the UPS is doing right now."""
        if not self.ac_present:
            if self.capacity < low_battery_threshold:
                return UPS_STATUS_LOW_BATTERY
            return UPS_STATUS_ON_BATTERY
        if self.is_charging:
            return UPS_STATUS_CHARGING
        return UPS_STATUS_ONLINE


def _swap16(value: int) -> int:
    """The fuel gauge returns big-endian words over a little-endian SMBus read."""
    return ((value << 8) & 0xFF00) | (value >> 8)


class X120XDevice:
    """Owns the I2C bus handle and the GPIO line request for one UPS HAT."""

    def __init__(
        self,
        i2c_bus: int,
        i2c_address: int,
        pld_pin: int,
        chg_pin: int,
        pld_bias: str,
        gpiochip: str | None = None,
    ) -> None:
        self._i2c_bus = i2c_bus
        self._i2c_address = i2c_address
        self._pld_pin = pld_pin
        self._chg_pin = chg_pin
        self._pld_bias = pld_bias
        self._gpiochip = gpiochip

        self._bus: SMBus | None = None
        self._lines: LineRequest | None = None
        self._charging_allowed = True
        self._chip_version: int | None = None

    # --- Lifecycle ------------------------------------------------------------

    def open(self, charging_allowed: bool = True) -> None:
        """Open the I2C bus and take the GPIO lines. Blocking."""
        self._charging_allowed = charging_allowed

        try:
            self._bus = SMBus(self._i2c_bus)
        except (OSError, FileNotFoundError) as err:
            raise X120XError(
                f"Cannot open I2C bus {self._i2c_bus} (/dev/i2c-{self._i2c_bus}). "
                "Is I2C enabled and is the device passed through to Home Assistant?"
            ) from err

        try:
            chip = self._gpiochip or find_header_chip()
            self._lines = LineRequest(
                chip,
                offsets=[self._pld_pin, self._chg_pin],
                base_flags=FLAG_INPUT | BIAS_FLAGS.get(self._pld_bias, 0),
                attrs=[(self._charge_flags(charging_allowed), _CHG_MASK)],
            )
        except GpioError as err:
            self.close()
            raise X120XError(str(err)) from err

        try:
            self._chip_version = _swap16(
                self._bus.read_word_data(self._i2c_address, REG_VERSION)
            )
        except OSError:
            # Not every gauge in the family implements the register; it is only
            # cosmetic, so a failure here must not stop the setup.
            self._chip_version = None

        _LOGGER.debug(
            "X120X opened on i2c-%s@0x%02x, gpiochip %s, PLD=%s CHG=%s",
            self._i2c_bus,
            self._i2c_address,
            self._gpiochip or "auto",
            self._pld_pin,
            self._chg_pin,
        )

    def close(self) -> None:
        """Release both the bus and the lines. Blocking."""
        if self._lines is not None:
            self._lines.close()
            self._lines = None
        if self._bus is not None:
            try:
                self._bus.close()
            except OSError:  # pragma: no cover - nothing useful to do here
                pass
            self._bus = None

    @property
    def chip_version(self) -> int | None:
        """Version word reported by the fuel gauge, if it has one."""
        return self._chip_version

    # --- Reading --------------------------------------------------------------

    def read(self) -> X120XData:
        """Take one sample of voltage, capacity and mains state. Blocking."""
        if self._bus is None or self._lines is None:
            raise X120XError("device is not open")

        try:
            raw_voltage = self._bus.read_word_data(self._i2c_address, REG_VCELL)
            raw_capacity = self._bus.read_word_data(self._i2c_address, REG_SOC)
        except OSError as err:
            raise X120XError(
                f"No reply from the fuel gauge at 0x{self._i2c_address:02x} "
                f"on i2c-{self._i2c_bus}: {err}"
            ) from err

        # VCELL is a 12-bit value in the high bits, 1.25 mV per LSB.
        voltage = _swap16(raw_voltage) * 1.25 / 1000 / 16
        # SOC is 1/256 % per LSB.
        capacity = min(100.0, max(0.0, _swap16(raw_capacity) / 256))

        try:
            values = self._lines.get_values()
        except GpioError as err:
            raise X120XError(str(err)) from err

        return X120XData(
            voltage=round(voltage, 3),
            capacity=round(capacity, 2),
            # The PLD line is pulled high while the adapter is supplying power.
            ac_present=bool(values[_PLD_INDEX]),
            charging_allowed=self._charging_allowed,
        )

    # --- Charge control -------------------------------------------------------

    @property
    def charging_allowed(self) -> bool:
        """Whether charging is currently permitted.

        The board gives no read-back for this, so the value is the last one we
        wrote (restored across restarts by the switch entity).
        """
        return self._charging_allowed

    def _charge_flags(self, allowed: bool) -> int:
        # Mirrors the vendor script: an input with a pull-down enables charging,
        # a pull-up disables it.
        bias = FLAG_BIAS_PULL_DOWN if allowed else FLAG_BIAS_PULL_UP
        return FLAG_INPUT | bias

    def set_charging(self, allowed: bool) -> None:
        """Enable or disable battery charging. Blocking."""
        if self._lines is None:
            raise X120XError("device is not open")
        try:
            self._lines.set_config(
                base_flags=FLAG_INPUT | BIAS_FLAGS.get(self._pld_bias, 0),
                attrs=[(self._charge_flags(allowed), _CHG_MASK)],
            )
        except GpioError as err:
            raise X120XError(str(err)) from err
        self._charging_allowed = allowed
        _LOGGER.debug("X120X charging %s", "enabled" if allowed else "disabled")
