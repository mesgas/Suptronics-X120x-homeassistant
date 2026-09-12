"""Battery charge control for the Suptronics X120X UPS."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import (
    SwitchDeviceClass,
    SwitchEntity,
    SwitchEntityDescription,
)
from homeassistant.const import STATE_OFF, EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.restore_state import RestoreEntity

from .const import ATTR_CHARGE_LIMIT_MAX, ATTR_CHARGE_LIMIT_MIN
from .coordinator import X120XConfigEntry, X120XCoordinator
from .entity import X120XEntity

CHARGING_SWITCH = SwitchEntityDescription(
    key="charging",
    device_class=SwitchDeviceClass.SWITCH,
    entity_category=EntityCategory.CONFIG,
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: X120XConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the X120X charge control switch."""
    async_add_entities([X120XChargingSwitch(entry.runtime_data)])


class X120XChargingSwitch(X120XEntity, SwitchEntity, RestoreEntity):
    """Whether the pack is allowed to charge at all.

    This is the user's own intent, and it is the outer gate: the charge window
    can still pause charging while this is on. The board offers no read-back
    for the charge-enable pin, so the state is whatever was last set; it is
    restored on restart, and the board falls back to charging whenever the
    integration releases the GPIO lines.
    """

    entity_description = CHARGING_SWITCH

    def __init__(self, coordinator: X120XCoordinator) -> None:
        super().__init__(coordinator, CHARGING_SWITCH.key)

    async def async_added_to_hass(self) -> None:
        """Re-apply the charge setting that was in effect before the restart."""
        await super().async_added_to_hass()
        last_state = await self.async_get_last_state()
        if last_state is not None and last_state.state == STATE_OFF:
            await self.coordinator.async_set_charging_switch(False)

    @property
    def is_on(self) -> bool:
        """Return whether charging is allowed."""
        return self.coordinator.charging_switch_on

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Expose the charge window, so a dashboard can show it in one place."""
        return {
            ATTR_CHARGE_LIMIT_MIN: self.coordinator.effective_charge_limit_min,
            ATTR_CHARGE_LIMIT_MAX: self.coordinator.charge_limit_max,
            "charging_now": self.coordinator.data.is_charging,
        }

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Allow the pack to charge."""
        await self.coordinator.async_set_charging_switch(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Stop charging the pack."""
        await self.coordinator.async_set_charging_switch(False)
