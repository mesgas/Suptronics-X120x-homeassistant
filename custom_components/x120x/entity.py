"""Shared entity base for the Suptronics X120X UPS."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import X120XCoordinator


class X120XEntity(CoordinatorEntity[X120XCoordinator]):
    """Common device info and availability for every X120X entity."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: X120XCoordinator, key: str) -> None:
        super().__init__(coordinator)
        entry = coordinator.config_entry
        self._attr_unique_id = f"{entry.entry_id}_{key}"
        self._attr_translation_key = key
        # Only the identifiers: the device itself is created with its full
        # identity in async_setup_entry, and repeating the fields here would
        # let a stale entity overwrite them.
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)}
        )
