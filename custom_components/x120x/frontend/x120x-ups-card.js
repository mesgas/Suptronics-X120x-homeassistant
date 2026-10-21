/**
 * X120X UPS card.
 *
 * A self-contained Lovelace card for the Suptronics X120X UPS HAT. It is
 * served and auto-loaded by the integration, so no dashboard resource has to
 * be registered by hand.
 *
 * Configuration is optional: with no entities given the card finds the UPS
 * device on its own and matches its entities by device class, which keeps it
 * working whatever the entities ended up being named.
 *
 *   type: custom:x120x-ups-card
 *   variant: full | compact | slim | gauge   (default: full)
 *   name: optional title override
 *   device_id: optional, when more than one UPS is configured
 *   hours: how far back the level trace looks (default 24)
 *   show_flow / show_sparkline / show_chips / show_button:
 *       force a single block on or off, whatever the variant decided
 *   entities: optional explicit overrides, keyed by the roles below
 *
 * Everything on it moves for a reason: the ring's ticks light up to the
 * charge, a comet laps it while the pack charges (and runs backwards while it
 * drains), the cell's liquid sways and bubbles, and energy travels along the
 * wires of the diagram -- mains to pack to Pi, or pack to Pi in a blackout.
 */

const CARD_VERSION = "2.0.1";

const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");

/**
 * Count a number element up or down to its new value.
 *
 * A reading that snaps from 61 to 78 reads as a glitch; the same change rolled
 * over half a second reads as the thing actually moving. The last value lives
 * on the element, so the tween survives a re-render.
 */
function tweenNumber(element, to, format, duration = 650) {
  const previous = Number(element.dataset.value);
  element.dataset.value = String(to);

  if (element._tween) {
    cancelAnimationFrame(element._tween);
    element._tween = null;
  }
  if (REDUCED_MOTION.matches || !Number.isFinite(previous) || previous === to) {
    element.textContent = format(to);
    return;
  }

  const start = performance.now();
  const step = (now) => {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - progress) ** 3;
    element.textContent = format(previous + (to - previous) * eased);
    element._tween = progress < 1 ? requestAnimationFrame(step) : null;
  };
  element._tween = requestAnimationFrame(step);
}

console.info(
  `%c X120X-UPS-CARD %c ${CARD_VERSION} `,
  "color:#0b1020;background:#4fd1c5;font-weight:700;border-radius:3px 0 0 3px",
  "color:#4fd1c5;background:#0b1020;border-radius:0 3px 3px 0"
);

/**
 * Each role and how it is recognised among the device's entities. Matching on
 * device class rather than on the entity id keeps this working after a rename
 * and in every language.
 */
const ROLES = {
  status: (domain, attrs) =>
    domain === "sensor" &&
    attrs.device_class === "enum" &&
    Array.isArray(attrs.options) &&
    attrs.options.includes("on_battery"),
  level: (domain, attrs) =>
    domain === "sensor" &&
    attrs.device_class === "enum" &&
    Array.isArray(attrs.options) &&
    attrs.options.includes("critical"),
  capacity: (domain, attrs) =>
    domain === "sensor" && attrs.device_class === "battery",
  voltage: (domain, attrs) =>
    domain === "sensor" && attrs.device_class === "voltage",
  ac: (domain, attrs) =>
    domain === "binary_sensor" && attrs.device_class === "plug",
  charging: (domain, attrs) =>
    domain === "binary_sensor" && attrs.device_class === "battery_charging",
  low: (domain, attrs) =>
    domain === "binary_sensor" && attrs.device_class === "battery",
  // Not just "the switch": the device also has the shutdown-on-low-battery
  // switch, and taking whichever comes first would put the charge button on
  // the wrong one. Only the charging switch carries the charge window.
  charge_switch: (domain, attrs) =>
    domain === "switch" && attrs.charge_limit_min !== undefined,
};

const STATUS_TINT = {
  online: "#3ddc97",
  charging: "#4fd1c5",
  on_battery: "#f6c445",
  low_battery: "#ff5c5c",
  unknown: "#8a94a6",
};

/** The card speaks the dashboard's language: Italian or English. */
const STRINGS = {
  en: {
    online: "On line",
    charging: "Charging",
    on_battery: "On battery",
    low_battery: "Battery low",
    unknown: "Unknown",
    mains: "Mains",
    pack: "Battery",
    pi: "Raspberry Pi",
    voltage: "Voltage",
    window: "Charge window",
    power: "Power",
    mains_ok: "Mains OK",
    mains_lost: "Mains lost",
    not_charging: "Not charging",
    discharging: "Discharging",
    battery_low: "Battery low",
    battery_ok: "Battery healthy",
    hold: (min, max) => `Hold ${min}–${max}%`,
    no_limit: "No limit",
    charge: "Charging",
    charge_on: "Enabled",
    charge_off: "Paused",
    since: "since",
    trace: (hours, min, max) => `Last ${hours} h · min ${min}% · max ${max}%`,
    empty:
      "No X120X device found yet. If the integration is set up, reload the dashboard; otherwise name the entities explicitly in the card config.",
  },
  it: {
    online: "Dalla rete",
    charging: "In carica",
    on_battery: "A batteria",
    low_battery: "Batteria scarica",
    unknown: "Sconosciuto",
    mains: "Rete",
    pack: "Batteria",
    pi: "Raspberry Pi",
    voltage: "Tensione",
    window: "Finestra di carica",
    power: "Alimentazione",
    mains_ok: "Rete presente",
    mains_lost: "Rete assente",
    not_charging: "Non in carica",
    discharging: "In scarica",
    battery_low: "Batteria bassa",
    battery_ok: "Batteria in salute",
    hold: (min, max) => `Mantiene ${min}–${max}%`,
    no_limit: "Nessun limite",
    charge: "Ricarica",
    charge_on: "Attiva",
    charge_off: "In pausa",
    since: "da",
    trace: (hours, min, max) => `Ultime ${hours} h · min ${min}% · max ${max}%`,
    empty:
      "Nessuna UPS X120X trovata. Se l'integrazione è configurata ricarica la dashboard, altrimenti indica le entità nella configurazione della card.",
  },
};

// Gauge geometry, in the 200x200 viewBox.
const GAUGE_RADIUS = 72;
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS;
const WINDOW_RADIUS = 96;
const WINDOW_CIRCUMFERENCE = 2 * Math.PI * WINDOW_RADIUS;
const TICKS = 48;

// The pack in the diagram: its liquid spans these y values.
const CELL_TOP = 28;
const CELL_BOTTOM = 110;

// A single 18650 cell: empty at 3.0 V, full at 4.2 V.
const CELL_EMPTY_V = 3.0;
const CELL_FULL_V = 4.2;

const HISTORY_POINTS = 48;
const SPARK_W = 300;
const SPARK_H = 54;

// How far back the sparkline looks, and how often it asks the recorder again.
const DEFAULT_HISTORY_HOURS = 24;
const HISTORY_REFRESH_MS = 5 * 60 * 1000;

/**
 * Layouts, from the whole panel down to a bare dial. Each one decides which
 * blocks are on; every block can still be forced on or off individually with
 * show_flow / show_sparkline / show_chips / show_button.
 */
const VARIANTS = {
  full: { flow: true, sparkline: true, chips: true, button: true },
  compact: { flow: false, sparkline: false, chips: true, button: true },
  slim: { flow: false, sparkline: false, chips: true, button: false },
  gauge: { flow: false, sparkline: false, chips: false, button: false },
};

/** One wave of liquid, wide enough to slide by a whole period forever. */
function wavePath(amplitude, period, depth) {
  let d = `M${-period * 2},0`;
  for (let x = -period * 2; x < period * 5; x += period) {
    d += ` q${period / 4},${-amplitude} ${period / 2},0 t${period / 2},0`;
  }
  return `${d} V${depth} H${-period * 2} Z`;
}

