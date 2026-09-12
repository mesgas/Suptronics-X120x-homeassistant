"""Constants for the Suptronics X120X UPS integration."""

from __future__ import annotations

from typing import Final

DOMAIN: Final = "x120x"

VERSION: Final = "1.4.0"

MANUFACTURER: Final = "Suptronics"
MODELS: Final = ["X1200", "X1201", "X1202", "X1203"]

# Product pages, linked from the device page in Home Assistant.
MODEL_URLS: Final = {
    "X1200": "http://suptronics.com/Raspberrypi/Power_mgmt/x1200-v1.2.html",
    "X1201": "http://suptronics.com/Raspberrypi/Power_mgmt/x1201-v1.1.html",
    "X1202": "http://suptronics.com/Raspberrypi/Power_mgmt/x1202-v1.1.html",
    "X1203": "http://suptronics.com/Raspberrypi/Power_mgmt/x1203-v1.0.html",
}

# Where the bundled Lovelace card is served from.
URL_BASE: Final = "/x120x_static"
CARD_FILENAME: Final = "x120x-ups-card.js"
DATA_FRONTEND_REGISTERED: Final = "frontend_registered"

# --- Configuration keys -------------------------------------------------------

CONF_MODEL: Final = "model"
CONF_I2C_BUS: Final = "i2c_bus"
CONF_I2C_ADDRESS: Final = "i2c_address"
CONF_GPIOCHIP: Final = "gpiochip"
CONF_PLD_PIN: Final = "pld_pin"
CONF_CHG_PIN: Final = "chg_pin"
CONF_PLD_BIAS: Final = "pld_bias"
CONF_LOW_BATTERY: Final = "low_battery_threshold"

# --- Defaults -----------------------------------------------------------------

# The fuel gauge (MAX17040 family) sits at 0x36 on I2C bus 1.
DEFAULT_I2C_BUS: Final = 1
DEFAULT_I2C_ADDRESS: Final = 0x36

# GPIO 6 = power-loss detect (high = mains present).
DEFAULT_PLD_PIN: Final = 6
# GPIO 16 = charge enable. Pull-up disables charging, pull-down enables it.
DEFAULT_CHG_PIN: Final = 16

DEFAULT_PLD_BIAS: Final = "pull_up"
BIAS_OPTIONS: Final = ["pull_up", "pull_down", "disabled"]

DEFAULT_SCAN_INTERVAL: Final = 30
DEFAULT_LOW_BATTERY: Final = 20

# Charge window. The pack stops charging at the upper limit and only starts
# again once it has fallen back to the lower one, which keeps the charger from
# cycling on and off around a single threshold.
ATTR_CHARGE_LIMIT_MIN: Final = "charge_limit_min"
ATTR_CHARGE_LIMIT_MAX: Final = "charge_limit_max"
DEFAULT_CHARGE_LIMIT_MIN: Final = 95.0
DEFAULT_CHARGE_LIMIT_MAX: Final = 100.0
CHARGE_LIMIT_FLOOR: Final = 20.0

# --- Fuel gauge registers -----------------------------------------------------

REG_VCELL: Final = 0x02
REG_SOC: Final = 0x04
REG_VERSION: Final = 0x08

# --- Derived battery state ----------------------------------------------------

# Voltage bands taken from the vendor's merged-trixie.py reference script.
BATTERY_STATE_FULL: Final = "full"
BATTERY_STATE_HIGH: Final = "high"
BATTERY_STATE_MEDIUM: Final = "medium"
BATTERY_STATE_LOW: Final = "low"
BATTERY_STATE_CRITICAL: Final = "critical"

BATTERY_STATES: Final = [
    BATTERY_STATE_FULL,
    BATTERY_STATE_HIGH,
    BATTERY_STATE_MEDIUM,
    BATTERY_STATE_LOW,
    BATTERY_STATE_CRITICAL,
]

# Above this capacity the pack is considered full, so "charging" turns off even
# while mains power is present.
CHARGE_COMPLETE_CAPACITY: Final = 99.0

# --- Overall UPS status -------------------------------------------------------

UPS_STATUS_ONLINE: Final = "online"
UPS_STATUS_CHARGING: Final = "charging"
UPS_STATUS_ON_BATTERY: Final = "on_battery"
UPS_STATUS_LOW_BATTERY: Final = "low_battery"

UPS_STATUSES: Final = [
    UPS_STATUS_ONLINE,
    UPS_STATUS_CHARGING,
    UPS_STATUS_ON_BATTERY,
    UPS_STATUS_LOW_BATTERY,
]
