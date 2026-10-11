import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";
import {
  store, loadBase, setSlice, availableFreqs, loadFlows, loadBreakdown, hasFlows, nameOf, shortNameOf,
  isGroup, partnerSeries, displayTotals, worldSeries, metricAt, changeAt, defaultPeriodIndex, emptySeries,
  products, productName,
} from "./data.js";
import { createMap } from "./map.js";
import { renderPanel, lineChart, METRIC_LABEL } from "./panel.js";
import { initStories, activeStory, startStory, stopStory } from "./stories.js";
import { FREQS, periodLabel, nearestIndex } from "./time.js";
import { money, ratioPct, share, escapeHTML as esc } from "./format.js";

const $ = (s) => document.querySelector(s);
const dark = matchMedia("(prefers-color-scheme: dark)");
const DEFAULT_GROUPS = ["EU"];

const state = {
  product: "TOTAL", // "TOTAL" = all goods (IMF); otherwise a sector/commodity id (CEPII BACI)
  freq: "A",
  pi: 0,          // index into store.periods
  focus: null,
  metric: "total",
  back: 0,        // change mode, in years (0 = levels)
  groupsOn: new Set(DEFAULT_GROUPS),
  pair: null,
};

let map, current = null, playTimer = null, updateToken = 0, markers = [];

const period = (i = state.pi) => store.periods[i];
const label = (i = state.pi) => periodLabel(store.periods[i]);
/** Change-mode offset in periods (a year back = 12 months back in monthly data). */
const backN = () => state.back * FREQS[state.freq].perYear;
/** Comparison offset for stats and tooltips: the change mode, or one year. */
const compareN = () => (state.back || 1) * FREQS[state.freq].perYear;

// ------------------------------------------------------------------ colors

function palettes() {
  const d = dark.matches;
  return {
    total: d ? ["#22314a", "#3d6bb8", "#9cc3ff", "#e8f1ff"] : ["#dde7f6", "#7fa6dc", "#2f5fb3", "#0b2d66"],
    exports: d ? ["#1d3a33", "#2f8f72", "#7fe0bf", "#e5fff6"] : ["#dcf1e9", "#79c6a8", "#1f8a70", "#0b4a3a"],
    imports: d ? ["#40291f", "#b55a32", "#f7a77e", "#fff0e8"] : ["#f8e4d8", "#e7a07b", "#c2562b", "#6e2a0f"],
    diverging: d
      ? ["#f08a5d", "#9a5c40", "#5b6575", "#3a8f75", "#5fe0b5"]
      : ["#b3471d", "#ebb497", "#eeeeee", "#9fd6c2", "#16775f"],
  };
}

function buildScale(allValues, metric, back) {
  const pal = palettes();
  if (back && metric !== "balance") {
    // ratio v/v0 shown on a log2 scale from ¼× to 4×
    const s = d3.scaleDiverging([-2, 0, 2], d3.interpolateRgbBasis(pal.diverging)).clamp(true);
    return {
      color: (r) => s(Math.log2(r)), kind: "ratio",
      ticks: [0.25, 0.5, 1, 2, 4], pos: (r) => (Math.log2(r) + 2) / 4,
      fmt: (r) => (r === 1 ? "0" : ratioPct(r)),
    };
  }
  if (metric === "balance" || back) {
    const M = d3.max(allValues, Math.abs) || 1;
    const s = d3.scaleDivergingSymlog([-M, 0, M], d3.interpolateRgbBasis(pal.diverging)).constant(M / 300).clamp(true);
    const toUnit = s.copy().interpolator(d3.interpolateNumber(0, 1));
    return {
      color: s, kind: "diverging", pos: (v) => toUnit(v), fmt: (v) => money(v, { sign: true }),
      ticks: [-M, -M / 20, 0, M / 20, M],
    };
  }
  const max = d3.max(allValues) || 1;
  const pos = allValues.filter((v) => v > 0);
  const lo = Math.max(d3.min(pos) ?? max / 1e4, max / 1e4);
  const s = d3.scaleSequentialLog([lo, max], d3.interpolateRgbBasis(pal[metric] ?? pal.total)).clamp(true);
  const ticks = [];
  for (let t = 10 ** Math.ceil(Math.log10(lo)); t <= max; t *= 10) ticks.push(t);
  return {
    color: (v) => (v > 0 ? s(v) : null), kind: "sequential",
    pos: (v) => (Math.log(v) - Math.log(lo)) / (Math.log(max) - Math.log(lo)),
    ticks, fmt: (v) => money(v),
  };
}

