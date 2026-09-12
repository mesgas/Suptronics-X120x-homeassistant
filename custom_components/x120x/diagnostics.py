"""Diagnostics support for the Suptronics X120X UPS."""

from __future__ import annotations

import glob
from typing import Any

from homeassistant.core import HomeAssistant

from .coordinator import X120XConfigEntry
from .gpio import chip_info


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: X120XConfigEntry
) -> dict[str, Any]:
    """Return diagnostics for a config entry."""
    coordinator = entry.runtime_data
    data = coordinator.data

    def _chips() -> dict[str, Any]:
        found: dict[str, Any] = {}
        for path in sorted(glob.glob("/dev/gpiochip*")):
            try:
                label, lines = chip_info(path)
            except OSError as err:
                found[path] = {"error": str(err)}
            else:
                found[path] = {"label": label, "lines": lines}
        return found

    return {
        "entry": {
            "data": dict(entry.data),
            "options": dict(entry.options),
        },
        "state": {
            "voltage": data.voltage,
            "capacity": data.capacity,
            "ac_present": data.ac_present,
            "charging_allowed": data.charging_allowed,
            "battery_state": data.battery_state,
            "is_charging": data.is_charging,
        },
        "charge_window": {
            "switch_on": coordinator.charging_switch_on,
            "minimum": coordinator.effective_charge_limit_min,
            "maximum": coordinator.charge_limit_max,
        },
        "i2c_devices": sorted(glob.glob("/dev/i2c-*")),
        "gpiochips": await hass.async_add_executor_job(_chips),
    }
