"""Polling coordinator for the Suptronics X120X UPS."""

from __future__ import annotations

from dataclasses import replace
from datetime import timedelta
import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_SCAN_INTERVAL
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import (
    CHARGE_LIMIT_FLOOR,
    CONF_CHG_PIN,
    CONF_GPIOCHIP,
    CONF_I2C_ADDRESS,
    CONF_I2C_BUS,
    CONF_LOW_BATTERY,
    CONF_PLD_BIAS,
    CONF_PLD_PIN,
    DEFAULT_CHARGE_LIMIT_MAX,
    DEFAULT_CHARGE_LIMIT_MIN,
    DEFAULT_CHG_PIN,
    DEFAULT_I2C_ADDRESS,
    DEFAULT_I2C_BUS,
    DEFAULT_LOW_BATTERY,
    DEFAULT_PLD_BIAS,
    DEFAULT_PLD_PIN,
    DEFAULT_SCAN_INTERVAL,
    DOMAIN,
)
from .hardware import X120XData, X120XDevice, X120XError

_LOGGER = logging.getLogger(__name__)

type X120XConfigEntry = ConfigEntry[X120XCoordinator]


class X120XCoordinator(DataUpdateCoordinator[X120XData]):
    """Polls the UPS, owns the hardware handles, and keeps the charge window.

    Two things decide whether the pack is allowed to charge:

    * the charging switch, which is the user's own on/off intent;
    * the charge window, which stops charging once the pack reaches the upper
      limit and lets it start again once it falls back to the lower one.

    Both must allow it before the charge-enable pin is driven, so the window
    works without anyone having to write an automation.
    """

    config_entry: X120XConfigEntry

    def __init__(self, hass: HomeAssistant, entry: X120XConfigEntry) -> None:
        super().__init__(
            hass,
            _LOGGER,
            config_entry=entry,
            name=DOMAIN,
            update_interval=timedelta(
                seconds=entry.options.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL)
            ),
        )
        self.device = X120XDevice(
            i2c_bus=entry.data.get(CONF_I2C_BUS, DEFAULT_I2C_BUS),
            i2c_address=entry.data.get(CONF_I2C_ADDRESS, DEFAULT_I2C_ADDRESS),
            pld_pin=entry.data.get(CONF_PLD_PIN, DEFAULT_PLD_PIN),
            chg_pin=entry.data.get(CONF_CHG_PIN, DEFAULT_CHG_PIN),
            pld_bias=entry.options.get(CONF_PLD_BIAS, DEFAULT_PLD_BIAS),
            gpiochip=entry.data.get(CONF_GPIOCHIP) or None,
        )

        self.charging_switch_on = True
        self.charge_limit_min = DEFAULT_CHARGE_LIMIT_MIN
        self.charge_limit_max = DEFAULT_CHARGE_LIMIT_MAX
        # Latched side of the window: True while the pack is below the upper
        # limit and has not yet been told to stop.
        self._window_allows = True

    # --- Derived settings -----------------------------------------------------

    @property
    def low_battery_threshold(self) -> int:
        """Capacity below which the battery is reported as low."""
        return self.config_entry.options.get(CONF_LOW_BATTERY, DEFAULT_LOW_BATTERY)

    @property
    def effective_charge_limit_min(self) -> float:
        """Lower limit, never above the upper one."""
        return min(self.charge_limit_min, self.charge_limit_max)

    # --- Lifecycle ------------------------------------------------------------

    async def async_open(self) -> None:
        """Claim the I2C bus and the GPIO lines."""
        try:
            await self.hass.async_add_executor_job(
                self.device.open, self.charging_switch_on
            )
        except X120XError as err:
            raise UpdateFailed(str(err)) from err

    async def async_close(self) -> None:
        """Release the hardware, re-enabling charging at the board default."""
        await self.hass.async_add_executor_job(self.device.close)

    # --- Charge control -------------------------------------------------------

    async def async_set_charging_switch(self, allowed: bool) -> None:
        """Set the user's charge on/off intent."""
        self.charging_switch_on = allowed
        if allowed:
            # Re-arm the window, so switching charging back on takes effect
            # immediately instead of waiting for the pack to drain to the
            # lower limit.
            self._window_allows = True
        await self.async_request_refresh()

    async def async_set_charge_limit(self, *, minimum: float | None = None,
                                     maximum: float | None = None) -> None:
        """Move one end of the charge window."""
        if minimum is not None:
            self.charge_limit_min = max(CHARGE_LIMIT_FLOOR, minimum)
        if maximum is not None:
            self.charge_limit_max = max(CHARGE_LIMIT_FLOOR, maximum)

        # Re-arm the latch. Without this, widening the window would not take
        # effect: once charging has been stopped at the old upper limit, the
        # pack sits between the two limits, where neither branch of
        # _charge_target fires, so raising the upper limit would leave charging
        # off until the pack had drained all the way to the lower one. The next
        # evaluation latches it off again if the pack really is above the limit.
        self._window_allows = True
        await self.async_request_refresh()

    def _charge_target(self, capacity: float) -> bool:
        """Decide whether the charge-enable pin should be asserted."""
        if capacity >= self.charge_limit_max:
            self._window_allows = False
        elif capacity <= self.effective_charge_limit_min:
            self._window_allows = True
        return self.charging_switch_on and self._window_allows

    # --- Polling --------------------------------------------------------------

    async def _async_update_data(self) -> X120XData:
        try:
            data = await self.hass.async_add_executor_job(self.device.read)
        except X120XError as err:
            raise UpdateFailed(str(err)) from err

        target = self._charge_target(data.capacity)
        if target != self.device.charging_allowed:
            _LOGGER.debug(
                "Charge window: %s charging at %.1f%% (window %.0f-%.0f%%, switch %s)",
                "resuming" if target else "stopping",
                data.capacity,
                self.effective_charge_limit_min,
                self.charge_limit_max,
                "on" if self.charging_switch_on else "off",
            )
            try:
                await self.hass.async_add_executor_job(
                    self.device.set_charging, target
                )
            except X120XError as err:
                raise UpdateFailed(str(err)) from err
            data = replace(data, charging_allowed=target)

        return data