function valueAt(s, i) {
  return state.back ? changeAt(s, i, state.metric, backN()) : metricAt(s, i, state.metric);
}

// ------------------------------------------------------------------ main update

async function update() {
  const token = ++updateToken;
  const { focus, pi, metric, groupsOn, freq, product } = state;
  const back = backN();
  let seriesMap, focusSeries = null, intra = null, breakdown = null;

  if (focus) {
    let flows;
    [flows, breakdown] = await Promise.all([loadFlows(focus, freq, product), loadBreakdown(focus)]);
    if (token !== updateToken) return;
    seriesMap = partnerSeries(flows, focus, groupsOn);
    focusSeries = store.totals[focus] ?? emptySeries();
    intra = flows.intra ?? null;
  } else {
    seriesMap = displayTotals(groupsOn);
  }
  $("#loading").hidden = true;

  // Fixed color domain across all periods, so animation shows real change.
  const scaleKey = [product, freq, focus, metric, back, [...groupsOn].sort(), dark.matches].join("|");
  if (!current || current.scaleKey !== scaleKey) {
    const all = [];
    for (const s of seriesMap.values()) {
      for (let i = back; i < store.periods.length; i++) {
        const v = back ? changeAt(s, i, metric, back) : metricAt(s, i, metric);
        if (v != null) all.push(v);
      }
    }
    current = { scaleKey, scale: buildScale(all, metric, back) };
  }
  Object.assign(current, { seriesMap, focusSeries, intra, world: worldSeries() });

  const values = new Map();
  for (const [k, s] of seriesMap) values.set(k, valueAt(s, pi));
  const colorOf = (k) => {
    const v = values.get(k);
    return v == null ? null : current.scale.color(v);
  };

  map.render({ focus, pi, groupsOn, colorOf, arcs: focus ? buildArcs(seriesMap) : [] });
  renderLegend();
  renderTitle();
  renderSpark();
  renderPanel($("#panel"), {
    focus, pi, metric, compare: compareN(), label: label(), groupsOn, product,
    seriesMap, partners: seriesMap, focusSeries, intra, pair: state.pair, breakdown,
    world: current.world, hasData: !focus || hasFlows(focus),
    onFocus: setFocus,
    onProduct: setProduct,
    onPair: (k) => { state.pair = state.pair === k ? null : k; update(); },
  });
  writeHash();
}

function buildArcs(partners) {
  const { focus, pi, metric } = state;
  const rows = [...partners]
    .map(([key, s]) => ({ key, s, v: metricAt(s, pi, metric) }))
    .filter((r) => r.v != null && r.v !== 0 && map.hasShape(r.key))
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
    .slice(0, 10);
  return rows.map(({ key, v }) => {
    if (metric === "exports") return { from: focus, to: key, value: v, kind: "exports", animate: true };
    if (metric === "imports") return { from: key, to: focus, value: v, kind: "imports", animate: true };
    if (metric === "balance") {
      return v > 0
        ? { from: focus, to: key, value: v, kind: "exports", animate: true }
        : { from: key, to: focus, value: -v, kind: "imports", animate: true };
    }
    return { from: focus, to: key, value: v, kind: "total", animate: false };
  });
}

// ------------------------------------------------------------------ decorations

