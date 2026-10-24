/*
 * Amber Forecast Card  v1.0.0
 * One card that mirrors the Amber app: live price, a General / Solar
 * toggle, and the 30-minute forecast strip (tap a block for 5-minute intervals).
 * Future prices come from the Amber Express `detailedForecast` attribute; past
 * prices come from Home Assistant's recorder history.
 *
 * Example:
 *   type: custom:amber-forecast-card
 *   general_entity: sensor.amber_express_5ehome_general_price
 *   feed_in_entity: sensor.amber_express_5ehome_feed_in_price
 *
 * Options:
 *   general_entity    Amber Express general price sensor
 *   feed_in_entity    Amber Express feed-in price sensor
 *   invert_feed_in    Flip the sign of feed-in prices. Default true.
 *   hours             Hours ahead to show. Default 24.
 *   past_hours        Hours of history to show. Default 24. 0 disables history.
 *   renewables_entity Optional sensor (% renewables) used to fill in past intervals.
 *   decimals          Decimal places for cents. Default 0 (matches the app).
 *   show_live         Show the live price circle. Default true.
 *   expand_current    Expand the current 30-min block on load. Default false.
 *   show_renewables   Show the renewables % row. Default true.
 *
 * Older single-sensor config (entity + mode: feedin) still works.
 */


const CARD_VERSION = "1.0.0";
console.info("%c AMBER-FORECAST-CARD %c v" + CARD_VERSION + " ", "color:#0a1230;background:#00e8a0;font-weight:700", "color:#00e8a0;background:#0a1230");

const BUCKET_MS = 30 * 60 * 1000;
const SLOT_MS = 5 * 60 * 1000;
const REFETCH_MS = 60 * 1000;

const DESCRIPTORS = {
  negative: { rank: 0, color: "#38bdf8", label: "Negative" },
  extremelyLow: { rank: 1, color: "#00f2a6", label: "Extremely low" },
  veryLow: { rank: 2, color: "#00e8a0", label: "Very low" },
  low: { rank: 3, color: "#7bd36b", label: "Low" },
  neutral: { rank: 4, color: "#f5c542", label: "Neutral" },
  high: { rank: 5, color: "#f58b3c", label: "High" },
  spike: { rank: 6, color: "#e5484d", label: "Spike" },
};
const UNKNOWN_COLOR = "#8a94a6";
const SUN_COLOR = "#ffc107";

const BOLT_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13.5 2 5 13.5h5.5L9.5 22 19 9.5h-5.7z"/></svg>';
const SUN_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2" fill="currentColor"/>' +
  '<g stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
  '<path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/></g></svg>';

class AmberForecastCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._channels = [];
    this._active = undefined;
    this._renderedCh = undefined;
  }

  static getStubConfig(hass) {
    const find = (suffix) => Object.keys(hass.states).find((e) => e.startsWith("sensor.") && e.endsWith(suffix));
    return {
      general_entity: find("general_price") || "sensor.amber_express_home_general_price",
      feed_in_entity: find("feed_in_price") || "sensor.amber_express_home_feed_in_price",
    };
  }

  setConfig(config) {
    const c = { ...config };
    // Back-compat with the single-sensor config.
    if (c.entity && !c.general_entity && !c.feed_in_entity) {
      if (c.mode === "feedin") {
        c.feed_in_entity = c.entity;
        if (c.invert !== undefined) c.invert_feed_in = c.invert;
      } else {
        c.general_entity = c.entity;
      }
    }
    if (!c.general_entity && !c.feed_in_entity) {
      throw new Error("Please define general_entity and/or feed_in_entity");
    }
    this._config = {
      hours: 24,
      past_hours: 24,
      decimals: 0,
      expand_current: false,
      show_renewables: true,
      show_live: true,
      invert_feed_in: true,
      ...c,
    };

    const mk = (id, label, entity, feedin, invert) => ({
      id,
      label,
      entity,
      feedin,
      invert,
      lastStateObj: undefined,
      expandedKey: undefined,
      autoExpandDone: false,
      history: null,
      historyError: null,
      historyDone: false,
      fetching: false,
      lastFetch: 0,
      pendingScroll: true,
    });
    this._channels = [];
    if (c.general_entity) this._channels.push(mk("general", "General Usage", c.general_entity, false, false));
    if (c.feed_in_entity)
      this._channels.push(mk("feedin", "Solar Feed-in", c.feed_in_entity, true, !!this._config.invert_feed_in));
    this._active = this._channels[0].id;
    this._renderedCh = undefined;
    if (this._hass) this.hass = this._hass;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    let changed = false;
    for (const ch of this._channels) {
      const stateObj = hass.states[ch.entity];
      if (stateObj !== ch.lastStateObj) {
        ch.lastStateObj = stateObj;
        changed = true;
        if (stateObj && Date.now() - ch.lastFetch > REFETCH_MS) this._fetchHistory(ch);
      }
    }
    if (changed) this._render();
  }

  getCardSize() {
    return 8;
  }

  // ---------- history ----------

  async _fetchHistory(ch) {
    const cfg = this._config;
    if (ch.fetching) return;
    if (!cfg.past_hours) {
      ch.historyDone = true;
      return;
    }
    ch.fetching = true;
    ch.lastFetch = Date.now();
    try {
      const end = new Date();
      const start = new Date(end.getTime() - (Number(cfg.past_hours) + 1) * 3600000);
      const ids = [ch.entity];
      if (cfg.renewables_entity) ids.push(cfg.renewables_entity);
      const res = await this._hass.callWS({
        type: "history/history_during_period",
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        entity_ids: ids,
        include_start_time_state: true,
        significant_changes_only: false,
        minimal_response: true,
        no_attributes: true,
      });
      ch.history = {
        price: this._parseHistory(res[ch.entity]),
        ren: cfg.renewables_entity ? this._parseHistory(res[cfg.renewables_entity]) : [],
      };
      ch.historyError = null;
    } catch (err) {
      ch.historyError = (err && err.message) || String(err);
    } finally {
      ch.fetching = false;
      ch.historyDone = true;
      this._render();
    }
  }

  _parseHistory(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const e of list) {
      const raw = e.lc !== undefined ? e.lc : e.lu !== undefined ? e.lu : e.last_changed || e.last_updated;
      const t = typeof raw === "number" ? raw * 1000 : Date.parse(raw);
      const v = parseFloat(e.s !== undefined ? e.s : e.state);
      if (isFinite(t) && isFinite(v)) out.push({ t, v });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  // Forward-fill onto a 5-minute grid. The last change inside a slot wins, which is
  // the confirmed price (Amber Express holds the old price until then).
  _fill(records, slots) {
    const out = new Map();
    let i = 0;
    let cur = null;
    for (const t of slots) {
      while (i < records.length && Math.floor(records[i].t / SLOT_MS) * SLOT_MS <= t) {
        cur = records[i].v;
        i++;
      }
      if (cur !== null) out.set(t, cur);
    }
    return out;
  }

  _pastIntervals(ch, future) {
    if (!ch.history || !future.length) return [];
    const sign = ch.invert ? -1 : 1;
    const curSlot = Math.floor(future[0].start / SLOT_MS) * SLOT_MS;
    const first = curSlot - Number(this._config.past_hours) * 3600000;
    const slots = [];
    for (let t = first; t < curSlot; t += SLOT_MS) slots.push(t);

    const prices = this._fill(ch.history.price, slots);
    const rens = this._fill(ch.history.ren, slots);
    const ranges = this._descriptorRanges(future);

    const out = [];
    for (const t of slots) {
      if (!prices.has(t)) continue;
      const price = prices.get(t) * sign;
      out.push({
        start: t,
        end: t + SLOT_MS,
        price,
        renewables: rens.has(t) ? rens.get(t) : null,
        descriptor: this._inferDescriptor(price, ranges),
        estimate: false,
        past: true,
      });
    }
    return out;
  }

  // Past descriptors aren't recorded, so estimate them from the price range each
  // descriptor covers in the current forecast.
  _descriptorRanges(intervals) {
    const ranges = {};
    for (const iv of intervals) {
      if (!iv.descriptor) continue;
      const r = ranges[iv.descriptor] || (ranges[iv.descriptor] = { min: Infinity, max: -Infinity });
      r.min = Math.min(r.min, iv.price);
      r.max = Math.max(r.max, iv.price);
    }
    return ranges;
  }

  _inferDescriptor(price, ranges) {
    let best = null;
    let bestDist = Infinity;
    let bestMid = Infinity;
    for (const [d, r] of Object.entries(ranges)) {
      const dist = price < r.min ? r.min - price : price > r.max ? price - r.max : 0;
      const mid = Math.abs(price - (r.min + r.max) / 2);
      if (dist < bestDist || (dist === bestDist && mid < bestMid)) {
        best = d;
        bestDist = dist;
        bestMid = mid;
      }
    }
    return best;
  }

  // ---------- forecast ----------

  _intervals(ch, stateObj) {
    const a = stateObj.attributes || {};
    const sign = ch.invert ? -1 : 1;
    let list = [];

    if (Array.isArray(a.detailedForecast) && a.detailedForecast.length) {
      list = a.detailedForecast.map((i) => {
        const start = Date.parse(i.start_time);
        const mins = Number(i.duration) || 5;
        return {
          start,
          end: start + mins * 60000,
          price: i.per_kwh * sign,
          renewables: typeof i.renewables === "number" ? i.renewables : null,
          descriptor: i.descriptor || null,
          estimate: !!i.estimate,
          past: false,
        };
      });
    } else if (Array.isArray(a.forecast) && a.forecast.length) {
      list = a.forecast.map((p, idx, arr) => {
        const start = Date.parse(p.time);
        const next = arr[idx + 1] ? Date.parse(arr[idx + 1].time) : start + SLOT_MS;
        return {
          start,
          end: next,
          price: p.value * sign,
          renewables: null,
          descriptor: null,
          estimate: false,
          past: false,
        };
      });
    }

    list = list.filter((i) => !isNaN(i.start) && typeof i.price === "number");
    list.sort((x, y) => x.start - y.start);
    if (list.length) {
      const limit = list[0].start + this._config.hours * 3600000;
      list = list.filter((i) => i.start < limit);
    }
    return list;
  }

  _group(intervals) {
    const groups = new Map();
    for (const iv of intervals) {
      const key = Math.floor(iv.start / BUCKET_MS) * BUCKET_MS;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(iv);
    }
    return [...groups.entries()].map(([key, ivs]) => this._summarise(key, ivs));
  }

  _summarise(key, ivs) {
    let wSum = 0;
    let pSum = 0;
    let rSum = 0;
    let rW = 0;
    const counts = {};
    for (const iv of ivs) {
      const w = Math.max(iv.end - iv.start, 1);
      wSum += w;
      pSum += iv.price * w;
      if (iv.renewables !== null) {
        rSum += iv.renewables * w;
        rW += w;
      }
      if (iv.descriptor) counts[iv.descriptor] = (counts[iv.descriptor] || 0) + w;
    }
    let descriptor = null;
    let best = -1;
    for (const [d, w] of Object.entries(counts)) {
      const rank = (DESCRIPTORS[d] || { rank: 0 }).rank;
      const bestRank = descriptor ? (DESCRIPTORS[descriptor] || { rank: 0 }).rank : -1;
      if (w > best || (w === best && rank > bestRank)) {
        best = w;
        descriptor = d;
      }
    }
    return {
      key,
      intervals: ivs,
      price: pSum / wSum,
      renewables: rW ? rSum / rW : null,
      descriptor,
      past: ivs.every((iv) => iv.past),
    };
  }

  // ---------- formatting ----------

  _time(ms) {
    const tz = this._hass && this._hass.config && this._hass.config.time_zone;
    const opts = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
    if (tz) opts.timeZone = tz;
    return new Intl.DateTimeFormat("en-GB", opts).format(new Date(ms));
  }

  _centsNum(dollars) {
    const d = Number(this._config.decimals) || 0;
    const s = (dollars * 100).toFixed(d);
    return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
  }

  _cents(dollars) {
    return this._centsNum(dollars) + "\u00A2";
  }

  _dot(descriptor, feedin) {
    if (feedin) return `<span class="dot sun" style="background:${SUN_COLOR}"></span>`;
    const d = DESCRIPTORS[descriptor] || {};
    return `<span class="dot" style="background:${d.color || UNKNOWN_COLOR}" title="${d.label || ""}"></span>`;
  }

  _cell(label, item, extraClass, feedin) {
    const show = this._config.show_renewables;
    const ren = !show
      ? ""
      : item.renewables !== null
      ? `<div class="ren">${Math.round(item.renewables)}%</div>`
      : `<div class="ren">&nbsp;</div>`;
    return `
      <div class="cell ${extraClass || ""}">
        <div class="time">${label}</div>
        ${this._dot(item.descriptor, feedin)}
        <div class="price">${this._cents(item.price)}</div>
        ${ren}
      </div>`;
  }

  // ---------- render parts ----------

  _hero(ch, live) {
    const base = ch.feedin ? SUN_COLOR : (DESCRIPTORS[live.descriptor] || {}).color || UNKNOWN_COLOR;
    const bg = `radial-gradient(circle at 32% 24%, color-mix(in srgb, ${base} 62%, #ffffff), ${base} 78%)`;
    const ren =
      live.renewables !== null
        ? `<div class="h-ren"><strong>${Math.round(live.renewables)}%</strong><span>renewables in grid</span></div>`
        : "";
    return `
      <div class="live">
        <div class="circle" style="background:${bg}">
          <div class="h-icon">${ch.feedin ? SUN_SVG : BOLT_SVG}</div>
          <div class="h-time">${this._time(live.start)} - ${this._time(live.end)}</div>
          <div class="h-price">${this._centsNum(live.price)}<span class="c">\u00A2</span></div>
          <div class="h-unit">/kWh</div>
          ${ren}
        </div>
      </div>`;
  }

  _tiles() {
    if (this._channels.length < 2) return "";
    const tiles = this._channels
      .map((ch) => {
        const s = this._hass.states[ch.entity];
        const v = s ? parseFloat(s.state) : NaN;
        const price = isFinite(v) ? this._cents(v * (ch.invert ? -1 : 1)) : "\u2013";
        return `
          <button class="tile ${ch.id === this._active ? "active" : ""}" data-ch="${ch.id}" aria-pressed="${ch.id === this._active}">
            <span class="t-icon">${ch.feedin ? SUN_SVG : BOLT_SVG}</span>
            <span class="t-label">${ch.label}</span>
            <span class="t-price">${price}<small> /kWh</small></span>
          </button>`;
      })
      .join("");
    return `<div class="tiles">${tiles}</div>`;
  }

  _strip(ch, future) {
    const intervals = this._pastIntervals(ch, future).concat(future);
    const groups = this._group(intervals);
    const nowStart = future[0].start;
    const nowKey = Math.floor(nowStart / BUCKET_MS) * BUCKET_MS;
    if (this._config.expand_current && !ch.autoExpandDone) {
      ch.expandedKey = nowKey;
      ch.autoExpandDone = true;
    }
    const cols = groups
      .map((g) => {
        if (g.key === ch.expandedKey) {
          const subs = g.intervals
            .map((iv) => {
              const cls = [iv.past ? "past" : "", iv.start === nowStart ? "now" : ""].join(" ");
              return this._cell(this._time(iv.start), iv, cls, ch.feedin);
            })
            .join("");
          return `<div class="group open" data-key="${g.key}" tabindex="0" role="button" aria-expanded="true">${subs}</div>`;
        }
        const isNow = g.intervals.some((iv) => iv.start === nowStart);
        const cls = [g.past ? "past" : "", isNow ? "now" : ""].join(" ");
        return `<div class="group" data-key="${g.key}" tabindex="0" role="button" aria-expanded="false">${this._cell(
          this._time(g.key),
          g,
          cls,
          ch.feedin
        )}</div>`;
      })
      .join("");
    return { html: `<div class="scroller">${cols}</div>`, nowKey };
  }

  // Centre an element (by selector) in the strip. Retries for a few frames in case the
  // card hasn't been laid out yet (width 0) when first rendered.
  _centreOn(scroller, selector, done, attempt) {
    const el = scroller.querySelector(selector);
    if (!el) return;
    if (scroller.clientWidth === 0 && attempt < 10) {
      requestAnimationFrame(() => this._centreOn(scroller, selector, done, attempt + 1));
      return;
    }
    scroller.scrollLeft = Math.max(0, el.offsetLeft + el.offsetWidth / 2 - scroller.clientWidth / 2);
    if (done) done();
  }

  // ---------- render ----------

  _render() {
    if (!this._config || !this._hass || !this._channels.length) return;
    const ch = this._channels.find((c) => c.id === this._active) || this._channels[0];
    const stateObj = this._hass.states[ch.entity];

    const prev = this.shadowRoot.querySelector(".scroller");
    const prevScroll = prev ? prev.scrollLeft : 0;

    let live = "";
    let strip = "";
    let nowKey;
    const future = stateObj ? this._intervals(ch, stateObj) : [];
    if (!stateObj) {
      strip = `<div class="msg">Entity ${ch.entity} not found.</div>`;
    } else if (!future.length) {
      strip = `<div class="msg">No forecast data on ${ch.entity}. Check the Amber Express forecast intervals option.</div>`;
    } else {
      if (this._config.show_live) live = this._hero(ch, future[0]);
      const s = this._strip(ch, future);
      strip = s.html;
      nowKey = s.nowKey;
    }

    const legend = this._config.show_renewables ? "\u00A2/kWh \u00B7 renewables %" : "\u00A2/kWh";
    const note = ch.historyError ? `<div class="note">History unavailable: ${ch.historyError}</div>` : "";

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card { padding: 16px 12px 10px; overflow: hidden; }
        .label { font-size: 1rem; color: var(--primary-text-color); text-transform: uppercase; padding: 0 4px; }
        .live { display: flex; justify-content: center; padding: 18px 0 22px; }
        .circle { width: min(250px, 72%); aspect-ratio: 1; border-radius: 50%; display: flex; flex-direction: column;
                  align-items: center; justify-content: center; color: #0a1230; text-align: center; }
        .h-icon svg { width: 26px; height: 26px; display: block; }
        .h-time { font-size: 1rem; margin-top: 6px; }
        .h-price { font-size: clamp(3rem, 14vw, 4.4rem); font-weight: 700; line-height: 1; margin-top: 8px; }
        .h-price .c { font-size: 0.7em; }
        .h-unit { font-size: 0.75rem; margin-top: 2px; }
        .h-ren { margin-top: 12px; display: flex; flex-direction: column; font-size: 0.9rem; }
        .h-ren strong { font-size: 1.4rem; }
        .tiles { display: flex; gap: 8px; padding: 0 4px 12px; }
        .tile { flex: 1 1 0; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; text-align: left;
                padding: 12px 14px; border-radius: 10px; border: 2px solid transparent; cursor: pointer;
                background: var(--secondary-background-color); color: var(--primary-text-color); font: inherit; }
        .tile:hover { border-color: var(--divider-color); }
        .tile:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
        .tile.active { border-color: var(--primary-text-color); }
        .t-icon svg { width: 22px; height: 22px; display: block; }
        .tile .t-icon { color: var(--primary-text-color); }
        .tile:not(.active) .t-icon, .tile:not(.active) .t-label { opacity: 0.7; }
        .t-label { font-size: 0.95rem; }
        .t-price { font-size: 1.6rem; font-weight: 700; }
        .t-price small { font-size: 0.8rem; font-weight: 400; }
        .strip-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 4px 4px 0; }
        .legend { font-size: 0.75rem; color: var(--secondary-text-color); white-space: nowrap; }
        .note { padding: 0 4px; font-size: 0.75rem; color: var(--warning-color, #f5a623); }
        .scroller { position: relative; display: flex; align-items: stretch; overflow-x: auto;
                    padding: 6px 0 10px; scrollbar-width: thin; }
        .group { flex: 0 0 auto; display: flex; border: 2px solid transparent; border-radius: 8px;
                 cursor: pointer; outline: none; }
        .group:hover { background: var(--secondary-background-color); }
        .group:focus-visible { border-color: var(--primary-color); }
        .group.open { border-color: var(--primary-text-color); background: none; }
        .cell { width: 60px; padding: 8px 0 6px; text-align: center; color: var(--secondary-text-color);
                font-variant-numeric: tabular-nums; }
        .cell .time { font-size: 0.8rem; }
        .cell .dot { display: block; width: 22px; height: 22px; border-radius: 50%; margin: 10px auto; }
        .cell .dot.sun { box-shadow: 0 0 0 4px rgba(255, 193, 7, 0.28); }
        .cell .price { font-size: 0.95rem; color: var(--primary-text-color); }
        .cell .ren { font-size: 0.85rem; margin-top: 8px; }
        .cell.past .time, .cell.past .price, .cell.past .ren { opacity: 0.55; }
        .cell.past .dot { opacity: 0.45; }
        .cell.now .time, .cell.now .ren { color: var(--primary-text-color); font-weight: 600; }
        .cell.now .price { font-weight: 700; }
        .msg { padding: 16px; color: var(--secondary-text-color); }
        @media (prefers-reduced-motion: no-preference) {
          .group.open .cell { animation: reveal 160ms ease-out; }
          @keyframes reveal { from { opacity: 0; } to { opacity: 1; } }
        }
      </style>
      <ha-card>
        ${this._config.show_live ? `<div class="label">Live price</div>${live}` : ""}
        ${this._tiles()}
        <div class="strip-head">
          <span class="label" style="padding:0">30 min forecast - ${ch.label}</span>
          <span class="legend">${legend}</span>
        </div>
        ${note}
        ${strip}
      </ha-card>`;

    const scroller = this.shadowRoot.querySelector(".scroller");
    if (scroller) {
      if (this._renderedCh === ch.id) scroller.scrollLeft = prevScroll;
      if (ch.centreKey !== undefined) {
        // After expanding or collapsing a block, keep that block in the middle.
        const key = ch.centreKey;
        ch.centreKey = undefined;
        this._centreOn(scroller, `.group[data-key="${key}"]`, null, 0);
      } else if (ch.pendingScroll && ch.historyDone && nowKey !== undefined) {
        this._centreOn(scroller, ".cell.now", () => (ch.pendingScroll = false), 0);
      }
      scroller.querySelectorAll(".group").forEach((el) => {
        const toggle = () => {
          const key = Number(el.dataset.key);
          ch.expandedKey = ch.expandedKey === key ? undefined : key;
          ch.centreKey = key;
          this._render();
        };
        el.addEventListener("click", toggle);
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        });
      });
    }
    this._renderedCh = ch.id;

    this.shadowRoot.querySelectorAll(".tile").forEach((el) => {
      el.addEventListener("click", () => {
        const next = this._channels.find((c) => c.id === el.dataset.ch);
        if (!next || next.id === this._active) return;
        this._active = next.id;
        next.pendingScroll = true;
        if (!next.historyDone && !next.fetching) this._fetchHistory(next);
        this._render();
      });
    });
  }
}

if (!customElements.get("amber-forecast-card")) {
customElements.define("amber-forecast-card", AmberForecastCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "amber-forecast-card",
  name: "Amber Forecast Card",
  description: "Amber live price, General/Solar toggle and 30-minute forecast with 5-minute drill-down.",
});
}
