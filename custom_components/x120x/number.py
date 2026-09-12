"""Charge window and shutdown threshold for the Suptronics X120X UPS."""

from __future__ import annotations

from homeassistant.components.number import (
    NumberEntity,
    NumberEntityDescription,
    NumberMode,
    RestoreNumber,
)
from homeassistant.const import PERCENTAGE, EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import (
    CHARGE_LIMIT_FLOOR,
    DEFAULT_CHARGE_LIMIT_MAX,
    DEFAULT_CHARGE_LIMIT_MIN,
    DEFAULT_SHUTDOWN_BELOW,
    SHUTDOWN_BELOW_MAX,
    SHUTDOWN_BELOW_MIN,
)
from .coordinator import X120XConfigEntry, X120XCoordinator
from .entity import X120XEntity

LIMIT_MIN = NumberEntityDescription(
    key="charge_limit_min",
    entity_category=EntityCategory.CONFIG,
    native_min_value=CHARGE_LIMIT_FLOOR,
    native_max_value=100,
    native_step=1,
    native_unit_of_measurement=PERCENTAGE,
    mode=NumberMode.SLIDER,
)

LIMIT_MAX = NumberEntityDescription(
    key="charge_limit_max",
    entity_category=EntityCategory.CONFIG,
    native_min_value=CHARGE_LIMIT_FLOOR,
    native_max_value=100,
    native_step=1,
    native_unit_of_measurement=PERCENTAGE,
    mode=NumberMode.SLIDER,
)

SHUTDOWN_BELOW = NumberEntityDescription(
    key="shutdown_below",
    entity_category=EntityCategory.CONFIG,
    native_min_value=SHUTDOWN_BELOW_MIN,
    native_max_value=SHUTDOWN_BELOW_MAX,
    native_step=1,
    native_unit_of_measurement=PERCENTAGE,
    mode=NumberMode.SLIDER,
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: X120XConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the charge window controls."""
    coordinator = entry.runtime_data
    async_add_entities(
        [
            X120XChargeLimit(coordinator, LIMIT_MIN, DEFAULT_CHARGE_LIMIT_MIN),
            X120XChargeLimit(coordinator, LIMIT_MAX, DEFAULT_CHARGE_LIMIT_MAX),
            X120XShutdownThreshold(coordinator),
        ]
    )


class X120XChargeLimit(X120XEntity, RestoreNumber):
    """One end of the range the pack is kept inside.

    Charging stops at the upper limit and starts again at the lower one, so a
    pack can be held around, say, 60-80% to slow its ageing without anyone
    writing an automation.
    """

    def __init__(
        self,
        coordinator: X120XCoordinator,
        description: NumberEntityDescription,
        default: float,
    ) -> None:
        super().__init__(coordinator, description.key)
        self.entity_description = description
        self._default = default
        self._is_minimum = description.key == LIMIT_MIN.key

    async def async_added_to_hass(self) -> None:
        """Restore the limit that was set before the restart."""
        await super().async_added_to_hass()
        restored = await self.async_get_last_number_data()
        value = (
            restored.native_value
            if restored is not None and restored.native_value is not None
            else self._default
        )
        await self._async_push(value)

    @property
    def native_value(self) -> float:
        """Return the current limit."""
        return (
            self.coordinator.charge_limit_min
            if self._is_minimum
            else self.coordinator.charge_limit_max
        )

    async def async_set_native_value(self, value: float) -> None:
        """Move this end of the window."""
        await self._async_push(value)

    async def _async_push(self, value: float) -> None:
        if self._is_minimum:
            await self.coordinator.async_set_charge_limit(minimum=value)
        else:
            await self.coordinator.async_set_charge_limit(maximum=value)
        self.async_write_ha_state()


class X120XShutdownThreshold(X120XEntity, RestoreNumber):
    """Charge at or below which, on battery, the Raspberry Pi is shut down.

    Does nothing on its own: the shutdown switch has to be on as well.
    """

    entity_description = SHUTDOWN_BELOW

    def __init__(self, coordinator: X120XCoordinator) -> None:
        super().__init__(coordinator, SHUTDOWN_BELOW.key)

    async def async_added_to_hass(self) -> None:
        """Restore the threshold that was set before the restart."""
        await super().async_added_to_hass()
        restored = await self.async_get_last_number_data()
        value = (
            restored.native_value
            if restored is not None and restored.native_value is not None
            else DEFAULT_SHUTDOWN_BELOW
        )
        await self.coordinator.async_set_shutdown(below=value)
        self.async_write_ha_state()

    @property
    def native_value(self) -> float:
        """Return the current threshold."""
        return self.coordinator.shutdown_below

    async def async_set_native_value(self, value: float) -> None:
        """Move the threshold."""
        await self.coordinator.async_set_shutdown(below=value)
        self.async_write_ha_state()