function renderTitle() {
  const { focus, metric, back, product } = state;
  const prod = product === "TOTAL" ? "" : `${productName(product).toLowerCase()} `;
  const what = prod && metric === "total" ? "trade" : METRIC_LABEL[metric];
  const prep = { exports: "to", imports: "from" }[metric] ?? "with";
  const head = focus
    ? `${esc(nameOf(focus))}: ${esc(prod)}${what} ${prep} each partner, ${label()}`
    : esc(`${prod}${what}`.replace(/^./, (c) => c.toUpperCase())) + ` ${prep} the world, ${label()}`;
  const unit = product !== "TOTAL" ? "goods by product (CEPII BACI), current US$"
    : state.freq === "M" ? "monthly goods trade, current US$" : "goods, current US$";
  const base = state.pi - backN();
  const sub = !back ? unit[0].toUpperCase() + unit.slice(1)
    : base >= 0 ? `Change since ${label(base)} · ${unit}`
    : `No data ${state.back} year${state.back > 1 ? "s" : ""} earlier: pick a later period or a shorter change`;
  $("#map-title").innerHTML = `${head}<small>${sub}</small>`;
}

function renderLegend() {
  const sc = current.scale;
  const W = 250, H = 10;
  const el = $("#legend");
  el.innerHTML = "";
  const svg = d3.select(el).append("svg").attr("width", W).attr("height", H + 18);
  const id = "lg-grad";
  const grad = svg.append("defs").append("linearGradient").attr("id", id);
  const samples = sampleScale(sc);
  grad.selectAll("stop").data(d3.range(0, 1.0001, 0.05)).join("stop")
    .attr("offset", (t) => `${t * 100}%`)
    .attr("stop-color", (t) => samples(t));
  svg.append("rect").attr("width", W).attr("height", H).attr("rx", 2).attr("fill", `url(#${id})`);
  svg.selectAll("text").data(sc.ticks.filter((t) => {
    const p = sc.pos(t);
    return p >= -0.01 && p <= 1.01;
  })).join("text")
    .attr("x", (t) => Math.min(W - 2, Math.max(2, sc.pos(t) * W)))
    .attr("y", H + 13)
    .attr("text-anchor", (t) => (sc.pos(t) < 0.05 ? "start" : sc.pos(t) > 0.95 ? "end" : "middle"))
    .text((t) => sc.fmt(t));
  const legendNote = state.focus
    ? `<div class="arc-key">${state.metric === "total"
      ? `<span style="color:var(--accent)">Top 10 partners</span>`
      : `<span class="x">${state.metric === "balance" ? "Surplus with" : "Exports to"}</span><span class="m">${state.metric === "balance" ? "Deficit with" : "Imports from"}</span>`}</div>`
    : "";
  el.insertAdjacentHTML("beforeend", `<div>No data <span style="display:inline-block;width:10px;height:10px;background:var(--land);border-radius:2px;vertical-align:middle"></span></div>${legendNote}`);
}

/** Map legend position t∈[0,1] to a color by bisecting the scale's pos() function. */
function sampleScale(sc) {
  const lo = sc.ticks[0], hi = sc.ticks.at(-1);
  if (sc.kind === "ratio") return (t) => sc.color(2 ** (t * 4 - 2));
  if (sc.kind === "diverging") {
    return (t) => {
      let a = lo, b = hi;
      for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (sc.pos(m) < t) a = m; else b = m; }
      return sc.color((a + b) / 2);
    };
  }
  return (t) => {
    const p0 = sc.pos(lo), p1 = sc.pos(hi);
    const lv = Math.log(lo) + ((t - p0) / (p1 - p0 || 1)) * (Math.log(hi) - Math.log(lo));
    return sc.color(Math.exp(lv)) ?? "transparent";
  };
}