class X120XUpsCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._entities = null;
    this._history = [];
    this._recorded = null;
    this._historyAt = 0;
    this._fetching = false;
    this._built = false;
    this._drawn = false;
  }

  static getStubConfig() {
    return { type: "custom:x120x-ups-card" };
  }

  static getConfigElement() {
    return document.createElement("x120x-ups-card-editor");
  }

  setConfig(config) {
    const variant = config.variant || "full";
    if (!VARIANTS[variant]) {
      throw new Error(
        `x120x-ups-card: unknown variant "${variant}". ` +
          `Use one of: ${Object.keys(VARIANTS).join(", ")}`
      );
    }
    this._config = { ...config, variant };
    this._entities = null;
    this._built = false;
    this._drawn = false;
    this.shadowRoot.innerHTML = "";
  }

  /** Which blocks this card shows, variant defaults with per-block overrides. */
  _parts() {
    const defaults = VARIANTS[this._config.variant];
    const resolve = (key) => {
      const override = this._config[`show_${key}`];
      return override === undefined ? defaults[key] : Boolean(override);
    };
    return {
      flow: resolve("flow"),
      sparkline: resolve("sparkline"),
      chips: resolve("chips"),
      button: resolve("button"),
    };
  }

  getCardSize() {
    const parts = VARIANTS[this._config.variant] || VARIANTS.full;
    return parts.flow ? 7 : parts.chips ? 4 : 3;
  }

  getGridOptions() {
    const variant = this._config.variant;
    if (variant === "gauge") return { columns: 6, rows: "auto", min_columns: 3 };
    if (variant === "slim") return { columns: 12, rows: "auto", min_columns: 6 };
    return { columns: 12, rows: "auto", min_columns: 6 };
  }

  set hass(hass) {
    this._hass = hass;
    // The registry can arrive a moment after the first states: until the pack
    // is found, every update tries again.
    if (!this._built || !this._entities || !this._entities.capacity) {
      this._build();
    }
    this._update();
    if (
      this._shown &&
      this._shown.sparkline &&
      Date.now() - this._historyAt > HISTORY_REFRESH_MS
    ) {
      this._fetchHistory();
    }
  }

  get _t() {
    const language = String(
      (this._hass && ((this._hass.locale && this._hass.locale.language) || this._hass.language)) || "en"
    ).slice(0, 2);
    return STRINGS[language] || STRINGS.en;
  }

  /**
   * Read the battery level from the recorder.
   *
   * The sparkline used to be built only from values seen while the dashboard
   * was open, which meant a pack sitting at a steady level drew nothing at
   * all: the line needs the level to change to have anything to plot. Asking
   * the recorder gives a real trace the moment the card is opened.
   */
  async _fetchHistory() {
    const entityId = this._entities && this._entities.capacity;
    if (this._fetching || !this._hass || !entityId) return;
    this._fetching = true;
    this._historyAt = Date.now();
    try {
      const end = new Date();
      const start = new Date(end.getTime() - this._hours() * 3600 * 1000);
      const response = await this._hass.callWS({
        type: "history/history_during_period",
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        entity_ids: [entityId],
        minimal_response: true,
        no_attributes: true,
      });
      this._recorded = this._bucket(
        response?.[entityId] || [],
        start.getTime(),
        end.getTime()
      );
      if (this._built) this._drawSparkline();
    } catch (err) {
      // No recorder, or the entity was purged: the live values collected while
      // the card is open still work as a fallback.
      console.warn("x120x-ups-card: could not read history", err);
      this._recorded = null;
    } finally {
      this._fetching = false;
    }
  }

  _hours() {
    return Number(this._config.hours) || DEFAULT_HISTORY_HOURS;
  }

  /** Average the raw history into evenly spaced buckets. */
  _bucket(raw, startMs, endMs) {
    const span = Math.max(endMs - startMs, 1);
    const sums = new Array(HISTORY_POINTS).fill(0);
    const counts = new Array(HISTORY_POINTS).fill(0);

    for (const entry of raw) {
      const value = Number(entry.s ?? entry.state);
      if (!Number.isFinite(value)) continue;
      const seconds = entry.lu ?? entry.lc;
      const stamp =
        typeof seconds === "number"
          ? seconds * 1000
          : Date.parse(entry.last_updated ?? entry.last_changed);
      if (!Number.isFinite(stamp)) continue;
      const index = Math.min(
        HISTORY_POINTS - 1,
        Math.max(0, Math.floor(((stamp - startMs) / span) * HISTORY_POINTS))
      );
      sums[index] += value;
      counts[index] += 1;
    }

    // Carry the last known value across gaps: a level that is not reported is
    // still whatever it last was, and a hole would draw as a drop to zero.
    const series = [];
    let last = null;
    for (let i = 0; i < HISTORY_POINTS; i += 1) {
      if (counts[i]) last = sums[i] / counts[i];
      if (last !== null) series.push(last);
    }
    return series;
  }

  /* ---------------------------------------------------------------- lookup */

  /**
   * Map each role to an entity id, preferring anything given in the config.
   * Returns null while no UPS device can be found.
   */
  _resolveEntities() {
    const resolved = { ...(this._config.entities || {}) };
    const missing = Object.keys(ROLES).filter((role) => !resolved[role]);
    if (missing.length === 0) {
      return resolved;
    }

    const registry = this._hass.entities;
    if (!registry) {
      return Object.keys(resolved).length ? resolved : null;
    }

    // Collect this integration's entities, grouped by the device they belong to.
    const byDevice = new Map();
    for (const [entityId, entry] of Object.entries(registry)) {
      if (entry.platform !== "x120x") continue;
      if (this._config.device_id && entry.device_id !== this._config.device_id) {
        continue;
      }
      const key = entry.device_id || "_";
      if (!byDevice.has(key)) byDevice.set(key, []);
      byDevice.get(key).push(entityId);
    }
    if (byDevice.size === 0) return null;

    const [deviceId, entityIds] = [...byDevice.entries()][0];
    this._deviceId = deviceId;

    for (const entityId of entityIds) {
      const state = this._hass.states[entityId];
      if (!state) continue;
      const domain = entityId.split(".")[0];
      for (const role of missing) {
        if (!resolved[role] && ROLES[role](domain, state.attributes)) {
          resolved[role] = entityId;
          break;
        }
      }
    }
    return resolved;
  }

  _state(role) {
    const entityId = this._entities && this._entities[role];
    if (!entityId) return null;
    return this._hass.states[entityId] || null;
  }

  _number(role, fallback = null) {
    const state = this._state(role);
    if (!state) return fallback;
    const value = Number(state.state);
    return Number.isFinite(value) ? value : fallback;
  }

  _isOn(role) {
    const state = this._state(role);
    return state ? state.state === "on" : false;
  }

  /* ----------------------------------------------------------------- build */

  _build() {
    this._entities = this._resolveEntities();

    const style = document.createElement("style");
    style.textContent = STYLES;
    const card = document.createElement("ha-card");
    card.className = "x120x";
    this.shadowRoot.innerHTML = "";
    this.shadowRoot.append(style, card);
    this._built = true;

    if (!this._entities || !this._entities.capacity) {
      this._el = null;
      card.innerHTML = `<div class="empty">
        <div class="empty-title">X120X UPS</div>
        <p></p>
      </div>`;
      card.querySelector("p").textContent = this._t.empty;
      return;
    }

    card.innerHTML = TEMPLATE;

    this._el = {};
    for (const node of card.querySelectorAll("[data-ref]")) {
      this._el[node.dataset.ref] = node;
    }

    this._el.gaugeValue.setAttribute(
      "stroke-dasharray",
      `${GAUGE_CIRCUMFERENCE} ${GAUGE_CIRCUMFERENCE}`
    );
    this._el.gaugeValue.setAttribute("stroke-dashoffset", GAUGE_CIRCUMFERENCE);

    // The ticks light up one after another as the charge climbs.
    this._el.ticks.innerHTML = Array.from({ length: TICKS }, (_, i) => {
      const a = (i / TICKS) * 2 * Math.PI - Math.PI / 2;
      const p = (r) =>
        `${(100 + r * Math.cos(a)).toFixed(2)},${(100 + r * Math.sin(a)).toFixed(2)}`;
      return `<path class="tick" d="M${p(84)} L${p(89)}" style="transition-delay:${i * 12}ms"/>`;
    }).join("");
    this._ticks = [...this._el.ticks.querySelectorAll(".tick")];

    // --- layout ----------------------------------------------------------
    // The blocks are hidden rather than removed, so _update can stay ignorant
    // of the variant and keep writing to the same nodes.
    this._shown = this._parts();
    card.dataset.variant = this._config.variant;
    // The roomy layouts get stat tiles; the slim and gauge ones, pills.
    card.dataset.chips =
      this._config.variant === "slim" || this._config.variant === "gauge" ? "pills" : "stats";
    // toggleAttribute, not `.hidden`: `hidden` is defined on HTMLElement and
    // not on SVGElement, so assigning it to an <svg> would silently create an
    // inert JS property and leave the element on screen.
    this._el.flow.toggleAttribute("hidden", !this._shown.flow);
    this._el.spark.toggleAttribute("hidden", !this._shown.sparkline);
    this._el.chips.toggleAttribute("hidden", !this._shown.chips);

    const t = this._t;
    this._el.lblMains.textContent = t.mains;
    this._el.lblPack.textContent = t.pack;
    this._el.lblPi.textContent = t.pi;
    this._el.lblVolt.textContent = t.voltage;
    this._el.lblWindow.textContent = t.window;
    this._el.lblPower.textContent = t.power;
    this._el.lblCharge.textContent = t.charge;

    // Anything carrying a role opens the matching more-info dialog.
    for (const node of card.querySelectorAll("[data-role]")) {
      node.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const entityId = this._entities[node.dataset.role];
        if (!entityId) return;
        const event = new Event("hass-more-info", {
          bubbles: true,
          composed: true,
        });
        event.detail = { entityId };
        this.dispatchEvent(event);
      });
    }

    this._el.chargeToggle.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const entityId = this._entities.charge_switch;
      if (!entityId) return;
      this._hass.callService("switch", "toggle", { entity_id: entityId });
    });
  }

  /* ---------------------------------------------------------------- update */

  _update() {
    if (!this._built || !this._el) return;
    const t = this._t;

    const capacity = this._number("capacity", 0);
    const voltage = this._number("voltage");
    const acOn = this._isOn("ac");
    const charging = this._isOn("charging");
    const low = this._isOn("low");
    const statusState = this._state("status");
    const statusKey = statusState ? statusState.state : "unknown";
    const tint = STATUS_TINT[statusKey] || STATUS_TINT.unknown;
    const card = this.shadowRoot.querySelector("ha-card");

    // One word for everything that animates: where the energy is going.
    let mode = "mains";
    if (low || statusKey === "low_battery") mode = acOn ? "charging" : "low";
    else if (!acOn) mode = "battery";
    else if (charging) mode = "charging";
    card.dataset.mode = mode;
    card.dataset.alert = String(low || statusKey === "low_battery");
    this.style.setProperty("--x-tint", tint);

    // --- headline ---------------------------------------------------------
    this._el.title.textContent =
      this._config.name || this._deviceName() || "X120X UPS";
    this._el.statusText.textContent =
      statusState && this._hass.formatEntityState
        ? this._displayState(statusState)
        : t[statusKey] || t.unknown;

    // --- gauge ------------------------------------------------------------
    const clamped = Math.max(0, Math.min(100, capacity));
    this._el.gaugeValue.setAttribute(
      "stroke-dashoffset",
      GAUGE_CIRCUMFERENCE * (1 - clamped / 100)
    );
    const lit = Math.round((clamped / 100) * TICKS);
    this._ticks.forEach((tick, i) => tick.classList.toggle("on", i < lit));
    // One decimal whenever the reading has one, as the sensor itself shows
    // it. Rounding to whole numbers turned 99.7% into "100", which is the one
    // figure a battery display must never claim before it is true -- and it
    // contradicted the entity's own more-info dialog beside it. The decimals
    // are decided by where the count ends, not by each frame, so a tween
    // towards 63% does not flicker through 62.4 on the way.
    const decimals = Math.round(clamped * 10) % 10 === 0 ? 0 : 1;
    tweenNumber(this._el.percent, clamped, (value) => value.toFixed(decimals));
    this._el.voltage.textContent =
      voltage === null ? "--" : `${voltage.toFixed(3)} V`;
    const levelState = this._state("level");
    this._el.levelText.textContent = levelState
      ? this._displayState(levelState)
      : "";

    // --- charge window ----------------------------------------------------
    this._renderChargeWindow(this._chargeWindow(), clamped);

    // --- the pack in the diagram -----------------------------------------
    // The liquid's surface sits at the charge; the bubbles rise that far.
    const surface = CELL_BOTTOM - ((CELL_BOTTOM - CELL_TOP) * clamped) / 100;
    this._el.liquid.style.transform = `translateY(${surface.toFixed(1)}px)`;
    this._el.flow.style.setProperty(
      "--depth",
      `${Math.max(6, CELL_BOTTOM - surface - 4).toFixed(1)}px`
    );

    // --- stat tiles and pills --------------------------------------------
    const voltFill =
      voltage === null
        ? 0
        : Math.max(0, Math.min(100, ((voltage - CELL_EMPTY_V) / (CELL_FULL_V - CELL_EMPTY_V)) * 100));
    this._el.voltValue.textContent = voltage === null ? "--" : `${voltage.toFixed(2)} V`;
    this._el.voltBar.style.width = `${voltFill}%`;

    const acState = this._state("ac");
    const since = acState ? this._relative(acState.last_changed) : "";
    this._el.powerValue.textContent = acOn ? t.mains_ok : t.mains_lost;
    this._el.powerSince.textContent = since ? `${t.since} ${since}` : "";
    this._el.powerTile.dataset.good = String(acOn);

    this._setChip("chipAc", acOn ? t.mains_ok : t.mains_lost, acOn);
    this._setChip(
      "chipCharge",
      charging ? t.charging : acOn ? t.not_charging : t.discharging,
      charging || acOn
    );
    this._setChip("chipLow", low ? t.battery_low : t.battery_ok, !low);

    const chargeSwitch = this._state("charge_switch");
    if (chargeSwitch && this._shown.button) {
      const on = chargeSwitch.state === "on";
      this._el.chargeRow.hidden = false;
      this._el.chargeToggle.setAttribute("aria-checked", String(on));
      this._el.chargeState.textContent = on ? t.charge_on : t.charge_off;
    } else {
      this._el.chargeRow.hidden = true;
    }

    if (this._shown.sparkline) {
      this._pushHistory(clamped);
      this._drawSparkline();
    }
  }

  /** The band the integration keeps the pack inside, or null when unlimited. */
  _chargeWindow() {
    const attrs = (this._state("charge_switch") || {}).attributes || {};
    const min = Number(attrs.charge_limit_min);
    const max = Number(attrs.charge_limit_max);
    const limited =
      Number.isFinite(min) && Number.isFinite(max) && max < 100 && max > min;
    return limited ? { min, max } : null;
  }

  /**
   * Draw the charge window twice: as an outer arc on the gauge, and as a band
   * on a 0-100 bar with the current level as a marker inside or outside it.
   */
  _renderChargeWindow(band, level) {
    const t = this._t;
    const arc = this._el.gaugeWindow;
    this._el.windowMarker.style.left = `${level}%`;
    if (!band) {
      arc.style.opacity = "0";
      this._el.windowBand.style.left = "0%";
      this._el.windowBand.style.width = "100%";
      this._el.windowValue.textContent = t.no_limit;
      this._el.chipWindow.hidden = true;
      return;
    }
    const { min, max } = band;
    const length = (WINDOW_CIRCUMFERENCE * (max - min)) / 100;
    arc.setAttribute("stroke-dasharray", `${length} ${WINDOW_CIRCUMFERENCE - length}`);
    arc.setAttribute("stroke-dashoffset", -(WINDOW_CIRCUMFERENCE * min) / 100);
    arc.style.opacity = "1";
    this._el.windowBand.style.left = `${min}%`;
    this._el.windowBand.style.width = `${max - min}%`;
    const text = t.hold(Math.round(min), Math.round(max));
    this._el.windowValue.textContent = `${Math.round(min)}–${Math.round(max)}%`;
    this._el.chipWindow.hidden = false;
    this._el.chipWindow.querySelector(".chip-text").textContent = text;
  }

  _setChip(ref, text, good) {
    const chip = this._el[ref];
    if (!chip) return;
    chip.querySelector(".chip-text").textContent = text;
    chip.dataset.good = String(Boolean(good));
  }

  _displayState(state) {
    // Reuse the translated state the frontend already computed, when it can.
    if (this._hass.formatEntityState) {
      try {
        return this._hass.formatEntityState(state);
      } catch (err) {
        /* fall through to the raw state */
      }
    }
    return state.state.replace(/_/g, " ");
  }

  /** "3 hours ago" without the "ago": how long the mains have been in or out. */
  _relative(iso) {
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return "";
    const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
    if (minutes < 1) return "";
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} h`;
    return `${Math.floor(hours / 24)} ${this._t === STRINGS.it ? "g" : "d"}`;
  }

  _deviceName() {
    const device =
      this._hass.devices && this._deviceId
        ? this._hass.devices[this._deviceId]
        : null;
    return device ? device.name_by_user || device.name : null;
  }

  /* ------------------------------------------------------------- sparkline */

  _pushHistory(capacity) {
    const last = this._history[this._history.length - 1];
    if (last === capacity) return;
    this._history.push(capacity);
    if (this._history.length > HISTORY_POINTS) this._history.shift();
  }

  _drawSparkline() {
    const { sparkLine, sparkArea, sparkTip, sparkNote } = this._el;

    // The recorder's trace when there is one, otherwise whatever has been seen
    // since the card was opened.
    const series =
      this._recorded && this._recorded.length >= 2 ? this._recorded : this._history;

    if (series.length < 2) {
      // A faint dashed baseline: it holds the space without pretending to be
      // a reading, until enough samples have come in to draw a real trace.
      sparkLine.setAttribute("d", `M0,${SPARK_H - 6} L${SPARK_W},${SPARK_H - 6}`);
      sparkLine.classList.add("empty");
      sparkArea.setAttribute("d", "");
      sparkTip.hidden = true;
      sparkNote.textContent = "";
      return;
    }
    sparkLine.classList.remove("empty");

    // Scale to the observed range, so small drifts stay readable.
    const min = Math.min(...series);
    const max = Math.max(...series);
    const span = Math.max(max - min, 1);
    const x = (i) => (i / (series.length - 1)) * SPARK_W;
    const y = (v) => SPARK_H - 4 - ((v - min) / span) * (SPARK_H - 16);
    const coords = series.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`);
    sparkLine.setAttribute("d", `M${coords.join(" L")}`);
    sparkArea.setAttribute("d", `M0,${SPARK_H} L${coords.join(" L")} L${SPARK_W},${SPARK_H} Z`);

    // A beating dot on the latest reading.
    sparkTip.hidden = false;
    sparkTip.style.bottom = `${((SPARK_H - y(series[series.length - 1])) / SPARK_H) * 100}%`;
    sparkNote.textContent = this._t.trace(this._hours(), Math.round(min), Math.round(max));

    if (!this._drawn && !REDUCED_MOTION.matches) {
      this._drawn = true;
      this._el.spark.classList.add("reveal");
    }
  }
}

