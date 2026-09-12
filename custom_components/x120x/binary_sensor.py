"""Binary sensors for the Suptronics X120X UPS."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
    BinarySensorEntityDescription,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .coordinator import X120XConfigEntry, X120XCoordinator
from .entity import X120XEntity
from .hardware import X120XData


@dataclass(frozen=True, kw_only=True)
class X120XBinarySensorDescription(BinarySensorEntityDescription):
    """Describes an X120X binary sensor."""

    value_fn: Callable[[X120XData, X120XCoordinator], bool]


BINARY_SENSORS: tuple[X120XBinarySensorDescription, ...] = (
    X120XBinarySensorDescription(
        key="ac_power",
        device_class=BinarySensorDeviceClass.PLUG,
        value_fn=lambda data, _: data.ac_present,
    ),
    X120XBinarySensorDescription(
        key="battery_charging",
        device_class=BinarySensorDeviceClass.BATTERY_CHARGING,
        value_fn=lambda data, _: data.is_charging,
    ),
    X120XBinarySensorDescription(
        key="battery_low",
        device_class=BinarySensorDeviceClass.BATTERY,
        value_fn=lambda data, coordinator: data.capacity
        < coordinator.low_battery_threshold,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: X120XConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the X120X binary sensors."""
    coordinator = entry.runtime_data
    async_add_entities(
        X120XBinarySensor(coordinator, description)
        for description in BINARY_SENSORS
    )


class X120XBinarySensor(X120XEntity, BinarySensorEntity):
    """A boolean state derived from the UPS."""

    entity_description: X120XBinarySensorDescription

    def __init__(
        self,
        coordinator: X120XCoordinator,
        description: X120XBinarySensorDescription,
    ) -> None:
        super().__init__(coordinator, description.key)
        self.entity_description = description

    @property
    def is_on(self) -> bool:
        """Return the current state."""
        return self.entity_description.value_fn(
            self.coordinator.data, self.coordinator
        )