function renderSpark() {
  const s = state.focus ? current.focusSeries : current.world;
  const el = $("#spark");
  el.innerHTML = "";
  const W = el.clientWidth || 600, H = 34, n = store.periods.length;
  const vals = store.periods.map((_, i) => metricAt(s, i, "total"));
  const x = d3.scaleLinear([0, n - 1], [8, W - 8]);
  const y = d3.scaleLinear([0, d3.max(vals) || 1], [H - 2, 4]);
  const svg = d3.select(el).append("svg").attr("viewBox", [0, 0, W, H]).attr("preserveAspectRatio", "none");
  const area = d3.area().defined((v) => v != null).x((_, i) => x(i)).y0(H).y1((v) => y(v));
  svg.append("path").attr("class", "area").attr("d", area(vals));
  svg.append("path").attr("class", "ln").attr("d", area.lineY1()(vals));
  for (const m of markers) {
    const i = nearestIndex(store.periods, m.t);
    if (i < 0) continue;
    svg.append("line").attr("class", "marker").attr("x1", x(i)).attr("x2", x(i)).attr("y1", 0).attr("y2", H)
      .append("title").text(`${periodLabel(m.t)}: ${m.label}`);
  }
  svg.append("circle").attr("cx", x(state.pi)).attr("cy", y(vals[state.pi] ?? 0)).attr("r", 3).attr("fill", "var(--accent)");
  const what = state.product === "TOTAL" ? "total trade" : `${productName(state.product).toLowerCase()} trade`;
  svg.append("text").attr("x", 8).attr("y", 11).text(`${state.focus ? nameOf(state.focus) : "World"} ${what}`);
}

// ------------------------------------------------------------------ tooltip

const tip = $("#tooltip");

function showTip(key, ev, feature) {
  if (!key) { tip.hidden = true; return; }
  const { focus, pi } = state;
  let body;
  if (key === focus || (feature?.id === focus)) {
    body = `<h4>${esc(nameOf(focus))}</h4><div class="sub">Selected · ${label()}</div>`;
  } else if (!current) {
    return;
  } else {
    const s = current.seriesMap.get(key);
    const name = nameOf(key);
    const memberOf = feature?.id && feature.id !== key ? ` (incl. ${esc(feature.properties.name)})` : "";
    if (!s) {
      body = `<h4>${esc(feature?.properties?.name ?? name)}</h4><div class="sub">No data${focus ? ` with ${esc(nameOf(focus))}` : ""}</div>`;
    } else if (focus) {
      const fs = current.focusSeries;
      const fn = esc(shortNameOf(focus));
      body = `<h4>${esc(name)}${memberOf}</h4>
        <div class="sub">with ${esc(nameOf(focus))}, ${label()}</div>
        <table>
          <tr><td>${fn} exports to</td><td>${money(metricAt(s, pi, "exports"))}</td></tr>
          <tr><td>${fn} imports from</td><td>${money(metricAt(s, pi, "imports"))}</td></tr>
          <tr><td>Balance</td><td>${money(metricAt(s, pi, "balance"), { sign: true })}</td></tr>
          <tr><td>Share of ${fn}'s trade</td><td>${share(metricAt(s, pi, "total"), metricAt(fs, pi, "total")) || "—"}</td></tr>
          ${changeRow(s)}
        </table>
        <div class="chart" id="tip-chart"></div>
        <div class="hint">Click to focus on ${esc(name)}</div>`;
    } else {
      body = `<h4>${esc(name)}${memberOf}</h4>
        <div class="sub">${isGroup(key) ? "Trade with non-members" : "Trade with the world"}, ${label()}</div>
        <table>
          <tr><td>Exports</td><td>${money(metricAt(s, pi, "exports"))}</td></tr>
          <tr><td>Imports</td><td>${money(metricAt(s, pi, "imports"))}</td></tr>
          <tr><td>Balance</td><td>${money(metricAt(s, pi, "balance"), { sign: true })}</td></tr>
          ${changeRow(s)}
        </table>
        <div class="chart" id="tip-chart"></div>
        <div class="hint">Click to see trading partners</div>`;
    }
  }
  tip.innerHTML = body;
  const chartEl = tip.querySelector("#tip-chart");
  const s = current?.seriesMap.get(key);
  if (chartEl && s) lineChart(chartEl, s, pi, { height: 90 });
  tip.hidden = false;
  moveTip(ev);
}

