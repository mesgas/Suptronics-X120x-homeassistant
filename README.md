# Suptronics X120X UPS — Home Assistant integration

Custom integration for the **Suptronics X1200 / X1201 / X1202 / X1203** UPS
HATs on a Raspberry Pi. It reads the fuel gauge over I2C and the HAT's GPIO
lines directly from the Home Assistant instance running on the same Pi.

The hardware protocol was derived from the vendor's own example scripts in
[suptronics/x120x](https://github.com/suptronics/x120x).

![The X120X UPS card](docs/card.png)

---

## What it creates

A complete **device** in the Home Assistant registry — manufacturer, model,
fuel gauge revision, a link to the product page, and stacked under the host
when Home Assistant knows about it — with these entities:

![The device page](docs/device.png)

| Entity | Type | Notes |
|---|---|---|
| Status | `sensor` (enum) | `online` · `charging` · `on_battery` · `low_battery` |
| Battery | `sensor` | percentage, `device_class: battery` |
| Battery voltage | `sensor` | volts, 3 decimals |
| Battery level | `sensor` (enum, diagnostic) | band derived from cell voltage |
| AC power | `binary_sensor` | `device_class: plug`, from GPIO 6 |
| Charging | `binary_sensor` | `device_class: battery_charging` |
| Battery low | `binary_sensor` | configurable threshold |
| Battery charging | `switch` | enables or disables charging (GPIO 16) |
| Charge up to | `number` | upper end of the charge window |
| Charge below | `number` | lower end of the charge window |

### The charge window

The two `number` entities define a range with **hysteresis**, enforced by the
integration itself: charging stops at the upper limit and only resumes once the
level has fallen back to the lower one. Set them to `60` and `80` and the pack
stays in the band that slows its ageing — **without writing any automation**.

The *Battery charging* switch is the outer gate: with it off the pack never
charges, whatever the window says. The defaults (95–100%) match the board's
normal behaviour.

---

## How the hardware works

| What | Where | Detail |
|---|---|---|
| Cell voltage | I2C `0x36`, register `0x02` | big-endian word, 1.25 mV per LSB / 16 |
| State of charge | I2C `0x36`, register `0x04` | big-endian word, 1/256 % per LSB |
| Mains present | GPIO 6 (BCM) | high means the adapter is supplying power |
| Charge enable | GPIO 16 (BCM) | pull-down enables charging, pull-up stops it |

The charge pin is not driven as an output: the board reads the level produced
by the **internal bias** of the pin configured as an input. That is why the
integration holds the GPIO line request open for its whole life — release it
and the kernel restores the default bias, so the board goes back to charging.

### Why not `gpiod`

Home Assistant OS runs on Alpine (musl) and the `gpiod` wheels published on
PyPI are glibc-only. The integration therefore talks to the kernel's GPIO
character device (`/dev/gpiochipN`, uAPI v2) directly through `ioctl` in pure
Python: nothing to compile. The only requirement is `smbus2`, which is pure
Python as well.

The gpiochip carrying the 40-pin header is found by the **label** of its pin
controller (`pinctrl-rp1` on a Pi 5, `pinctrl-bcm2711` on a Pi 4, and so on)
rather than by number, because the numbering changes between board revisions
and kernels: on the Pi 5 the header moved from `gpiochip4` to `gpiochip0`.

---

## Installation

### With HACS

[![Open in HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=mesgas&repository=Suptronics-X120x-homeassistant&category=integration)

Until the repository is in the default store, add it as a custom repository:
HACS → top-right menu → *Custom repositories* → paste this repository's URL,
category **Integration**.

Then install *Suptronics X120X UPS* and restart Home Assistant.

### By hand

Copy `custom_components/x120x/` into your `config/` directory and restart.

### Enabling I2C

`/dev/i2c-1` has to exist. On **Home Assistant OS**, add this to `config.txt`
on the boot partition:

```
dtparam=i2c_arm=on
```

and reboot. On Raspberry Pi OS, `sudo raspi-config` → *Interface Options* →
*I2C*.

### Configuration

*Settings → Devices & services → Add integration → Suptronics X120X UPS*.

The defaults match the stock wiring. The config flow actually opens the bus and
claims the GPIO lines before creating the device, so anything wrong is reported
straight away rather than later.

The **options** cover the polling interval, the low battery threshold and the
bias of the power-loss pin.

---

## The dashboard card

The integration serves and registers an animated Lovelace card by itself:
**no dashboard resource has to be added**. It shows up in the card picker as
*X120X UPS*, or in YAML:

```yaml
type: custom:x120x-ups-card
```

It needs no configuration: it finds the X120X device and recognises its
entities by device class, so it keeps working after a rename or in another
language. It draws the charge ring with the configured window as an outer arc,
a cell filling with animated liquid, the energy flow mains → UPS → Pi, a
sparkline of the level and the charge button. Every element opens the
more-info dialog of the matching entity.

### Four sizes

The same card in four cuts, through `variant`:

| `variant` | Shows | For |
|---|---|---|
| `full` *(default)* | ring, energy flow, sparkline, chips, button | a main panel |
| `compact` | ring, chips, button | a column of cards |
| `slim` | small ring and chips, one row | a dense summary |
| `gauge` | the dial alone, large and centred | a square tile in a grid |

```yaml
type: custom:x120x-ups-card
variant: compact
```

![The four variants](docs/variants.png)

Every block can still be forced on or off regardless of the variant, through
`show_flow`, `show_sparkline`, `show_chips` and `show_button`. For instance the
compact one **with** the energy flow diagram:

```yaml
type: custom:x120x-ups-card
variant: slim
show_flow: true
```

or the large dial with the status chips:

```yaml
type: custom:x120x-ups-card
variant: gauge
show_chips: true
```

An unknown `variant` is rejected with the list of the valid ones, rather than
producing some arbitrary layout.

### Animations

![The card reacting to the UPS state](docs/animations.gif)

Mains lost, the pack draining, the low-battery threshold crossed, then charging
again: the tint, the ring, the chips and the glow all follow the state.

Everything that moves carries information, and nothing loops without a reason:

- the percentage **counts** up to its new value instead of snapping to it;
- the ring fills with an interpolation, and a spark travels its edge only while
  charging is actually happening;
- the cell releases bubbles and shows the bolt only while charging;
- the flow lanes pulse towards the Pi; the mains lane goes quiet in a blackout;
- the glow breathes only when the battery is critical;
- the card assembles itself with a brief entrance on first paint.

The layout responds to the **width of the card**, not of the window
(`@container`): a narrow card in a column of a wide screen still switches to
the stacked layout. With `prefers-reduced-motion` every animation is disabled.

### All the options

```yaml
type: custom:x120x-ups-card
variant: full           # full | compact | slim | gauge
name: Rack UPS          # custom title
device_id: abc123...    # only when more than one X120X is configured
entities:               # explicit overrides, all optional
  capacity: sensor.x1200_ups_battery
  voltage: sensor.x1200_ups_battery_voltage
  status: sensor.x1200_ups_status
  level: sensor.x1200_ups_battery_level
  ac: binary_sensor.x1200_ups_ac_power
  charging: binary_sensor.x1200_ups_charging
  low: binary_sensor.x1200_ups_battery_low
  charge_switch: switch.x1200_ups_battery_charging
```

---

## A useful automation

A clean shutdown when the mains fail and the battery runs down. The integration
never shuts the Pi down on its own — that call stays yours:

```yaml
automation:
  - alias: Shut the Pi down on a flat UPS
    triggers:
      - trigger: numeric_state
        entity_id: sensor.x1200_ups_battery
        below: 15
        for: "00:01:00"
    conditions:
      - condition: state
        entity_id: binary_sensor.x1200_ups_ac_power
        state: "off"
    actions:
      - action: hassio.host_shutdown
```

---

## Icons

The **entity** icons live in `custom_components/x120x/icons.json` and follow
the state: the plug unplugs when the mains fail, the battery goes from full to
alarm, the switch shows whether charging is permitted.

The **brand** icon — the one in the integrations list — is in
`custom_components/x120x/brand/`:

```
brand/icon.png       256 x 256
brand/icon@2x.png    512 x 512
```

Since Home Assistant **2026.3** a custom integration carries its own brand
images inside its own folder, and the core serves them through the Brands Proxy
API (`/api/brands/integration/x120x/icon.png`). Pull requests to
[home-assistant/brands](https://github.com/home-assistant/brands) are no longer
accepted for custom components, so there is nothing to submit anywhere: copy
the integration and the icon comes with it.

On versions before 2026.3 the folder is simply ignored and the generic icon
appears. That is cosmetic only and changes nothing about how the integration
works.

To regenerate them:

```bash
python3 tools/make_brand_icons.py
```

They are drawn full bleed, with no transparent border, and the script checks
both the dimensions and the absence of a border itself. Should a dark-background
variant ever be needed, the expected names are `dark_icon.png` and
`dark_icon@2x.png`.

---

## Diagnostics

### Before installing: `tools/x120x_probe.py`

A standalone script with **no dependencies at all** — standard library only, so
it needs neither `libgpiod` nor `gpiodetect` nor `smbus2` nor `pip`. Copy it
wherever you want to know what that context can see — the SSH add-on, the Home
Assistant container, a plain Raspberry Pi OS shell — and run it:

```bash
python3 x120x_probe.py
```

It prints every `/dev/gpiochip*` with its **label** and line count, says which
one is the 40-pin header, reads the power-loss pin and queries the fuel gauge.
It only reads; nothing is written to the board.

### Once installed

From the device page, *Download diagnostics*: the file lists the readings, the
charge window and **every `/dev/i2c-*` and `/dev/gpiochip*` as seen by Home
Assistant itself**, with labels and line counts. It is the quickest way to tell
whether the container can see the hardware at all.

---

## Known limits

- The fuel gauge exposes no current, so *Charging* is inferred: mains present
  **and** charging permitted **and** the pack not already full.
- The board offers no read-back for the charge pin: the integration remembers
  the last value it wrote and restores it on restart.
- Removing or reloading the integration releases the GPIO lines, and the board
  returns to its default, which is charging enabled.

---

## Licence

[MIT](LICENSE).

This integration is neither affiliated with nor endorsed by Suptronics.
