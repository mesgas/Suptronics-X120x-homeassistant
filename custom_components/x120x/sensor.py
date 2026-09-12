"""Sensors for the Suptronics X120X UPS."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.const import PERCENTAGE, EntityCategory, UnitOfElectricPotential
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import BATTERY_STATES, UPS_STATUSES
from .coordinator import X120XConfigEntry, X120XCoordinator
from .entity import X120XEntity
from .hardware import X120XData


@dataclass(frozen=True, kw_only=True)
class X120XSensorDescription(SensorEntityDescription):
    """Describes an X120X sensor."""

    value_fn: Callable[[X120XData, X120XCoordinator], float | str | None]


SENSORS: tuple[X120XSensorDescription, ...] = (
    X120XSensorDescription(
        key="ups_status",
        device_class=SensorDeviceClass.ENUM,
        options=list(UPS_STATUSES),
        value_fn=lambda data, coordinator: data.ups_status(
            coordinator.low_battery_threshold
        ),
    ),
    X120XSensorDescription(
        key="battery",
        device_class=SensorDeviceClass.BATTERY,
        state_class=SensorStateClass.MEASUREMENT,
        native_unit_of_measurement=PERCENTAGE,
        suggested_display_precision=1,
        value_fn=lambda data, _: data.capacity,
    ),
    X120XSensorDescription(
        key="battery_voltage",
        device_class=SensorDeviceClass.VOLTAGE,
        state_class=SensorStateClass.MEASUREMENT,
        native_unit_of_measurement=UnitOfElectricPotential.VOLT,
        suggested_display_precision=3,
        value_fn=lambda data, _: data.voltage,
    ),
    X120XSensorDescription(
        key="battery_state",
        device_class=SensorDeviceClass.ENUM,
        options=list(BATTERY_STATES),
        entity_category=EntityCategory.DIAGNOSTIC,
        value_fn=lambda data, _: data.battery_state,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: X120XConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the X120X sensors."""
    coordinator = entry.runtime_data
    async_add_entities(
        X120XSensor(coordinator, description) for description in SENSORS
    )


class X120XSensor(X120XEntity, SensorEntity):
    """A value read from the UPS fuel gauge."""

    entity_description: X120XSensorDescription

    def __init__(
        self, coordinator: X120XCoordinator, description: X120XSensorDescription
    ) -> None:
        super().__init__(coordinator, description.key)
        self.entity_description = description

    @property
    def native_value(self) -> float | str | None:
        """Return the current reading."""
        return self.entity_description.value_fn(
            self.coordinator.data, self.coordinator
        )