function changeRow(s) {
  const b = compareN();
  const metric = state.metric === "balance" ? "total" : state.metric;
  const r = changeAt(s, state.pi, metric, b);
  return `<tr><td>${METRIC_LABEL[metric]} vs ${label(state.pi - b)}</td><td class="${r == null ? "" : r >= 1 ? "up" : "down"}">${ratioPct(r)}</td></tr>`;
}

function moveTip(ev) {
  if (tip.hidden || !ev) return;
  const box = $(".map-wrap").getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = ev.clientX - box.left + 14, y = ev.clientY - box.top + 14;
  if (x + tw > box.width - 6) x = ev.clientX - box.left - tw - 14;
  if (y + th > box.height - 6) y = Math.max(6, box.height - th - 6);
  tip.style.left = `${Math.max(6, x)}px`;
  tip.style.top = `${y}px`;
}

// ------------------------------------------------------------------ actions

function setFocus(key) {
  if (key && isGroup(key)) state.groupsOn.add(key);
  state.focus = key || null;
  state.pair = null;
  syncControls();
  update();
}

function setPeriod(i) {
  state.pi = Math.max(0, Math.min(store.periods.length - 1, i));
  syncTimeline();
  return update();
}

/** Switch product and/or frequency, keeping the selected time as close as possible. */
async function changeSlice(product, freq) {
  if (!availableFreqs(product).includes(freq)) freq = availableFreqs(product)[0];
  if (product === state.product && freq === state.freq) return;
  const keep = period();
  await setSlice(product, freq);
  Object.assign(state, { product, freq, pair: null });
  state.pi = nearestIndex(store.periods, keep);
  current = null;
  setupTimeline();
  syncControls();
  await update();
}

function changeFreq(freq) {
  return changeSlice(state.product, freq);
}

function setProduct(product) {
  stopPlay();
  return changeSlice(product, state.freq);
}

function stopPlay() {
  if (!playTimer) return;
  clearInterval(playTimer.id);
  playTimer.resolve?.();
  playTimer = null;
  $("#play").textContent = "▶";
}

/** Step through periods up to index `to` (default: the end). Resolves when done or stopped. */
function playTo(to = store.periods.length - 1, ms = FREQS[state.freq].playMs) {
  stopPlay();
  if (state.pi >= to) setPeriod(0);
  $("#play").textContent = "❚❚";
  return new Promise((resolve) => {
    playTimer = {
      resolve,
      id: setInterval(() => {
        if (state.pi >= to) { stopPlay(); return; }
        setPeriod(state.pi + 1);
      }, ms),
    };
  });
}

function togglePlay() {
  if (playTimer) stopPlay();
  else playTo();
}

function syncTimeline() {
  $("#year").value = state.pi;
  $("#year").setAttribute("aria-valuetext", label());
  $("#year-label").textContent = label();
}

function syncControls() {
  const freqs = availableFreqs(state.product);
  for (const b of document.querySelectorAll("#freq button")) {
    b.setAttribute("aria-checked", b.dataset.v === state.freq);
    b.disabled = !freqs.includes(b.dataset.v);
    b.title = b.disabled ? "Monthly data is available for all goods only" : "";
  }
  $("#product").value = state.product;
  for (const b of document.querySelectorAll("#metric button")) b.setAttribute("aria-checked", b.dataset.v === state.metric);
  for (const b of document.querySelectorAll("#mode button")) b.setAttribute("aria-checked", +b.dataset.v === state.back);
  for (const b of document.querySelectorAll("#group-chips .chip")) b.setAttribute("aria-pressed", state.groupsOn.has(b.dataset.g));
  $("#world-btn").disabled = !state.focus;
  syncTimeline();
}

function setupTimeline() {
  const input = $("#year");
  input.min = 0;
  input.max = store.periods.length - 1;
  $(".timeline").classList.toggle("monthly", state.freq !== "A");
}