/* ---------------------------------------------------------------- markup */

const TEMPLATE = `
<div class="aurora"></div>
<div class="head">
  <div class="title"><ha-icon icon="mdi:battery-charging-high"></ha-icon><span data-ref="title">X120X UPS</span></div>
  <div class="status" data-role="status">
    <span class="dot"></span>
    <span data-ref="statusText">--</span>
  </div>
</div>

<div class="hero">
  <div class="gauge" data-role="capacity">
    <svg viewBox="0 0 200 200" aria-hidden="true">
      <defs>
        <linearGradient id="x-dial" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" class="g-hi"/><stop offset="1" class="g-lo"/>
        </linearGradient>
        <linearGradient id="x-arc" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="var(--x-tint)" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="var(--x-tint)"/>
        </linearGradient>
      </defs>
      <circle class="halo" cx="100" cy="100" r="${GAUGE_RADIUS + 6}"/>
      <circle class="dial" cx="100" cy="100" r="${GAUGE_RADIUS - 9}" fill="url(#x-dial)"/>
      <g class="ticks" data-ref="ticks"></g>
      <circle class="window" data-ref="gaugeWindow" cx="100" cy="100" r="${WINDOW_RADIUS}"
              transform="rotate(-90 100 100)"/>
      <circle class="track" cx="100" cy="100" r="${GAUGE_RADIUS}"/>
      <circle class="value" data-ref="gaugeValue" cx="100" cy="100" r="${GAUGE_RADIUS}"
              transform="rotate(-90 100 100)"/>
      <g class="comet"><circle cx="100" cy="${100 - GAUGE_RADIUS}" r="4.5"/></g>
    </svg>
    <div class="readout">
      <div class="percent"><span data-ref="percent">--</span><i>%</i></div>
      <div class="volts" data-ref="voltage" data-role="voltage">--</div>
      <div class="level" data-ref="levelText"></div>
    </div>
  </div>

  <div class="flow" data-ref="flow">
    <svg viewBox="0 0 330 150" aria-hidden="true">
      <defs>
        <clipPath id="x-cell-clip"><rect x="139" y="${CELL_TOP}" width="52" height="${CELL_BOTTOM - CELL_TOP}" rx="9"/></clipPath>
        <clipPath id="x-shell-clip"><rect x="134" y="22" width="62" height="94" rx="13"/></clipPath>
        <linearGradient id="x-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" class="g-hi"/><stop offset="1" class="g-lo"/>
        </linearGradient>
        <radialGradient id="x-face" cx=".4" cy=".35" r=".75">
          <stop offset="0" class="g-hi"/><stop offset="1" class="g-lo"/>
        </radialGradient>
        <linearGradient id="x-pcb" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#46c08a"/><stop offset="1" stop-color="#1d7450"/>
        </linearGradient>
        <linearGradient id="x-gloss" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#fff" stop-opacity="0"/>
          <stop offset=".5" stop-color="#fff" stop-opacity=".45"/>
          <stop offset="1" stop-color="#fff" stop-opacity="0"/>
        </linearGradient>
        <radialGradient id="x-floor">
          <stop offset="0" class="fl-in"/><stop offset="1" class="fl-out"/>
        </radialGradient>
        <radialGradient id="x-shadow">
          <stop offset="0" stop-color="#000" stop-opacity=".28"/><stop offset="1" stop-color="#000" stop-opacity="0"/>
        </radialGradient>
      </defs>

      <!-- shadows on the floor, and the glow of the state under the pack -->
      <ellipse cx="42" cy="111" rx="32" ry="5" fill="url(#x-shadow)"/>
      <ellipse class="floor" cx="165" cy="124" rx="52" ry="8" fill="url(#x-floor)"/>
      <ellipse cx="165" cy="120" rx="34" ry="4.5" fill="url(#x-shadow)"/>
      <ellipse cx="288" cy="109" rx="40" ry="5" fill="url(#x-shadow)"/>

      <!-- wires: a dim track, and the energy that runs along it -->
      <path class="wire-track" d="M76 72 C 100 72, 108 72, 134 72"/>
      <path class="wire-track" d="M196 72 C 222 72, 228 72, 252 72"/>
      <path class="energy e-in" d="M76 72 C 100 72, 108 72, 134 72"/>
      <path class="energy e-out" d="M196 72 C 222 72, 228 72, 252 72"/>

      <!-- mains socket: a wall plate with a recessed face -->
      <g class="mains" data-role="ac">
        <rect class="plate-edge" x="10" y="43" width="64" height="64" rx="16"/>
        <rect class="plate" x="10" y="40" width="64" height="64" rx="16" fill="url(#x-body)"/>
        <circle class="socket-rim" cx="42" cy="72" r="21"/>
        <circle class="socket-face" cx="42" cy="72" r="18" fill="url(#x-face)"/>
        <circle class="pin" cx="35" cy="72" r="3.4"/>
        <circle class="pin" cx="49" cy="72" r="3.4"/>
        <path class="plate-shine" d="M18 50 Q 20 44 28 44 H 56"/>
        <path class="cut" d="M24 54 L60 90"/>
        <text class="node-label" x="42" y="142" text-anchor="middle" data-ref="lblMains"></text>
      </g>

      <!-- the pack: a glass cell with a metal cap -->
      <g class="pack" data-role="charging">
        <rect class="pack-cap" x="153" y="13" width="24" height="10" rx="3" fill="url(#x-body)"/>
        <rect class="pack-back" x="134" y="22" width="62" height="94" rx="13"/>
        <g clip-path="url(#x-cell-clip)">
          <g class="liquid" data-ref="liquid">
            <g transform="translate(139 0)">
              <g class="wave back"><path d="${wavePath(3, 26, 120)}"/></g>
              <g class="wave front"><path d="${wavePath(4, 34, 120)}"/></g>
            </g>
            <circle class="bub" cx="152" cy="0" r="2.2"/>
            <circle class="bub" cx="166" cy="0" r="1.6"/>
            <circle class="bub" cx="179" cy="0" r="2.6"/>
          </g>
        </g>
        <rect class="pack-shell" x="134" y="22" width="62" height="94" rx="13"/>
        <rect class="pack-shine" x="141" y="30" width="6" height="76" rx="3"/>
        <rect class="pack-shine soft" x="185" y="34" width="3" height="60" rx="1.5"/>
        <g clip-path="url(#x-shell-clip)"><rect class="gloss" x="80" y="10" width="34" height="120" fill="url(#x-gloss)"/></g>
        <path class="bolt" d="M170 40 L156 72 L166 72 L161 98 L177 62 L167 62 Z"/>
        <text class="node-label" x="165" y="142" text-anchor="middle" data-ref="lblPack"></text>
      </g>

      <!-- the Raspberry Pi: a board with its thickness, chips and ports -->
      <g class="pi">
        <rect class="pcb-edge" x="252" y="47" width="72" height="56" rx="7"/>
        <rect class="pcb" x="252" y="43" width="72" height="56" rx="7" fill="url(#x-pcb)"/>
        <g class="gpio">${Array.from({ length: 10 }, (_, i) => `<rect x="${258 + i * 6}" y="47" width="3.6" height="3.6" rx=".7"/>`).join("")}</g>
        <rect class="soc-edge" x="270" y="63" width="22" height="22" rx="3"/>
        <rect class="soc" x="270" y="61" width="22" height="22" rx="3"/>
        <rect class="soc-shine" x="273" y="64" width="16" height="4" rx="2"/>
        <rect class="port-usb" x="312" y="55" width="13" height="12" rx="2" fill="url(#x-body)"/>
        <rect class="port-usb" x="312" y="73" width="13" height="12" rx="2" fill="url(#x-body)"/>
        <circle class="led-pwr" cx="260" cy="91" r="2.3"/>
        <circle class="led-act" cx="267" cy="91" r="2.3"/>
        <text class="node-label" x="288" y="142" text-anchor="middle" data-ref="lblPi"></text>
      </g>
    </svg>
  </div>
</div>

<div class="chips" data-ref="chips">
  <div class="stats">
    <div class="stat" data-role="voltage">
      <span class="stat-label" data-ref="lblVolt"></span>
      <span class="stat-value" data-ref="voltValue">--</span>
      <span class="bar"><i data-ref="voltBar"></i></span>
    </div>
    <div class="stat" data-role="charge_switch">
      <span class="stat-label" data-ref="lblWindow"></span>
      <span class="stat-value" data-ref="windowValue">--</span>
      <span class="bar window-bar">
        <i class="band" data-ref="windowBand"></i>
        <b class="marker" data-ref="windowMarker"></b>
      </span>
    </div>
    <div class="stat power" data-ref="powerTile" data-role="ac">
      <span class="stat-label" data-ref="lblPower"></span>
      <span class="stat-value" data-ref="powerValue">--</span>
      <span class="stat-sub" data-ref="powerSince"></span>
    </div>
  </div>
  <div class="pills">
    <div class="chip" data-ref="chipAc" data-role="ac">
      <span class="chip-dot"></span><span class="chip-text">--</span>
    </div>
    <div class="chip" data-ref="chipCharge" data-role="charging">
      <span class="chip-dot"></span><span class="chip-text">--</span>
    </div>
    <div class="chip" data-ref="chipLow" data-role="low">
      <span class="chip-dot"></span><span class="chip-text">--</span>
    </div>
    <div class="chip window-chip" data-ref="chipWindow" data-role="charge_switch" data-good="true" hidden>
      <span class="chip-dot"></span><span class="chip-text">--</span>
    </div>
  </div>
</div>

<div class="charge-row" data-ref="chargeRow" hidden>
  <span class="charge-label" data-ref="lblCharge"></span>
  <span class="charge-state" data-ref="chargeState"></span>
  <button class="charge-toggle" data-ref="chargeToggle" role="switch" aria-checked="false">
    <span class="knob"></span>
  </button>
</div>

<div class="spark" data-ref="spark">
  <span class="spark-note" data-ref="sparkNote"></span>
  <svg viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="x-spark" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--x-tint)" stop-opacity="0.45"/>
        <stop offset="100%" stop-color="var(--x-tint)" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path class="spark-area" data-ref="sparkArea" d=""/>
    <path class="spark-line" data-ref="sparkLine" d="" pathLength="1"/>
  </svg>
  <span class="spark-tip" data-ref="sparkTip" hidden></span>
</div>

`;

