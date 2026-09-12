"""The Suptronics X120X UPS integration."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.typing import ConfigType

from .const import (
    CARD_FILENAME,
    CONF_MODEL,
    DATA_FRONTEND_REGISTERED,
    DOMAIN,
    MANUFACTURER,
    MODEL_URLS,
    URL_BASE,
    VERSION,
)
from .coordinator import X120XConfigEntry, X120XCoordinator

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [
    Platform.BINARY_SENSOR,
    Platform.NUMBER,
    Platform.SENSOR,
    Platform.SWITCH,
]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Serve the dashboard card as early as Home Assistant will let us.

    This lives here and not in async_setup_entry because entry setup waits for
    the I2C bus and the GPIO lines, and when the hardware is not ready it raises
    ConfigEntryNotReady and is retried with a growing backoff. The card has no
    reason to wait for any of that.
    """
    await _async_register_frontend(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: X120XConfigEntry) -> bool:
    """Set up the UPS from a config entry."""
    # Belt and braces: async_setup is not called when the component is loaded
    # only to set an entry up again after a reload, and registering twice is a
    # no-op anyway.
    await _async_register_frontend(hass)

    coordinator = X120XCoordinator(hass, entry)

    try:
        await coordinator.async_open()
    except Exception as err:
        await coordinator.async_close()
        raise ConfigEntryNotReady(str(err)) from err

    try:
        await coordinator.async_config_entry_first_refresh()
    except Exception:
        await coordinator.async_close()
        raise

    entry.runtime_data = coordinator
    _async_register_device(hass, entry, coordinator)

    entry.async_on_unload(entry.add_update_listener(_async_reload_entry))
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: X120XConfigEntry) -> bool:
    """Unload a config entry and hand the GPIO lines back to the kernel."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        await entry.runtime_data.async_close()
    return unloaded


async def _async_reload_entry(hass: HomeAssistant, entry: X120XConfigEntry) -> None:
    """Reload when the options change, so the new poll interval takes effect."""
    await hass.config_entries.async_reload(entry.entry_id)


def _async_register_device(
    hass: HomeAssistant, entry: X120XConfigEntry, coordinator: X120XCoordinator
) -> None:
    """Create the UPS in the device registry.

    Registering it here rather than leaving it to the first entity means the
    device exists with its full identity -- model, versions, product link, and
    the Raspberry Pi it is stacked on -- before any entity is added.
    """
    model = entry.data.get(CONF_MODEL, "X120X")
    chip_version = coordinator.device.chip_version

    registry = dr.async_get(hass)
    device = registry.async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, entry.entry_id)},
        manufacturer=MANUFACTURER,
        name=entry.title,
        model=f"{model} UPS HAT",
        model_id=model,
        sw_version=VERSION,
        hw_version=(f"fuel gauge rev {chip_version:04x}" if chip_version else None),
        configuration_url=MODEL_URLS.get(model),
    )

    # Stack the UPS under the host machine when Home Assistant knows about it,
    # so the device page shows what it is powering.
    host = registry.async_get_device(identifiers={("hassio", "host")})
    if host is not None and device.via_device_id != host.id:
        registry.async_update_device(device.id, via_device_id=host.id)


async def _async_register_frontend(hass: HomeAssistant) -> None:
    """Serve the bundled Lovelace card and make every dashboard load it.

    The card is registered as a Lovelace *resource*, exactly as if it had been
    added by hand under Settings -> Dashboards -> Resources, rather than being
    injected with add_extra_js_url.

    The difference is where the URL ends up. add_extra_js_url writes it into
    the HTML page the frontend serves, and that page is cached -- aggressively
    by the service worker, and wholesale by the companion apps. A client
    holding a page from a moment when the module was not listed shows "Custom
    element doesn't exist" until that copy is thrown away, on an integration
    that is working perfectly. Resources are not in the page at all: each
    dashboard asks the server for the list over the websocket every time it
    opens, so no cached copy of anything can leave the card out.

    Dashboards in YAML mode have no resource store to write to; there, and only
    there, the old injection is used.
    """
    domain_data = hass.data.setdefault(DOMAIN, {})
    if domain_data.get(DATA_FRONTEND_REGISTERED):
        return

    card_url = f"{URL_BASE}/{CARD_FILENAME}"
    frontend_dir = Path(__file__).parent / "frontend"

    if not await hass.async_add_executor_job(
        (frontend_dir / CARD_FILENAME).is_file
    ):
        _LOGGER.error(
            "Dashboard card not found at %s. The integration works, but the "
            "X120X card will not appear; reinstall the integration folder "
            "including its frontend/ directory",
            frontend_dir / CARD_FILENAME,
        )
        return

    try:
        await hass.http.async_register_static_paths(
            # Cache it: the URL carries ?v=<version>, so a release is a new URL
            # and can never be served stale.
            [StaticPathConfig(URL_BASE, str(frontend_dir), cache_headers=True)]
        )
    except (RuntimeError, ValueError) as err:
        # Already registered (a reload), or the router would not take it. The
        # first case is harmless; the second means the card cannot be served,
        # and staying silent about it turns a visible symptom -- no card in the
        # picker -- into something nobody can diagnose.
        _LOGGER.warning(
            "Could not register the static path for the X120X card at %s: %s. "
            "If %s does not load in a browser, add it manually as a dashboard "
            "resource of type 'JavaScript module'",
            URL_BASE,
            err,
            card_url,
        )

    versioned_url = f"{card_url}?v={VERSION}"
    if await _async_ensure_lovelace_resource(hass, card_url, versioned_url):
        _LOGGER.info(
            "X120X dashboard card registered as a Lovelace resource: %s",
            versioned_url,
        )
    else:
        add_extra_js_url(hass, versioned_url)
        _LOGGER.info(
            "Dashboards are in YAML mode, so the X120X card is injected instead "
            "of registered as a resource: %s",
            versioned_url,
        )
    domain_data[DATA_FRONTEND_REGISTERED] = True


def _lovelace_resources(hass: HomeAssistant) -> Any | None:
    """Return the Lovelace resource store, or None when there is none to write.

    Home Assistant has kept this in two shapes: a plain dict up to early 2025,
    a LovelaceData dataclass since. In YAML mode the collection is read-only
    and has no create method, which is the one thing checked here.
    """
    data = hass.data.get("lovelace")
    if data is None:
        return None
    resources = (
        data.get("resources")
        if isinstance(data, dict)
        else getattr(data, "resources", None)
    )
    if resources is None or not hasattr(resources, "async_create_item"):
        return None
    return resources


def _is_our_resource(item: dict[str, Any], card_url: str) -> bool:
    """Match on the path alone, whatever version or token follows it."""
    return str(item.get("url", "")).split("?", 1)[0] == card_url


async def _async_ensure_lovelace_resource(
    hass: HomeAssistant, card_url: str, versioned_url: str
) -> bool:
    """Create, update or de-duplicate our resource. False means "cannot"."""
    resources = _lovelace_resources(hass)
    if resources is None:
        return False
    try:
        # Loads the store from disk in every version that has one. Reading the
        # items before this would return an empty list and create a duplicate
        # at every restart.
        await resources.async_get_info()
        ours = [
            item for item in resources.async_items() if _is_our_resource(item, card_url)
        ]
        if not ours:
            await resources.async_create_item(
                {"res_type": "module", "url": versioned_url}
            )
            return True

        first, *duplicates = ours
        if first.get("url") != versioned_url or first.get("type") != "module":
            await resources.async_update_item(
                first["id"], {"res_type": "module", "url": versioned_url}
            )
        # A copy added by hand while chasing the missing card, or left behind
        # by an older release, would load the module twice.
        for item in duplicates:
            await resources.async_delete_item(item["id"])
    except Exception:  # noqa: BLE001 - any failure here must fall back, not break setup
        _LOGGER.warning(
            "Could not register the X120X card as a Lovelace resource; "
            "injecting it into the frontend instead",
            exc_info=True,
        )
        return False
    return True


async def async_remove_entry(hass: HomeAssistant, entry: X120XConfigEntry) -> None:
    """Take the card's resource away with the last UPS.

    A resource pointing at a path nobody serves any more would fail to load on
    every dashboard, forever, long after the integration itself is gone.
    """
    remaining = [
        other
        for other in hass.config_entries.async_entries(DOMAIN)
        if other.entry_id != entry.entry_id
    ]
    if remaining:
        return
    resources = _lovelace_resources(hass)
    if resources is None:
        return
    card_url = f"{URL_BASE}/{CARD_FILENAME}"
    try:
        await resources.async_get_info()
        for item in list(resources.async_items()):
            if _is_our_resource(item, card_url):
                await resources.async_delete_item(item["id"])
    except Exception:  # noqa: BLE001 - removal must not fail over a leftover
        _LOGGER.warning(
            "Could not remove the X120X card resource; delete it by hand under "
            "Settings -> Dashboards -> Resources",
            exc_info=True,
        )