function setupControls() {
  setupTimeline();
  $("#year").addEventListener("input", (e) => { stopPlay(); setPeriod(+e.target.value); });
  $("#play").addEventListener("click", togglePlay);

  const productOpts = (kind) => products().filter((p) => p.kind === kind)
    .map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  $("#product").innerHTML = `<option value="TOTAL">All goods</option>${products().length ? `
    <optgroup label="Sectors">${productOpts("sector")}</optgroup>
    <optgroup label="Commodities">${productOpts("commodity")}</optgroup>` : ""}`;
  $("#product").hidden = !products().length;
  $("#product").addEventListener("change", (e) => setProduct(e.target.value));

  const freqs = availableFreqs();
  $("#freq").innerHTML = freqs.map((f) => `<button data-v="${f}" role="radio">${FREQS[f]?.label ?? f}</button>`).join("");
  $("#freq").hidden = freqs.length < 2;
  $("#freq").addEventListener("click", (e) => {
    const v = e.target.closest("button")?.dataset.v;
    if (v) { stopPlay(); changeFreq(v); }
  });
  $("#metric").addEventListener("click", (e) => {
    const v = e.target.closest("button")?.dataset.v;
    if (v) { state.metric = v; syncControls(); update(); }
  });
  $("#mode").addEventListener("click", (e) => {
    const v = e.target.closest("button")?.dataset.v;
    if (v != null) { state.back = +v; syncControls(); update(); }
  });

  const chips = $("#group-chips");
  for (const g of store.groups) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.dataset.g = g.id;
    b.textContent = g.short;
    b.title = g.name;
    b.addEventListener("click", () => {
      if (state.groupsOn.has(g.id)) {
        state.groupsOn.delete(g.id);
        if (state.focus === g.id) state.focus = null;
      } else {
        state.groupsOn.add(g.id);
      }
      state.pair = null;
      syncControls();
      update();
    });
    chips.append(b);
  }

  // search
  const options = [
    ...store.groups.map((g) => ({ code: g.id, name: g.name })),
    ...Object.entries(store.entities).filter(([, e]) => e.reporter).map(([code, e]) => ({ code, name: e.name })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  $("#entity-list").innerHTML = options.map((o) => `<option value="${esc(o.name)}"></option>`).join("");
  const search = $("#search");
  const pick = () => {
    const q = search.value.trim().toLowerCase();
    if (!q) return;
    const hit = options.find((o) => o.name.toLowerCase() === q || o.code.toLowerCase() === q)
      ?? options.find((o) => o.name.toLowerCase().startsWith(q));
    if (hit) { setFocus(hit.code); search.value = ""; search.blur(); }
  };
  search.addEventListener("change", pick);
  search.addEventListener("keydown", (e) => { if (e.key === "Enter") pick(); });

  $("#world-btn").addEventListener("click", () => setFocus(null));
  $("#zoom-in").addEventListener("click", () => map.zoomBy(1.6));
  $("#zoom-out").addEventListener("click", () => map.zoomBy(1 / 1.6));
  $("#zoom-reset").addEventListener("click", () => map.reset());

  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, dialog[open]")) return;
    if (e.key === "ArrowLeft") { stopPlay(); setPeriod(state.pi - 1); }
    else if (e.key === "ArrowRight") { stopPlay(); setPeriod(state.pi + 1); }
    else if (e.key === " ") { e.preventDefault(); togglePlay(); }
    else if (e.key === "Escape") { if (activeStory()) stopStory(); else setFocus(null); }
  });

  $("#about-btn").addEventListener("click", () => $("#about").showModal());
  dark.addEventListener("change", () => { current = null; update(); });
  new ResizeObserver(() => current && renderSpark()).observe($("#spark"));
}

// ------------------------------------------------------------------ sources