/* ----------------------------------------------------------------- styles */

const STYLES = `
:host {
  --x-tint: #3ddc97;
  --x-ink: var(--primary-text-color, #e8ecf1);
  --x-muted: var(--secondary-text-color, #93a0b4);
  --x-surface: var(--ha-card-background, var(--card-background-color, #16181d));
  display: block;
  height: 100%;
  /* Lets the layout below react to the width of the card itself. A media
     query inside a shadow root measures the viewport, so a narrow card on a
     wide screen would wrongly keep the two-column layout. */
  container-type: inline-size;
}
[hidden] { display: none !important; }

/* The same tile as the rest of the dashboard: rounded glass, a hairline
   border, a soft drop shadow, and a light running along the top edge. */
ha-card.x120x {
  position: relative;
  isolation: isolate;
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  box-sizing: border-box;
  overflow: hidden;
  padding: 14px 16px 16px;
  border-radius: 24px;
  border: 1px solid color-mix(in srgb, var(--x-ink) 9%, transparent);
  background: color-mix(in srgb, var(--x-surface) 82%, transparent);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  box-shadow:
    0 1px 2px color-mix(in srgb, #000 8%, transparent),
    0 14px 30px -22px color-mix(in srgb, #000 40%, transparent);
}
ha-card.x120x::after {
  content: "";
  position: absolute; left: 0; right: 0; top: 0; height: 1px;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--x-tint) 80%, #fff), transparent);
  background-size: 40% 100%;
  background-repeat: no-repeat;
  animation: edge 7s ease-in-out infinite;
  opacity: .8;
  pointer-events: none;
}

/* An aurora in the colour of the state drifts behind everything. */
.aurora {
  position: absolute;
  z-index: -1;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(60% 60% at 100% 0%, color-mix(in srgb, var(--x-tint) 16%, transparent), transparent 70%),
    radial-gradient(50% 50% at 0% 100%, color-mix(in srgb, var(--x-tint) 7%, transparent), transparent 70%);
  background-size: 150% 150%;
  animation: aurora 20s ease-in-out infinite alternate;
  transition: background 600ms ease;
}
[data-alert="true"] .aurora { animation: aurora 20s ease-in-out infinite alternate, alarm 1.6s ease-in-out infinite; }

/* --- header --- */
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.title { display: inline-flex; align-items: center; gap: 8px; font-size: 1rem; font-weight: 650; color: var(--x-ink); }
.title ha-icon { --mdc-icon-size: 20px; color: color-mix(in srgb, var(--x-tint) 60%, var(--x-muted)); }
.status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 4px 11px;
  border-radius: 999px;
  cursor: pointer;
  font-size: .76rem;
  font-weight: 650;
  white-space: nowrap;
  color: color-mix(in srgb, var(--x-tint) 65%, var(--x-ink));
  background: color-mix(in srgb, var(--x-tint) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--x-tint) 32%, transparent);
}
.status .dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--x-tint);
  animation: ping 2.4s ease-out infinite;
}

/* --- hero: gauge and diagram --- */
.hero {
  display: grid;
  grid-template-columns: minmax(150px, 210px) minmax(0, 1fr);
  gap: 18px;
  align-items: center;
}
@container (max-width: 520px) {
  .hero { grid-template-columns: 1fr; gap: 10px; justify-items: center; }
  .flow { width: 100%; max-width: 380px; }
}

.gauge { position: relative; width: 100%; max-width: 210px; aspect-ratio: 1; margin: 0 auto; cursor: pointer; }
.gauge > svg { width: 100%; height: 100%; display: block; overflow: visible; }
.g-hi { stop-color: color-mix(in srgb, var(--x-ink) 6%, var(--x-surface)); }
.g-lo { stop-color: color-mix(in srgb, var(--x-ink) 17%, var(--x-surface)); }
.fl-in { stop-color: var(--x-tint); stop-opacity: .5; }
.fl-out { stop-color: var(--x-tint); stop-opacity: 0; }
.dial {
  stroke: color-mix(in srgb, var(--x-ink) 10%, transparent);
  filter: drop-shadow(0 6px 8px color-mix(in srgb, #000 22%, transparent));
}
.halo {
  fill: color-mix(in srgb, var(--x-tint) 10%, transparent);
  stroke: none;
  transform-origin: 100px 100px;
  animation: breathe 5s ease-in-out infinite;
}
.tick { stroke: color-mix(in srgb, var(--x-ink) 14%, transparent); stroke-width: 2.4; stroke-linecap: round; transition: stroke 300ms ease; }
.tick.on { stroke: var(--x-tint); filter: drop-shadow(0 0 2px var(--x-tint)); }
.track { fill: none; stroke: color-mix(in srgb, var(--x-ink) 8%, transparent); stroke-width: 12; }
.value {
  fill: none;
  stroke: url(#x-arc);
  stroke-width: 12;
  stroke-linecap: round;
  filter: drop-shadow(0 0 8px color-mix(in srgb, var(--x-tint) 55%, transparent));
  transition: stroke-dashoffset 1100ms cubic-bezier(.22,.61,.36,1);
}
.window {
  fill: none;
  stroke: color-mix(in srgb, var(--x-tint) 60%, transparent);
  stroke-width: 3.5;
  stroke-linecap: round;
  opacity: 0;
  transition: opacity 400ms ease, stroke-dashoffset 600ms ease;
}
.comet { transform-origin: 100px 100px; opacity: 0; }
.comet circle { fill: #fff; filter: drop-shadow(0 0 4px var(--x-tint)) drop-shadow(0 0 9px var(--x-tint)); }
/* A comet laps the ring forwards while the pack charges, backwards while it drains. */
[data-mode="charging"] .comet { opacity: 1; animation: spin 2.6s linear infinite; }
[data-mode="battery"] .comet, [data-mode="low"] .comet { opacity: 1; animation: spin 3.4s linear infinite reverse; }

.readout {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.percent {
  font-size: clamp(1.8rem, 9cqw, 2.6rem);
  font-weight: 780;
  line-height: 1;
  color: var(--x-ink);
  font-variant-numeric: tabular-nums;
  letter-spacing: -.03em;
}
.percent i { font-size: .95rem; font-style: normal; color: var(--x-muted); margin-left: 3px; }
.volts { margin-top: 6px; font-size: .8rem; color: var(--x-muted); font-variant-numeric: tabular-nums; pointer-events: auto; cursor: pointer; }
.level {
  margin-top: 3px;
  font-size: .62rem;
  letter-spacing: .12em;
  text-transform: uppercase;
  font-weight: 700;
  color: color-mix(in srgb, var(--x-tint) 85%, var(--x-muted));
}

/* --- the diagram --- */
.flow svg { width: 100%; height: auto; display: block; overflow: visible; }
.node-label { fill: var(--x-muted); font-size: 10px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; }
.wire-track { fill: none; stroke: color-mix(in srgb, var(--x-ink) 12%, transparent); stroke-width: 5; stroke-linecap: round; }
.energy {
  fill: none;
  stroke: var(--x-tint);
  stroke-width: 5;
  stroke-linecap: round;
  stroke-dasharray: 2 14;
  filter: drop-shadow(0 0 4px var(--x-tint));
  opacity: 0;
}
/* Energy always travels towards the Pi; only the mains leg goes quiet. */
[data-mode="mains"] .energy, [data-mode="charging"] .energy { opacity: 1; animation: flow 0.9s linear infinite; }
[data-mode="battery"] .e-out, [data-mode="low"] .e-out { opacity: 1; animation: flow 1.4s linear infinite; }
[data-mode="battery"] .e-in, [data-mode="low"] .e-in { opacity: 0; }
/* In a blackout the mains wire is cut: thin, broken, grey. */
[data-mode="battery"] .wire-track:first-of-type, [data-mode="low"] .wire-track:first-of-type {
  stroke-width: 2;
  stroke-dasharray: 3 9;
  stroke: color-mix(in srgb, var(--x-ink) 22%, transparent);
}

.mains { cursor: pointer; }
.plate-edge { fill: color-mix(in srgb, var(--x-ink) 30%, var(--x-surface)); }
.plate { stroke: color-mix(in srgb, var(--x-ink) 22%, transparent); stroke-width: 1.2; }
.plate-shine { fill: none; stroke: #fff; stroke-opacity: .5; stroke-width: 2; stroke-linecap: round; }
.socket-rim { fill: color-mix(in srgb, var(--x-ink) 22%, var(--x-surface)); }
.socket-face { stroke: color-mix(in srgb, var(--x-ink) 12%, transparent); }
.pin { fill: color-mix(in srgb, var(--x-ink) 55%, var(--x-surface)); }
.cut { stroke: #ff5c5c; stroke-width: 3.5; stroke-linecap: round; opacity: 0; }
[data-mode="mains"] .socket-rim, [data-mode="charging"] .socket-rim { fill: color-mix(in srgb, var(--x-tint) 45%, var(--x-surface)); filter: drop-shadow(0 0 5px var(--x-tint)); }
[data-mode="battery"] .cut, [data-mode="low"] .cut { opacity: .9; animation: flicker 2.2s steps(1, end) infinite; }
[data-mode="battery"] .mains, [data-mode="low"] .mains { opacity: .55; }

.pack { cursor: pointer; }
.pack-back { fill: color-mix(in srgb, var(--x-ink) 7%, var(--x-surface)); }
.pack-shell { fill: none; stroke: color-mix(in srgb, var(--x-ink) 34%, transparent); stroke-width: 2.5; }
.pack-cap { stroke: color-mix(in srgb, var(--x-ink) 30%, transparent); }
.pack-shine { fill: #fff; opacity: .35; }
.pack-shine.soft { opacity: .18; }
.gloss { animation: gloss 7s cubic-bezier(.45,0,.2,1) infinite; }
.floor { animation: breathe 5s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
.liquid { transition: transform 1300ms cubic-bezier(.22,.61,.36,1); transform: translateY(${CELL_BOTTOM}px); }
.wave path { fill: var(--x-tint); transition: fill 600ms ease; }
.wave.back path { opacity: .45; }
.wave.front path { opacity: .92; }
.wave.back { animation: wave-b 3.4s linear infinite; }
.wave.front { animation: wave-f 2.4s linear infinite; }
.bub { fill: #fff; opacity: 0; }
[data-mode="charging"] .bub { animation: bubble 2.8s ease-in infinite; }
[data-mode="charging"] .bub:nth-of-type(2) { animation-delay: -.9s; animation-duration: 2.3s; }
[data-mode="charging"] .bub:nth-of-type(3) { animation-delay: -1.8s; animation-duration: 3.3s; }
.bolt { fill: #fff; stroke: color-mix(in srgb, var(--x-tint) 60%, #000); stroke-width: .8; opacity: 0; transition: opacity 400ms ease; }
[data-mode="charging"] .bolt { opacity: .95; animation: bolt 1.6s ease-in-out infinite; }
[data-mode="low"] .pack-shell { stroke: #ff5c5c; animation: alarm 1.2s ease-in-out infinite; }

.pcb { stroke: color-mix(in srgb, #000 25%, transparent); }
.pcb-edge { fill: #145238; }
.soc-edge { fill: #0e1114; }
.soc-shine { fill: #fff; opacity: .12; }
.gpio rect { fill: #e8c46a; }
.soc { fill: #2a2f36; stroke: #9aa3ad; stroke-width: .8; }
.port-usb { fill: #c9ced6; stroke: #7a828c; stroke-width: .6; }
.led-pwr { fill: #ff5c5c; filter: drop-shadow(0 0 2px #ff5c5c); }
.led-act { fill: #3ddc97; filter: drop-shadow(0 0 2px #3ddc97); animation: flicker 1.3s steps(1, end) infinite; }
.pi { animation: none; }
[data-mode="low"] .led-act { animation-duration: .5s; }

/* --- stat tiles --- */
.chips { display: block; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; }
.pills { display: none; flex-wrap: wrap; gap: 6px; }
[data-chips="pills"] .stats { display: none; }
[data-chips="pills"] .pills { display: flex; }
.stat {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 10px 12px 12px;
  border-radius: 18px;
  cursor: pointer;
  background: linear-gradient(180deg, color-mix(in srgb, var(--x-ink) 3%, var(--x-surface)), color-mix(in srgb, var(--x-ink) 7%, var(--x-surface)));
  border: 1px solid color-mix(in srgb, var(--x-ink) 9%, transparent);
  box-shadow: 0 1px 2px color-mix(in srgb, #000 6%, transparent), 0 10px 18px -16px color-mix(in srgb, #000 45%, transparent);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  transition: transform 200ms ease, border-color 200ms ease;
}
.stat:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--x-tint) 40%, transparent); }
.stat-label { font-size: .64rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--x-muted); }
.stat-value { font-size: 1.05rem; font-weight: 720; color: var(--x-ink); font-variant-numeric: tabular-nums; }
.stat-sub { font-size: .72rem; color: var(--x-muted); }
.stat-sub:empty { display: none; }
.bar { position: relative; height: 7px; border-radius: 999px; background: color-mix(in srgb, var(--x-ink) 9%, transparent); overflow: hidden; }
.bar > i {
  position: absolute; inset: 0 auto 0 0;
  border-radius: inherit;
  background: linear-gradient(90deg, color-mix(in srgb, var(--x-tint) 50%, transparent), var(--x-tint));
  transition: width 900ms cubic-bezier(.22,.61,.36,1), left 900ms cubic-bezier(.22,.61,.36,1);
  overflow: hidden;
}
.bar > i::after {
  content: "";
  position: absolute; inset: 0;
  background: linear-gradient(100deg, transparent 30%, rgba(255,255,255,.45) 50%, transparent 70%);
  transform: translateX(-100%);
  animation: shine 3.6s ease-in-out infinite;
}
.window-bar { overflow: visible; }
.window-bar .band { background: color-mix(in srgb, var(--x-tint) 45%, transparent); }
.marker {
  position: absolute; top: 50%;
  width: 13px; height: 13px; margin: -6.5px 0 0 -6.5px;
  border-radius: 50%;
  background: var(--x-tint);
  border: 2px solid var(--x-surface);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--x-tint) 60%, transparent);
  animation: ping 2.4s ease-out infinite;
  transition: left 900ms cubic-bezier(.22,.61,.36,1);
}
.power .stat-value { color: color-mix(in srgb, #ff5c5c 75%, var(--x-ink)); }
.power[data-good="true"] .stat-value { color: var(--x-ink); }

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 999px;
  cursor: pointer;
  font-size: .73rem;
  color: var(--x-muted);
  background: color-mix(in srgb, var(--x-ink) 7%, transparent);
  transition: background 250ms ease, color 250ms ease;
}
.chip:hover { background: color-mix(in srgb, var(--x-ink) 13%, transparent); }
.chip .chip-dot { width: 6px; height: 6px; border-radius: 50%; background: #ff5c5c; }
.chip[data-good="true"] .chip-dot { background: var(--x-tint); }
.chip[data-good="true"] { color: var(--x-ink); }
.chip.window-chip { background: color-mix(in srgb, var(--x-tint) 12%, transparent); color: color-mix(in srgb, var(--x-tint) 70%, var(--x-ink)); }

/* --- sparkline --- */
.spark { position: relative; height: 74px; margin: 0 -16px -16px; }
.spark svg { position: absolute; left: 0; right: 0; bottom: 0; width: 100%; height: ${SPARK_H}px; display: block; }
.spark-area { fill: url(#x-spark); stroke: none; }
.spark-line {
  fill: none;
  stroke: var(--x-tint);
  stroke-width: 2.2;
  stroke-linejoin: round;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
  filter: drop-shadow(0 0 4px color-mix(in srgb, var(--x-tint) 45%, transparent));
}
.spark-line.empty { stroke: color-mix(in srgb, var(--x-ink) 22%, transparent); stroke-width: 1.2; stroke-dasharray: 3 4; filter: none; }
.spark.reveal .spark-line:not(.empty) { stroke-dasharray: 1; stroke-dashoffset: 1; animation: draw 1500ms cubic-bezier(.3,.7,.4,1) forwards; }
.spark.reveal .spark-area { animation: fade-in 1500ms ease-out both; }
.spark-note { position: absolute; top: 2px; left: 16px; font-size: .68rem; color: var(--x-muted); font-variant-numeric: tabular-nums; }
.spark-tip {
  position: absolute; right: 1px;
  width: 8px; height: 8px; margin-bottom: -4px;
  border-radius: 50%;
  background: var(--x-tint);
  animation: ping 1.8s ease-out infinite;
}

/* --- charge switch --- */
.charge-row { display: flex; align-items: center; gap: 10px; }
.charge-label { font-size: .86rem; font-weight: 650; color: var(--x-ink); }
.charge-state { flex: 1; font-size: .76rem; color: var(--x-muted); }
.charge-toggle {
  appearance: none;
  position: relative;
  width: 50px; height: 28px;
  flex: none;
  padding: 0;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--x-ink) 18%, transparent);
  background: color-mix(in srgb, var(--x-ink) 12%, transparent);
  cursor: pointer;
  transition: background 300ms ease, border-color 300ms ease, box-shadow 300ms ease;
}
.charge-toggle .knob {
  position: absolute; top: 3px; left: 3px;
  width: 20px; height: 20px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,.3);
  transition: transform 300ms cubic-bezier(.34,1.56,.64,1);
}
.charge-toggle[aria-checked="true"] {
  background: var(--x-tint);
  border-color: transparent;
  box-shadow: 0 0 14px -2px color-mix(in srgb, var(--x-tint) 70%, transparent);
}
.charge-toggle[aria-checked="true"] .knob { transform: translateX(22px); }
.charge-toggle:focus-visible { outline: 2px solid var(--x-tint); outline-offset: 2px; }

/* --- variants --- */
/* Blocks are switched off with [hidden]; what is left is only a matter of
   sizing, so each variant is a handful of overrides rather than a layout of
   its own. Without the diagram, the ring and the stats share a row. */
[data-variant="compact"] .hero, [data-variant="slim"] .hero { display: block; }
ha-card.x120x[data-variant="compact"] { padding: 14px 16px 16px; }
[data-variant="compact"] .gauge { max-width: 150px; }
[data-variant="compact"] .percent { font-size: 1.9rem; }

ha-card.x120x[data-variant="slim"] {
  display: grid;
  grid-template-columns: 92px 1fr;
  grid-template-areas: "gauge head" "gauge chips" "flow flow";
  align-items: center;
  gap: 6px 14px;
  padding: 12px 16px;
}
[data-variant="slim"] .head { grid-area: head; }
/* The hero's two halves become cells of the slim grid: the dial beside the
   chips, and the diagram -- when show_flow asks for it -- across the whole
   card underneath, instead of shrunk under the dial. */
[data-variant="slim"] .hero { display: contents; }
[data-variant="slim"] .gauge { grid-area: gauge; }
[data-variant="slim"] .flow { grid-area: flow; width: 100%; max-width: 320px; justify-self: center; margin-top: 6px; }
[data-variant="slim"] .chips { grid-area: chips; }
[data-variant="slim"] .charge-row, [data-variant="slim"] .spark { grid-column: 1 / -1; }
[data-variant="slim"] .gauge { max-width: 92px; }
[data-variant="slim"] .percent { font-size: 1.3rem; }
[data-variant="slim"] .percent i { font-size: .7rem; }
[data-variant="slim"] .volts, [data-variant="slim"] .level, [data-variant="slim"] .ticks, [data-variant="slim"] .window { display: none; }

/* A bare dial, for a square tile in a grid. */
ha-card.x120x[data-variant="gauge"] { padding: 14px; }
[data-variant="gauge"] .hero { grid-template-columns: 1fr; }
[data-variant="gauge"] .gauge { max-width: 240px; }

/* --- entrance --- */
/* One pass on first paint, so a dashboard full of cards assembles itself
   instead of appearing all at once. */
.head, .hero, .chips, .charge-row, .spark { animation: rise-in 560ms cubic-bezier(.22,.61,.36,1) both; }
.hero { animation-delay: 60ms; }
.chips { animation-delay: 120ms; }
.charge-row { animation-delay: 180ms; }
.spark { animation-delay: 220ms; }

.empty { padding: 8px 4px; color: var(--x-muted); line-height: 1.5; }
.empty-title { font-size: 1.05rem; font-weight: 600; color: var(--x-ink); margin-bottom: 6px; }

/* --- keyframes --- */
@keyframes rise-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes aurora {
  0%   { background-position: 0% 0%, 100% 100%; }
  100% { background-position: 60% 40%, 40% 60%; }
}
@keyframes edge { 0% { background-position: -60% 0; } 60%, 100% { background-position: 160% 0; } }
@keyframes gloss { 0%, 55% { transform: translateX(0); } 100% { transform: translateX(170px); } }
@keyframes alarm { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
@keyframes ping {
  0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--x-tint) 70%, transparent); }
  70%  { box-shadow: 0 0 0 8px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
@keyframes breathe { 0%, 100% { opacity: .5; transform: scale(.97); } 50% { opacity: 1; transform: scale(1.03); } }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes flow { to { stroke-dashoffset: -16; } }
@keyframes flicker {
  0% { opacity: 1; } 18% { opacity: .15; } 30% { opacity: 1; } 52% { opacity: .3; }
  60% { opacity: 1; } 78% { opacity: .2; } 86% { opacity: 1; }
}
@keyframes wave-b { from { transform: translateX(0); } to { transform: translateX(-26px); } }
@keyframes wave-f { from { transform: translateX(-34px); } to { transform: translateX(0); } }
@keyframes bubble {
  0%   { opacity: 0; transform: translateY(var(--depth, 40px)) scale(.6); }
  20%  { opacity: .6; }
  90%  { opacity: .4; }
  100% { opacity: 0; transform: translateY(4px) scale(1); }
}
@keyframes bolt { 0%, 100% { filter: drop-shadow(0 0 2px #fff); } 50% { filter: drop-shadow(0 0 8px #fff); } }
@keyframes shine { 0%, 35% { transform: translateX(-100%); } 75%, 100% { transform: translateX(100%); } }
@keyframes draw { to { stroke-dashoffset: 0; } }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;

/* ----------------------------------------------------------------- editor */

/**
 * The visual editor: a handful of fields through Home Assistant's own
 * <ha-form>, so variant and blocks are picked from menus instead of YAML.
 */
const EDITOR_LABELS = {
  en: {
    name: "Title",
    device_id: "UPS (empty = the first one found)",
    variant: "Layout",
    hours: "Hours of history",
    show_flow: "Energy diagram",
    show_sparkline: "Level trace",
    show_chips: "Stats",
    show_button: "Charge switch",
  },
  it: {
    name: "Titolo",
    device_id: "UPS (vuoto = la prima trovata)",
    variant: "Aspetto",
    hours: "Ore di storico",
    show_flow: "Schema dell'energia",
    show_sparkline: "Andamento del livello",
    show_chips: "Riquadri di stato",
    show_button: "Interruttore di ricarica",
  },
};

class X120XUpsCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
    else this._render();
  }

  _render() {
    if (!this._hass || !this._config) return;
    const language = String((this._hass.locale && this._hass.locale.language) || "en").slice(0, 2);
    const labels = EDITOR_LABELS[language] || EDITOR_LABELS.en;
    const variant = VARIANTS[this._config.variant || "full"] || VARIANTS.full;
    const data = { variant: "full", hours: DEFAULT_HISTORY_HOURS, ...this._config };
    for (const key of Object.keys(variant)) {
      if (data[`show_${key}`] === undefined) data[`show_${key}`] = variant[key];
    }

    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (schema) => labels[schema.name] || schema.name;
      this._form.addEventListener("value-changed", (ev) => {
        const value = { ...ev.detail.value };
        // A block left at what its variant decides is not written out.
        const defaults = VARIANTS[value.variant || "full"] || VARIANTS.full;
        for (const key of Object.keys(defaults)) {
          if (value[`show_${key}`] === defaults[key]) delete value[`show_${key}`];
        }
        if (Number(value.hours) === DEFAULT_HISTORY_HOURS) delete value.hours;
        if (!value.name) delete value.name;
        if (!value.device_id) delete value.device_id;
        this._config = { type: "custom:x120x-ups-card", ...value };
        const event = new Event("config-changed", { bubbles: true, composed: true });
        event.detail = { config: this._config };
        this.dispatchEvent(event);
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = [
      { name: "name", selector: { text: {} } },
      { name: "device_id", selector: { device: { integration: "x120x" } } },
      {
        name: "variant",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "full", label: "Full" },
              { value: "compact", label: "Compact" },
              { value: "slim", label: "Slim" },
              { value: "gauge", label: "Gauge" },
            ],
          },
        },
      },
      { name: "hours", selector: { number: { min: 1, max: 168, mode: "box" } } },
      { name: "show_flow", selector: { boolean: {} } },
      { name: "show_sparkline", selector: { boolean: {} } },
      { name: "show_chips", selector: { boolean: {} } },
      { name: "show_button", selector: { boolean: {} } },
    ];
    this._form.data = data;
  }
}

if (!customElements.get("x120x-ups-card")) {
  customElements.define("x120x-ups-card", X120XUpsCard);
}
if (!customElements.get("x120x-ups-card-editor")) {
  customElements.define("x120x-ups-card-editor", X120XUpsCardEditor);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === "x120x-ups-card")) {
  window.customCards.push({
    type: "x120x-ups-card",
    name: "X120X UPS",
    description:
      "Animated status panel for the Suptronics X120X UPS HAT: charge ring, energy diagram, charge window and charge switch.",
    preview: true,
  });
}
