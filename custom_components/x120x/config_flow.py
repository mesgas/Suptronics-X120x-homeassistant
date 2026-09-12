"""Config flow for the Suptronics X120X UPS integration."""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import (
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.const import CONF_SCAN_INTERVAL
from homeassistant.core import callback
from homeassistant.helpers.selector import (
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
    TextSelector,
)

from .const import (
    BIAS_OPTIONS,
    CONF_CHG_PIN,
    CONF_GPIOCHIP,
    CONF_I2C_ADDRESS,
    CONF_I2C_BUS,
    CONF_LOW_BATTERY,
    CONF_MODEL,
    CONF_PLD_BIAS,
    CONF_PLD_PIN,
    DEFAULT_CHG_PIN,
    DEFAULT_I2C_ADDRESS,
    DEFAULT_I2C_BUS,
    DEFAULT_LOW_BATTERY,
    DEFAULT_PLD_BIAS,
    DEFAULT_PLD_PIN,
    DEFAULT_SCAN_INTERVAL,
    DOMAIN,
    MODELS,
)
from .coordinator import X120XConfigEntry
from .hardware import X120XDevice, X120XError

_LOGGER = logging.getLogger(__name__)


def _pin_selector() -> NumberSelector:
    return NumberSelector(
        NumberSelectorConfig(min=0, max=63, step=1, mode=NumberSelectorMode.BOX)
    )


STEP_USER_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_MODEL, default=MODELS[0]): SelectSelector(
            SelectSelectorConfig(options=MODELS, mode=SelectSelectorMode.DROPDOWN)
        ),
        vol.Required(CONF_I2C_BUS, default=DEFAULT_I2C_BUS): NumberSelector(
            NumberSelectorConfig(min=0, max=20, step=1, mode=NumberSelectorMode.BOX)
        ),
        vol.Required(
            CONF_I2C_ADDRESS, default=f"0x{DEFAULT_I2C_ADDRESS:02x}"
        ): TextSelector(),
        vol.Required(CONF_PLD_PIN, default=DEFAULT_PLD_PIN): _pin_selector(),
        vol.Required(CONF_CHG_PIN, default=DEFAULT_CHG_PIN): _pin_selector(),
        vol.Optional(CONF_GPIOCHIP, default=""): TextSelector(),
    }
)


class X120XConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the setup of an X120X UPS HAT."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Collect the wiring details and verify the board answers."""
        errors: dict[str, str] = {}

        if user_input is not None:
            try:
                address = int(str(user_input[CONF_I2C_ADDRESS]).strip(), 0)
            except ValueError:
                errors[CONF_I2C_ADDRESS] = "invalid_address"
            else:
                if not 0x03 <= address <= 0x77:
                    errors[CONF_I2C_ADDRESS] = "invalid_address"

            pld_pin = int(user_input[CONF_PLD_PIN])
            chg_pin = int(user_input[CONF_CHG_PIN])
            if pld_pin == chg_pin:
                errors[CONF_CHG_PIN] = "duplicate_pin"

            if not errors:
                data = {
                    CONF_MODEL: user_input[CONF_MODEL],
                    CONF_I2C_BUS: int(user_input[CONF_I2C_BUS]),
                    CONF_I2C_ADDRESS: address,
                    CONF_PLD_PIN: pld_pin,
                    CONF_CHG_PIN: chg_pin,
                    CONF_GPIOCHIP: user_input.get(CONF_GPIOCHIP, "").strip(),
                }

                await self.async_set_unique_id(
                    f"{data[CONF_I2C_BUS]}-{address:02x}-{pld_pin}-{chg_pin}"
                )
                self._abort_if_unique_id_configured()

                if error := await self._async_probe(data):
                    errors["base"] = error
                else:
                    return self.async_create_entry(
                        title=f"{data[CONF_MODEL]} UPS", data=data
                    )

        return self.async_show_form(
            step_id="user",
            data_schema=self.add_suggested_values_to_schema(
                STEP_USER_SCHEMA, user_input
            ),
            errors=errors,
        )

    async def _async_probe(self, data: dict[str, Any]) -> str | None:
        """Open the hardware once and read it. Returns an error key, or None."""
        device = X120XDevice(
            i2c_bus=data[CONF_I2C_BUS],
            i2c_address=data[CONF_I2C_ADDRESS],
            pld_pin=data[CONF_PLD_PIN],
            chg_pin=data[CONF_CHG_PIN],
            pld_bias=DEFAULT_PLD_BIAS,
            gpiochip=data[CONF_GPIOCHIP] or None,
        )

        def _probe() -> None:
            try:
                device.open()
                device.read()
            finally:
                device.close()

        try:
            await self.hass.async_add_executor_job(_probe)
        except X120XError as err:
            _LOGGER.debug("X120X probe failed: %s", err)
            message = str(err).lower()
            if "i2c" in message or "fuel gauge" in message:
                return "i2c_error"
            return "gpio_error"
        except Exception:  # noqa: BLE001 - surfaced to the user as unknown
            _LOGGER.exception("Unexpected error probing the X120X")
            return "unknown"
        return None

    @staticmethod
    @callback
    def async_get_options_flow(entry: X120XConfigEntry) -> X120XOptionsFlow:
        """Return the options flow."""
        return X120XOptionsFlow()


class X120XOptionsFlow(OptionsFlow):
    """Tune polling and thresholds without re-entering the wiring."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Manage the options."""
        if user_input is not None:
            return self.async_create_entry(
                data={
                    CONF_SCAN_INTERVAL: int(user_input[CONF_SCAN_INTERVAL]),
                    CONF_LOW_BATTERY: int(user_input[CONF_LOW_BATTERY]),
                    CONF_PLD_BIAS: user_input[CONF_PLD_BIAS],
                }
            )

        options = self.config_entry.options
        schema = vol.Schema(
            {
                vol.Required(
                    CONF_SCAN_INTERVAL,
                    default=options.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL),
                ): NumberSelector(
                    NumberSelectorConfig(
                        min=5, max=3600, step=1, mode=NumberSelectorMode.BOX
                    )
                ),
                vol.Required(
                    CONF_LOW_BATTERY,
                    default=options.get(CONF_LOW_BATTERY, DEFAULT_LOW_BATTERY),
                ): NumberSelector(
                    NumberSelectorConfig(
                        min=1, max=99, step=1, mode=NumberSelectorMode.SLIDER
                    )
                ),
                vol.Required(
                    CONF_PLD_BIAS,
                    default=options.get(CONF_PLD_BIAS, DEFAULT_PLD_BIAS),
                ): SelectSelector(
                    SelectSelectorConfig(
                        options=BIAS_OPTIONS,
                        translation_key="pld_bias",
                        mode=SelectSelectorMode.DROPDOWN,
                    )
                ),
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema)
