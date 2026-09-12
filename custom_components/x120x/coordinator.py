"""Polling coordinator for the Suptronics X120X UPS."""

from __future__ import annotations

from dataclasses import replace
from datetime import timedelta
import logging
import time

from homeassistant.components import persistent_notification
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
    DEFAULT_SHUTDOWN_BELOW,
    DOMAIN,
    EVENT_SHUTDOWN,
    SHUTDOWN_BELOW_MAX,
    SHUTDOWN_BELOW_MIN,
    SHUTDOWN_CONFIRM_SECONDS,
    SHUTDOWN_STARTUP_GRACE_SECONDS,
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

        self.shutdown_enabled = False
        self.shutdown_below = DEFAULT_SHUTDOWN_BELOW
        self._started_at = time.monotonic()
        # When the pack was first seen on battery and at or below the threshold,
        # in this unbroken run; None whenever that is not the case.
        self._shutdown_armed_at: float | None = None
        self._shutdown_requested = False

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

    # --- Automatic shutdown ---------------------------------------------------

    @property
    def host_shutdown_available(self) -> bool:
        """Whether this installation can shut its own host down.

        Only a supervised install (Home Assistant OS, Supervised) has the
        hassio.host_shutdown action. In a container or a plain Python venv the
        integration can still announce the moment with an event, but switching
        the machine off is up to whatever is listening for it.
        """
        return self.hass.services.has_service("hassio", "host_shutdown")

    @property
    def shutdown_seconds_left(self) -> int | None:
        """Seconds until the shutdown, while one is counting down."""
        if self._shutdown_armed_at is None or self._shutdown_requested:
            return None
        elapsed = time.monotonic() - self._shutdown_armed_at
        return max(0, round(SHUTDOWN_CONFIRM_SECONDS - elapsed))

    async def async_set_shutdown(
        self, *, enabled: bool | None = None, below: float | None = None
    ) -> None:
        """Turn the automatic shutdown on or off, or move its threshold."""
        if enabled is not None:
            self.shutdown_enabled = enabled
        if below is not None:
            self.shutdown_below = min(SHUTDOWN_BELOW_MAX, max(SHUTDOWN_BELOW_MIN, below))
        # Any change starts the confirmation over: raising the threshold while
        # a countdown runs must not turn into an instant shutdown.
        self._disarm_shutdown()
        await self.async_request_refresh()

    def _disarm_shutdown(self) -> None:
        if self._shutdown_armed_at is not None and not self._shutdown_requested:
            _LOGGER.info("Automatic shutdown cancelled")
        self._shutdown_armed_at = None
        self._shutdown_requested = False
        persistent_notification.async_dismiss(self.hass, self._notification_id)

    @property
    def _notification_id(self) -> str:
        return f"{DOMAIN}_shutdown_{self.config_entry.entry_id}"

    def _evaluate_shutdown(self, data: X120XData) -> None:
        """Decide, on every sample, whether it is time to shut the host down.

        Three things must all be true, continuously, for a full minute: the
        feature is on, the mains are gone, and the pack is at or below the
        threshold. Mains coming back at any point -- even for one sample --
        cancels it. So does touching either setting.
        """
        if (
            not self.shutdown_enabled
            or data.ac_present
            or data.capacity > self.shutdown_below
        ):
            if self._shutdown_armed_at is not None:
                self._disarm_shutdown()
            return

        now = time.monotonic()
        if now - self._started_at < SHUTDOWN_STARTUP_GRACE_SECONDS:
            return
        if self._shutdown_requested:
            return

        if self._shutdown_armed_at is None:
            self._shutdown_armed_at = now
            _LOGGER.warning(
                "On battery at %.0f%% (threshold %.0f%%): shutting the host down "
                "in %s seconds unless mains power returns",
                data.capacity,
                self.shutdown_below,
                SHUTDOWN_CONFIRM_SECONDS,
            )
            persistent_notification.async_create(
                self.hass,
                (
                    f"The UPS is on battery at {data.capacity:.0f}%, at or below "
                    f"the {self.shutdown_below:.0f}% threshold. The Raspberry Pi "
                    f"will be shut down in {SHUTDOWN_CONFIRM_SECONDS} seconds "
                    "unless mains power returns.\n\n"
                    "To stop it, turn off **Shutdown on low battery** on the UPS "
                    "device."
                ),
                title="UPS: shutting down soon",
                notification_id=self._notification_id,
            )
            return

        if now - self._shutdown_armed_at < SHUTDOWN_CONFIRM_SECONDS:
            return

        self._shutdown_requested = True
        self.hass.async_create_task(self._async_shutdown(data))

    async def _async_shutdown(self, data: X120XData) -> None:
        """Announce the shutdown, then carry it out where that is possible."""
        # The event goes out first and always: on an install that cannot shut
        # its own host down, an automation listening for it is the only way the
        # machine gets switched off in time.
        self.hass.bus.async_fire(
            EVENT_SHUTDOWN,
            {
                "entry_id": self.config_entry.entry_id,
                "capacity": data.capacity,
                "voltage": data.voltage,
                "threshold": self.shutdown_below,
            },
        )

        if not self.host_shutdown_available:
            _LOGGER.error(
                "Battery at %.0f%%: the host should be shut down now, but this "
                "installation has no hassio.host_shutdown action. The %s event "
                "has been fired for an automation to act on",
                data.capacity,
                EVENT_SHUTDOWN,
            )
            persistent_notification.async_create(
                self.hass,
                (
                    f"The battery is at {data.capacity:.0f}% and the Raspberry Pi "
                    "should be shut down now, but this installation type cannot "
                    "shut its own host down. An `x120x_shutdown` event has been "
                    "fired: an automation can react to it."
                ),
                title="UPS: shutdown not possible",
                notification_id=self._notification_id,
            )
            return

        _LOGGER.warning(
            "Battery at %.0f%% on battery power: shutting the host down",
            data.capacity,
        )
        await self.hass.services.async_call("hassio", "host_shutdown", blocking=False)

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

        self._evaluate_shutdown(data)
        return data