function renderSources() {
  const src = Object.fromEntries(store.meta.sources.map((s) => [s.id, s]));
  const { imf_imts: imf, un_m49: m49, natural_earth: ne } = src;
  const baci = store.meta.products ? src.cepii_baci : null;
  const span = (f) => `${periodLabel(store.meta.periods[f][0])}–${periodLabel(store.meta.periods[f].at(-1))}`;
  const coverage = availableFreqs().map((f) => `${FREQS[f]?.label.toLowerCase() ?? f} ${span(f)}`).join("; ");
  $("#source-line").innerHTML = `Sources: <a href="${imf.url}" target="_blank" rel="noopener">IMF, International Trade in Goods by partner country (IMTS)</a>, accessed ${imf.accessed}${baci ? `; by product: <a href="${baci.url}" target="_blank" rel="noopener">CEPII BACI</a> (${esc(baci.terms)})` : ""}.
    Regions: <a href="${m49.url}" target="_blank" rel="noopener">UN M49</a>. Boundaries: <a href="${ne.url}" target="_blank" rel="noopener">Natural Earth</a>.`;
  const memberLabel = (m) => {
    const name = store.entities[m.id]?.name ?? m.id;
    if (m.from && m.to) return `${name} (${m.from}–${m.to})`;
    if (m.from) return `${name} (from ${m.from})`;
    if (m.to) return `${name} (until ${m.to})`;
    return name;
  };
  const groups = store.groups.map((g) => `<li><b>${esc(g.name)}</b>: ${esc(g.members.map(memberLabel).join(", "))}${g.note ? `. <i>${esc(g.note)}</i>` : ""}</li>`).join("");
  $("#about-body").innerHTML = `
    <h2>About the data</h2>
    <h3>Trade values</h3>
    <p>Bilateral merchandise (goods) trade from the <a href="${imf.url}" target="_blank" rel="noopener">${esc(imf.name)}</a>, formerly the ${esc(imf.formerly)}. Coverage: ${esc(coverage)}, in current US dollars (not adjusted for inflation or seasonality). Services trade is not included.</p>
    <ul>
      <li>Exports: <code>${esc(imf.series.exports)}</code></li>
      <li>Imports: <code>${esc(imf.series.imports)}</code></li>
    </ul>
    <p>Each country's figures are <b>as reported by that country</b> (the selected focus). Because exports are valued FOB and imports CIF, and because of timing, re-exports and confidentiality, A's reported exports to B rarely equal B's reported imports from A. The IMF fills gaps for non-reporting economies with estimates derived from partner data. Taiwan is not published as a reporter by the IMF, so its figures here are built from partners' reports ("mirror" data). Recent periods are shown only once most countries have reported them, and may still be revised.</p>
    <p>Monthly values are not seasonally adjusted. The Δ 1 yr mode compares each month with the same month a year earlier, which removes most of the seasonal pattern.</p>
    ${baci ? productsAbout(baci) : ""}
    <h3>Groupings</h3>
    <p>When a grouping is “treated as one”, its members' flows are summed and trade <i>between</i> members is excluded, so the group is shown trading only with the outside world. Membership is applied as of each year: for example, the UK is part of the EU through 2020 and Croatia from 2013. Groups are defined from <a href="${m49.url}" target="_blank" rel="noopener">UN M49 regions</a> or explicit member lists:</p>
    <ul>${groups}</ul>
    <h3>Change modes</h3>
    <p>Δ 1/5/10 yr colors each partner by the ratio between the selected period and the same period that many years earlier (shown as % change, log scale from −75% to +300%). For the balance metric, change is the difference in US dollars.</p>
    <h3>Stories</h3>
    <p>Stories are guided replays of past events. Figures quoted in a story are computed from the data on this site; other facts link to their sources in the story card.</p>
    <h3>Map</h3>
    <p>Boundaries from Natural Earth (1:50m, public domain) via the world-atlas package. Their use does not imply any position on the legal status of any territory. Areas with no matching trade data are grey.</p>
    <h3>Citation</h3>
    <p>${esc(imf.citation)}</p>
    <p>Terms of use for IMF data: <a href="${imf.terms}" target="_blank" rel="noopener">${imf.terms}</a>.</p>
    ${baci ? `<p>${esc(baci.citation)} Licence: <a href="${baci.terms_url}" target="_blank" rel="noopener">${esc(baci.terms)}</a>.</p>` : ""}
    <p class="note">Data files generated ${store.meta.generated} by the pipeline in <code>pipeline/</code>.</p>`;
}

