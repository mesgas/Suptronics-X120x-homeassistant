"""The Suptronics X120X UPS integration."""

from __future__ import annotations

import logging
import uuid
from pathlib import Path

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
    DATA_FRONTEND_TOKEN,
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

    The card URL is handed to the frontend with add_extra_js_url, and the
    frontend bakes the list of module URLs into the page it serves. A browser
    that loads a dashboard before this has run therefore gets a page with no
    mention of our module at all, and shows "Custom element doesn't exist"
    until it is reloaded -- on every client, for as long as that page stays
    open, with a perfectly healthy integration behind it.

    That is why this lives here and not in async_setup_entry: entry setup waits
    for the I2C bus and the GPIO lines, and when the hardware is not ready it
    raises ConfigEntryNotReady and is retried with a growing backoff. Opening
    the dashboard during that window used to mean no card, and nothing on
    screen connected the two facts.
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
    """Serve and auto-load the bundled Lovelace card.

    Registering the JS module ourselves means the card shows up in the card
    picker without the user having to add a dashboard resource by hand.
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
            # Cache it. The URL carries a cache key that changes with every
            # release and every restart (see below), so nothing can be served
            # stale for long -- while re-downloading 34 kB on every page load
            # delays the module enough that the dashboard can give up waiting
            # for it and report the card as a missing custom element.
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

    # The cache key is the version *and* a token minted once per Home Assistant
    # run. Versioning alone keeps an URL alive from one release to the next, so
    # a browser that happens to cache a truncated response keeps serving itself
    # that truncated response for weeks, and no ordinary reload dislodges it --
    # the card is simply missing and nothing explains why. With the token, the
    # file is still cached for the whole run (which is what stops the reload
    # storm that made the dashboard give up waiting for the module), and a
    # restart is enough to get a clean copy.
    token = domain_data.setdefault(DATA_FRONTEND_TOKEN, uuid.uuid4().hex[:8])
    add_extra_js_url(hass, f"{card_url}?v={VERSION}.{token}")
    domain_data[DATA_FRONTEND_REGISTERED] = True
    _LOGGER.info(
        "X120X dashboard card served at %s; it appears in the card picker as "
        "'X120X UPS' after a hard refresh of the browser",
        card_url,
    )
