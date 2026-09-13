"""Constants for the Suptronics X120X UPS integration."""

from __future__ import annotations

from typing import Final

DOMAIN: Final = "x120x"

VERSION: Final = "1.7.1"

MANUFACTURER: Final = "Suptronics"
# The whole X12xx family. Suptronics points the "Getting started - software"
# link of every one of these boards at the same page, titled "X12xx UPS board",
# which documents a single protocol: the fuel gauge at I2C 0x36, GPIO 6 for
# power-loss detection and GPIO 16 for charge control. The X1207 (PoE) and the
# X1208 (with an M.2 NVMe socket) add hardware around that, not to it. A board
# that ever deviates can still be corrected pin by pin in the config flow.
MODELS: Final = [
    "X1200",
    "X1201",
    "X1202",
    "X1203",
    "X1205",
    "X1206",
    "X1207",
    "X1208",
    "X1209",
]

# Product pages, linked from the device page in Home Assistant. The X12-A1 is
# absent on purpose: it is a bare battery holder, with no fuel gauge and no
# software page of its own, so there is nothing for this integration to read.
MODEL_URLS: Final = {
    "X1200": "https://suptronics.com/Raspberrypi/Power_mgmt/x1200-v1.2.html",
    "X1201": "https://suptronics.com/Raspberrypi/Power_mgmt/x1201-v1.1.html",
    "X1202": "https://suptronics.com/Raspberrypi/Power_mgmt/x1202-v1.1.html",
    "X1203": "https://suptronics.com/Raspberrypi/Power_mgmt/x1203-v1.0.html",
    "X1205": "https://suptronics.com/Raspberrypi/Power_mgmt/x1205-v1.1.html",
    "X1206": "https://suptronics.com/Raspberrypi/Power_mgmt/x1206-v2.0.html",
    "X1207": "https://suptronics.com/Raspberrypi/Power_mgmt/x1207-v1.2.html",
    "X1208": "https://suptronics.com/Raspberrypi/Power_mgmt/x1208-v1.0.html",
    "X1209": "https://suptronics.com/Raspberrypi/Power_mgmt/x1209-v1.0.html",
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

# --- Automatic shutdown -------------------------------------------------------

# Off by default: shutting the host down is not something to start doing on
# someone's behalf the moment they install an integration.
DEFAULT_SHUTDOWN_BELOW: Final = 10.0
# Below 5% the gauge's estimate is at its least trustworthy and the board's own
# cut-off is close; a shutdown started there may not get to finish.
SHUTDOWN_BELOW_MIN: Final = 5.0
SHUTDOWN_BELOW_MAX: Final = 90.0
# The condition has to hold this long without a break. One low reading, or a
# power cut shorter than a minute, is not a reason to switch the house off.
SHUTDOWN_CONFIRM_SECONDS: Final = 60
# After Home Assistant starts, nothing is shut down for this long. Without it a
# Pi started on a flat battery would shut itself down before anyone could reach
# the switch to stop it -- and do the same again at every attempt.
SHUTDOWN_STARTUP_GRACE_SECONDS: Final = 180
ATTR_SHUTDOWN_BELOW: Final = "shutdown_below"
EVENT_SHUTDOWN: Final = "x120x_shutdown"

# --- Fuel gauge registers -----------------------------------------------------

REG_VCELL: Final = 0x02
REG_SOC: Final = 0x04
REG_VERSION: Final = 0x08

# --- Derived battery state ----------------------------------------------------

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

# Lower edge of each band, on the fuel gauge's state of charge.
#
# These used to be cell voltages copied from the vendor's merged-trixie.py,
# which call a pack "full" from 3.87 V -- roughly half charge for a Li-ion
# cell, so "full" showed on a pack at 60%. Voltage is also a poor ruler on its
# own: it sags under load and floats after charging. The gauge's percentage
# already accounts for both, and is the figure every other entity uses.
BATTERY_LEVEL_FULL: Final = 95.0
BATTERY_LEVEL_HIGH: Final = 60.0
BATTERY_LEVEL_MEDIUM: Final = 30.0
BATTERY_LEVEL_LOW: Final = 10.0

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