function productsAbout(baci) {
  const ps = store.meta.products;
  const span = `${ps.periods.A[0]}–${ps.periods.A.at(-1)}`;
  const row = (p) => `<li>${esc(p.name)}: HS ${p.hs.length ? esc(p.hs.join(", ")) : "codes not in any other sector"}</li>`;
  return `
    <h3>Trade by product</h3>
    <p>When a product is selected, figures come from <a href="${baci.url}" target="_blank" rel="noopener">${esc(baci.name)}</a>: annual, ${span}. BACI reconciles what exporters and importers report into one value per flow, valued FOB, so its totals differ somewhat from the IMF figures shown for all goods. Products are groups of HS 1992 codes:</p>
    <details><summary>Sectors</summary><ul>${ps.sectors.map(row).join("")}</ul></details>
    <details><summary>Commodities</summary><ul>${ps.commodities.map(row).join("")}</ul></details>`;
}

// ------------------------------------------------------------------ views & URL state

/** A view is the shareable state: {product, freq, t, focus, metric, change, groups, with}, all strings. */
async function applyView(view) {
  stopPlay();
  const product = view.product && products().some((p) => p.id === view.product) ? view.product : "TOTAL";
  const freq = availableFreqs(product).includes(view.freq) ? view.freq : "A";
  if (product !== state.product || freq !== state.freq || !store.periods.length) {
    await setSlice(product, freq);
    Object.assign(state, { product, freq });
    current = null;
    setupTimeline();
  }
  const ti = view.t ? nearestIndex(store.periods, view.t) : -1;
  state.pi = ti >= 0 ? ti : defaultPeriodIndex();
  state.metric = METRIC_LABEL[view.metric] ? view.metric : "total";
  state.back = [1, 5, 10].includes(+view.change) ? +view.change : 0;
  state.groupsOn = view.groups != null
    ? new Set(view.groups.split(",").filter((g) => store.groupById.has(g)))
    : new Set(DEFAULT_GROUPS);
  state.focus = view.focus && (store.entities[view.focus] || isGroup(view.focus)) ? view.focus : null;
  if (state.focus && isGroup(state.focus)) state.groupsOn.add(state.focus);
  state.pair = state.focus && view.with ? view.with : null;
  syncControls();
  await update();
}

function currentView() {
  const v = { t: period(), groups: [...state.groupsOn].join(",") || "none" };
  if (state.product !== "TOTAL") v.product = state.product;
  if (state.freq !== "A") v.freq = state.freq;
  if (state.focus) v.focus = state.focus;
  if (state.metric !== "total") v.metric = state.metric;
  if (state.back) v.change = String(state.back);
  if (state.pair) v.with = state.pair;
  return v;
}

function writeHash() {
  const story = activeStory();
  const p = story ? new URLSearchParams({ story: story.id, step: story.step + 1 }) : new URLSearchParams(currentView());
  history.replaceState(null, "", `#${p}`);
}

async function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get("story") && await startStory(p.get("story"), (+p.get("step") || 1) - 1)) return;
  const view = Object.fromEntries(p);
  if (!view.t && view.year) view.t = view.year; // links from before monthly data
  await applyView(view);
}

// ------------------------------------------------------------------ boot

async function boot() {
  try {
    await loadBase();
    await setSlice("TOTAL", "A");
  } catch (e) {
    $("#loading").textContent = "Could not load data files. If you opened index.html directly, serve the site folder over HTTP instead.";
    throw e;
  }
  map = createMap($("#map"), {
    onHover: showTip,
    onMove: moveTip,
    onClick: (key) => setFocus(key),
  });
  setupControls();
  renderSources();
  initStories({
    applyView,
    playTo: (t, ms) => playTo(nearestIndex(store.periods, t), ms),
    stopPlay,
    setMarkers: (m) => { markers = m; if (current) renderSpark(); },
    onChange: writeHash,
  });
  // Links pasted into the address bar or back/forward (writeHash uses replaceState, which doesn't fire this).
  addEventListener("hashchange", readHash);
  await readHash();
}

boot();
