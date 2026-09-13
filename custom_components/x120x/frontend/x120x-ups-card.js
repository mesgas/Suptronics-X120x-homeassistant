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
 *   show_flow / show_sparkline / show_chips / show_button:
 *       force a single block on or off, whatever the variant decided
 *   entities: optional explicit overrides, keyed by the roles below
 */

const CARD_VERSION = "1.3.2";

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

const STATUS_THEME = {
  online: { tint: "#3ddc97", label: "On line" },
  charging: { tint: "#4fd1c5", label: "Charging" },
  on_battery: { tint: "#f6c445", label: "On battery" },
  low_battery: { tint: "#ff5c5c", label: "Battery low" },
  unknown: { tint: "#8a94a6", label: "Unknown" },
};

const GAUGE_RADIUS = 78;
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS;
const WINDOW_RADIUS = 92;
const WINDOW_CIRCUMFERENCE = 2 * Math.PI * WINDOW_RADIUS;
const HISTORY_POINTS = 48;

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

// Geometry of the battery cell drawing, used to size the liquid.
const CELL_TOP = 21.5;
const CELL_HEIGHT = 57;

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
  }

  static getStubConfig() {
    return { type: "custom:x120x-ups-card" };
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
    return parts.flow ? 5 : parts.chips ? 3 : 2;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) {
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
      const hours = Number(this._config.hours) || DEFAULT_HISTORY_HOURS;
      const end = new Date();
      const start = new Date(end.getTime() - hours * 3600 * 1000);
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

    if (!this._entities || !this._entities.capacity) {
      card.innerHTML = `<div class="empty">
        <div class="empty-title">X120X UPS</div>
        <p>No X120X device found yet. If the integration is set up, reload the
        dashboard; otherwise name the entities explicitly in the card config.</p>
      </div>`;
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

    // --- layout ----------------------------------------------------------
    // The blocks are hidden rather than removed, so _update can stay ignorant
    // of the variant and keep writing to the same nodes.
    this._shown = this._parts();
    card.dataset.variant = this._config.variant;
    // toggleAttribute, not `.hidden`: `hidden` is defined on HTMLElement and
    // not on SVGElement, so assigning it to the sparkline <svg> would silently
    // create an inert JS property and leave the element on screen as an empty
    // 30px band in every compact variant.
    this._el.flow.toggleAttribute("hidden", !this._shown.flow);
    this._el.sparkSvg.toggleAttribute("hidden", !this._shown.sparkline);
    this._el.chips.toggleAttribute("hidden", !this._shown.chips);

    // Anything carrying a role opens the matching more-info dialog.
    for (const node of card.querySelectorAll("[data-role]")) {
      node.addEventListener("click", () => {
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

    this._built = true;
  }

  /* ---------------------------------------------------------------- update */

  _update() {
    if (!this._built || !this._el) return;

    const capacity = this._number("capacity", 0);
    const voltage = this._number("voltage");
    const acOn = this._isOn("ac");
    const charging = this._isOn("charging");
    const low = this._isOn("low");
    const statusState = this._state("status");
    const statusKey = statusState ? statusState.state : "unknown";
    const theme = STATUS_THEME[statusKey] || STATUS_THEME.unknown;

    this.style.setProperty("--x-tint", theme.tint);

    // --- headline ---------------------------------------------------------
    this._el.title.textContent =
      this._config.name || this._deviceName() || "X120X UPS";
    this._el.statusText.textContent = statusState
      ? this._displayState(statusState)
      : theme.label;

    // --- gauge ------------------------------------------------------------
    const clamped = Math.max(0, Math.min(100, capacity));
    this._el.gaugeValue.setAttribute(
      "stroke-dashoffset",
      GAUGE_CIRCUMFERENCE * (1 - clamped / 100)
    );
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
    this._renderChargeWindow();

    // --- battery cell -----------------------------------------------------
    // The liquid grows upwards, so its top edge moves as the fill changes.
    const fill = (CELL_HEIGHT * clamped) / 100;
    this._el.cellFill.setAttribute("y", CELL_TOP + CELL_HEIGHT - fill);
    this._el.cellFill.setAttribute("height", Math.max(fill, 0.5));

    this.classList.toggle("is-charging", charging);
    this.classList.toggle("is-alert", low || statusKey === "low_battery");

    // --- flow lane --------------------------------------------------------
    // Energy always travels towards the Pi; only the mains leg goes quiet.
    this._el.flow.dataset.direction = acOn ? "in" : "out";
    this._el.mains.classList.toggle("off", !acOn);

    // --- chips ------------------------------------------------------------
    this._setChip("chipAc", acOn ? "Mains OK" : "Mains lost", acOn);
    this._setChip(
      "chipCharge",
      charging ? "Charging" : acOn ? "Not charging" : "Discharging",
      charging || acOn
    );
    this._setChip("chipLow", low ? "Battery low" : "Battery healthy", !low);

    const chargeSwitch = this._state("charge_switch");
    if (chargeSwitch && this._shown.button) {
      const on = chargeSwitch.state === "on";
      this._el.chargeToggle.hidden = false;
      this._el.chargeToggle.dataset.on = String(on);
      this._el.chargeToggle.textContent = on
        ? "Charging enabled"
        : "Charging paused";
    } else {
      this._el.chargeToggle.hidden = true;
    }

    if (this._shown.sparkline) {
      this._pushHistory(clamped);
      this._drawSparkline();
    }
  }

  /**
   * Draw the band the integration keeps the pack inside, as an outer arc on
   * the gauge plus a chip. Hidden when charging is not limited.
   */
  _renderChargeWindow() {
    const arc = this._el.gaugeWindow;
    const chip = this._el.chipWindow;
    const attrs = (this._state("charge_switch") || {}).attributes || {};
    const min = Number(attrs.charge_limit_min);
    const max = Number(attrs.charge_limit_max);

    const limited =
      Number.isFinite(min) && Number.isFinite(max) && max < 100 && max > min;

    if (!limited) {
      if (arc) arc.style.opacity = "0";
      if (chip) chip.hidden = true;
      return;
    }

    const length = (WINDOW_CIRCUMFERENCE * (max - min)) / 100;
    arc.setAttribute(
      "stroke-dasharray",
      `${length} ${WINDOW_CIRCUMFERENCE - length}`
    );
    arc.setAttribute("stroke-dashoffset", -(WINDOW_CIRCUMFERENCE * min) / 100);
    arc.style.opacity = "1";

    chip.hidden = false;
    chip.querySelector(".chip-text").textContent = `Hold ${Math.round(
      min
    )}-${Math.round(max)}%`;
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
    const line = this._el.spark;
    const area = this._el.sparkArea;
    if (!line) return;

    // The recorder's trace when there is one, otherwise whatever has been seen
    // since the card was opened.
    const series =
      this._recorded && this._recorded.length >= 2 ? this._recorded : this._history;

    if (series.length < 2) {
      // A faint dashed baseline: it holds the space without pretending to be
      // a reading, until enough samples have come in to draw a real trace.
      line.setAttribute("points", "0,11 100,11");
      line.classList.add("empty");
      if (area) area.setAttribute("d", "");
      return;
    }
    line.classList.remove("empty");

    // Scale to the observed range, so small drifts stay readable.
    const min = Math.min(...series);
    const max = Math.max(...series);
    const span = Math.max(max - min, 1);
    const stepX = 100 / (series.length - 1);
    const coords = series.map((value, index) => {
      const x = index * stepX;
      const y = 19 - ((value - min) / span) * 16;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });

    line.setAttribute("points", coords.join(" "));
    if (area) {
      area.setAttribute("d", `M0,22 L${coords.join(" L")} L100,22 Z`);
    }
  }
}

/* ---------------------------------------------------------------- markup */

const TEMPLATE = `
<div class="glow"></div>
<div class="head">
  <div class="title" data-ref="title">X120X UPS</div>
  <div class="status" data-ref="status" data-role="status">
    <span class="dot"></span>
    <span data-ref="statusText">--</span>
  </div>
</div>

<div class="body">
  <div class="gauge" data-role="capacity">
    <svg viewBox="0 0 200 200" aria-hidden="true">
      <defs>
        <linearGradient id="x-arc" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="var(--x-tint)" stop-opacity="0.3"/>
          <stop offset="100%" stop-color="var(--x-tint)"/>
        </linearGradient>
        <linearGradient id="x-liquid" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--x-tint)"/>
          <stop offset="100%" stop-color="var(--x-tint)" stop-opacity="0.6"/>
        </linearGradient>
        <linearGradient id="x-spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--x-tint)" stop-opacity="0.4"/>
          <stop offset="100%" stop-color="var(--x-tint)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <circle class="window" data-ref="gaugeWindow" cx="100" cy="100" r="92"
              transform="rotate(-90 100 100)"/>
      <circle class="track" cx="100" cy="100" r="78"/>
      <circle class="value" data-ref="gaugeValue" cx="100" cy="100" r="78"
              transform="rotate(-90 100 100)"/>
      <circle class="sweep" cx="100" cy="100" r="78"/>
    </svg>
    <div class="readout">
      <div class="percent"><span data-ref="percent">--</span><i>%</i></div>
      <div class="volts" data-ref="voltage" data-role="voltage">--</div>
      <div class="level" data-ref="levelText"></div>
    </div>
  </div>

  <div class="side">
    <div class="flow" data-ref="flow" data-direction="in">
      <div class="node mains" data-ref="mains" data-role="ac">
        <svg class="glyph" viewBox="0 0 24 24"><path d="M7 2v6h2V2H7zm8 0v6h2V2h-2zM6 9v4a6 6 0 0 0 5 5.9V22h2v-3.1A6 6 0 0 0 18 13V9H6z"/></svg>
        <span>Mains</span>
      </div>
      <div class="lane lane-in"><span class="pulse"></span></div>
      <div class="node ups" data-role="charging">
        <svg class="cell" viewBox="0 0 60 100" aria-hidden="true">
          <rect class="cap" x="24" y="12" width="12" height="6" rx="2"/>
          <rect class="shell" x="14" y="18" width="32" height="64" rx="7"/>
          <clipPath id="x-cell-clip">
            <rect x="17.5" y="21.5" width="25" height="57" rx="5"/>
          </clipPath>
          <g clip-path="url(#x-cell-clip)">
            <rect class="liquid" data-ref="cellFill" x="17.5" y="78" width="25" height="0"/>
            <g class="bubbles">
              <circle cx="24" cy="72" r="2"/>
              <circle cx="34" cy="76" r="1.5"/>
              <circle cx="29" cy="80" r="2.4"/>
            </g>
          </g>
          <path class="bolt" d="M33 32 L25 54 L31 54 L28 70 L38 46 L32 46 Z"/>
        </svg>
        <span>UPS</span>
      </div>
      <div class="lane lane-out"><span class="pulse"></span></div>
      <div class="node pi">
        <svg class="glyph" viewBox="0 0 24 24"><path d="M8 2v2H6v2H4v12h2v2h2v-2h8v2h2v-2h2V6h-2V4h-2V2h-2v2H10V2H8zm1 6h6v8H9V8z"/></svg>
        <span>Pi</span>
      </div>
    </div>

    <svg class="spark" data-ref="sparkSvg" viewBox="0 0 100 22" preserveAspectRatio="none" aria-hidden="true">
      <path class="spark-area" data-ref="sparkArea" d=""/>
      <polyline data-ref="spark" points=""/>
    </svg>

    <div class="chips" data-ref="chips">
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

    <button class="charge-toggle" data-ref="chargeToggle" hidden>--</button>
  </div>
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
  /* Lets the layout below react to the width of the card itself. A media
     query inside a shadow root measures the viewport, so a narrow card on a
     wide screen would wrongly keep the two-column layout. */
  container-type: inline-size;
}

ha-card.x120x {
  position: relative;
  display: block;
  overflow: hidden;
  padding: 18px;
  background:
    radial-gradient(130% 100% at 100% 0%, color-mix(in srgb, var(--x-tint) 13%, transparent), transparent 58%),
    var(--x-surface);
}

.glow {
  position: absolute;
  inset: -45% -20% auto -20%;
  height: 75%;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--x-tint) 32%, transparent), transparent);
  filter: blur(30px);
  opacity: .5;
  pointer-events: none;
  transition: opacity 600ms ease;
}
:host(.is-alert) .glow { animation: breathe 2.2s ease-in-out infinite; }

.head {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.title {
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--x-ink);
}
.status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 11px;
  border-radius: 999px;
  cursor: pointer;
  font-size: .76rem;
  font-weight: 600;
  white-space: nowrap;
  color: var(--x-tint);
  background: color-mix(in srgb, var(--x-tint) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--x-tint) 32%, transparent);
}
.status .dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--x-tint);
  animation: ping 2.4s ease-out infinite;
}

.body {
  position: relative;
  display: grid;
  grid-template-columns: 190px 1fr;
  gap: 18px;
  align-items: center;
}
@container (max-width: 470px) {
  .body { grid-template-columns: 1fr; gap: 10px; }
}

/* --- gauge --- */
.gauge {
  position: relative;
  width: 100%;
  max-width: 190px;
  aspect-ratio: 1;
  margin: 0 auto;
  cursor: pointer;
}
.gauge > svg { width: 100%; height: 100%; display: block; overflow: visible; }
.gauge .track {
  fill: none;
  stroke: color-mix(in srgb, var(--x-ink) 9%, transparent);
  stroke-width: 13;
}
.gauge .value {
  fill: none;
  stroke: url(#x-arc);
  stroke-width: 13;
  stroke-linecap: round;
  filter: drop-shadow(0 0 8px color-mix(in srgb, var(--x-tint) 55%, transparent));
  transition: stroke-dashoffset 900ms cubic-bezier(.22,.61,.36,1);
}
.gauge .window {
  fill: none;
  stroke: color-mix(in srgb, var(--x-tint) 55%, transparent);
  stroke-width: 3;
  stroke-linecap: round;
  opacity: 0;
  transition: opacity 400ms ease, stroke-dashoffset 600ms ease;
}
.gauge .sweep {
  fill: none;
  stroke: color-mix(in srgb, var(--x-tint) 65%, transparent);
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-dasharray: 16 500;
  transform-origin: 100px 100px;
  opacity: 0;
}
:host(.is-charging) .gauge .sweep { opacity: 1; animation: orbit 3.4s linear infinite; }

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
  font-size: 2.4rem;
  font-weight: 700;
  line-height: 1;
  color: var(--x-ink);
  font-variant-numeric: tabular-nums;
  letter-spacing: -.02em;
}
.percent i { font-size: .95rem; font-style: normal; color: var(--x-muted); margin-left: 3px; }
.volts {
  margin-top: 6px;
  font-size: .84rem;
  color: var(--x-muted);
  font-variant-numeric: tabular-nums;
  pointer-events: auto;
  cursor: pointer;
}
.level {
  margin-top: 2px;
  font-size: .64rem;
  letter-spacing: .12em;
  text-transform: uppercase;
  font-weight: 600;
  color: color-mix(in srgb, var(--x-tint) 90%, var(--x-muted));
}

/* --- flow --- */
.side {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  max-width: 460px;
}
.flow {
  display: grid;
  grid-template-columns: auto minmax(14px, 1fr) auto minmax(14px, 1fr) auto;
  align-items: center;
  gap: 8px;
}
.node {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  font-size: .6rem;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--x-muted);
}
.node .glyph {
  width: 26px; height: 26px;
  fill: var(--x-ink);
  opacity: .8;
  transition: opacity 300ms ease;
}
.node.mains { cursor: pointer; }
.node.mains.off .glyph { opacity: .25; }
.node.mains.off { color: color-mix(in srgb, #ff5c5c 75%, var(--x-muted)); }
.node.ups { cursor: pointer; color: var(--x-tint); }

/* the battery cell doubles as the UPS glyph */
.cell { width: 30px; height: 50px; display: block; }
.cell .shell {
  fill: none;
  stroke: color-mix(in srgb, var(--x-ink) 30%, transparent);
  stroke-width: 3;
}
.cell .cap { fill: color-mix(in srgb, var(--x-ink) 30%, transparent); }
.cell .liquid {
  fill: url(#x-liquid);
  transition: y 900ms cubic-bezier(.22,.61,.36,1), height 900ms cubic-bezier(.22,.61,.36,1);
}
.cell .bubbles circle { fill: #fff; opacity: 0; }
:host(.is-charging) .cell .bubbles circle { animation: rise 2.6s ease-in infinite; }
:host(.is-charging) .cell .bubbles circle:nth-child(2) { animation-delay: .8s; }
:host(.is-charging) .cell .bubbles circle:nth-child(3) { animation-delay: 1.6s; }
.cell .bolt {
  fill: #fff;
  opacity: 0;
  transition: opacity 400ms ease;
}
:host(.is-charging) .cell .bolt { opacity: .9; }

.lane {
  position: relative;
  height: 3px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--x-ink) 12%, transparent);
  overflow: hidden;
}
.lane .pulse {
  position: absolute;
  top: 0; bottom: 0;
  width: 45%;
  border-radius: 2px;
  background: linear-gradient(90deg, transparent, var(--x-tint), transparent);
  animation: slide 1.9s linear infinite;
}
.flow[data-direction="out"] .lane-in .pulse { opacity: 0; animation: none; }

/* --- sparkline --- */
.spark { width: 100%; height: 30px; display: block; }
.spark polyline {
  fill: none;
  stroke: var(--x-tint);
  stroke-width: 1.8;
  stroke-linejoin: round;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
  filter: drop-shadow(0 0 4px color-mix(in srgb, var(--x-tint) 45%, transparent));
}
.spark .spark-area { fill: url(#x-spark); stroke: none; }
.spark polyline.empty {
  stroke: color-mix(in srgb, var(--x-ink) 22%, transparent);
  stroke-width: 1.2;
  stroke-dasharray: 3 4;
  filter: none;
}

/* --- chips --- */
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
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
.chip[hidden] { display: none; }
.chip:hover { background: color-mix(in srgb, var(--x-ink) 13%, transparent); }
.chip .chip-dot { width: 6px; height: 6px; border-radius: 50%; background: #ff5c5c; }
.chip[data-good="true"] .chip-dot { background: var(--x-tint); }
.chip[data-good="true"] { color: var(--x-ink); }
.chip.window-chip {
  background: color-mix(in srgb, var(--x-tint) 12%, transparent);
  color: var(--x-tint);
}

.charge-toggle {
  appearance: none;
  border: 1px solid color-mix(in srgb, var(--x-ink) 16%, transparent);
  background: transparent;
  color: var(--x-muted);
  border-radius: 10px;
  padding: 8px 12px;
  font: inherit;
  font-size: .78rem;
  cursor: pointer;
  transition: color 250ms ease, border-color 250ms ease, background 250ms ease, transform 150ms ease;
}
.charge-toggle[data-on="true"] {
  color: var(--x-tint);
  border-color: color-mix(in srgb, var(--x-tint) 45%, transparent);
  background: color-mix(in srgb, var(--x-tint) 10%, transparent);
}
.charge-toggle:hover { transform: translateY(-1px); }

/* --- variants --- */
/* Blocks are switched off with [hidden]; what is left is only a matter of
   sizing, so each variant is a handful of overrides rather than a layout of
   its own. */
[hidden] { display: none !important; }

ha-card.x120x[data-variant="compact"] { padding: 14px 16px; }
[data-variant="compact"] .body { grid-template-columns: 130px 1fr; gap: 14px; }
[data-variant="compact"] .gauge { max-width: 130px; }
[data-variant="compact"] .percent { font-size: 1.8rem; }
[data-variant="compact"] .volts { margin-top: 4px; font-size: .76rem; }
[data-variant="compact"] .level { display: none; }

ha-card.x120x[data-variant="slim"] { padding: 12px 16px; }
[data-variant="slim"] .head { margin-bottom: 4px; }
[data-variant="slim"] .body { grid-template-columns: 84px 1fr; gap: 14px; }
[data-variant="slim"] .gauge { max-width: 84px; }
[data-variant="slim"] .gauge .track,
[data-variant="slim"] .gauge .value { stroke-width: 16; }
[data-variant="slim"] .percent { font-size: 1.25rem; }
[data-variant="slim"] .percent i { font-size: .7rem; }
[data-variant="slim"] .volts,
[data-variant="slim"] .level { display: none; }
[data-variant="slim"] .chips { gap: 5px; }
[data-variant="slim"] .gauge .window { display: none; }
/* slim + show_flow: the diagram has to give up some size to fit beside a
   84px dial without the lanes collapsing to nothing. */
[data-variant="slim"] .flow { gap: 6px; grid-template-columns: auto minmax(10px, 1fr) auto minmax(10px, 1fr) auto; }
[data-variant="slim"] .node { gap: 2px; font-size: .52rem; letter-spacing: .05em; }
[data-variant="slim"] .node .glyph { width: 19px; height: 19px; }
[data-variant="slim"] .cell { width: 21px; height: 35px; }

/* --- entrance --- */
/* One pass on first paint, so a dashboard full of cards assembles itself
   instead of appearing all at once. */
.head, .body { animation: rise-in 520ms cubic-bezier(.22,.61,.36,1) both; }
.body { animation-delay: 60ms; }

@keyframes rise-in {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: none; }
}

/* A bare dial, for a square tile in a grid. */
ha-card.x120x[data-variant="gauge"] { padding: 16px; }
[data-variant="gauge"] .body { grid-template-columns: 1fr; }
[data-variant="gauge"] .side { display: none; }
[data-variant="gauge"] .gauge { max-width: 220px; }

.empty { padding: 8px 4px; color: var(--x-muted); }
.empty-title { font-size: 1.05rem; font-weight: 600; color: var(--x-ink); margin-bottom: 6px; }

/* --- keyframes --- */
@keyframes ping {
  0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--x-tint) 70%, transparent); }
  70%  { box-shadow: 0 0 0 7px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
@keyframes slide {
  from { transform: translateX(-120%); }
  to   { transform: translateX(260%); }
}
@keyframes orbit {
  from { transform: rotate(-90deg); }
  to   { transform: rotate(270deg); }
}
@keyframes rise {
  0%   { opacity: 0; transform: translateY(0) scale(.6); }
  25%  { opacity: .5; }
  100% { opacity: 0; transform: translateY(-46px) scale(1); }
}
@keyframes breathe {
  0%, 100% { opacity: .3; }
  50%      { opacity: .85; }
}

@media (prefers-reduced-motion: reduce) {
  .glow, .status .dot, .lane .pulse, .cell .bubbles circle, .gauge .sweep,
  .head, .body {
    animation: none !important;
  }
  .gauge .value, .cell .liquid { transition: none; }
}
`;

if (!customElements.get("x120x-ups-card")) {
  customElements.define("x120x-ups-card", X120XUpsCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === "x120x-ups-card")) {
  window.customCards.push({
    type: "x120x-ups-card",
    name: "X120X UPS",
    description:
      "Animated status panel for the Suptronics X120X UPS HAT: charge gauge, mains flow and charge control.",
    preview: true,
  });
}
