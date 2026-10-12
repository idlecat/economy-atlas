import * as d3 from "../vendor/d3.js";
import {
  store, loadBase, setSlice, availableFreqs, loadFlows, loadBreakdown, hasFlows, nameOf, shortNameOf,
  isGroup, partnerSeries, displayTotals, worldSeries, metricAt, changeAt, defaultPeriodIndex, emptySeries,
  products, productName, productNameLower, loadIndicators, loadTotals, loadBilateral, groupNote, regionName,
  lists, listName, listNote, listMembers, splitByList,
} from "./data.js";
import { buildMetrics } from "./metrics.js";
import { createScatter } from "./scatter.js";
import { renderTrends, defaultSet, SCALES } from "./trends.js";
import { compareData, statsHTML, REGION_COLORS } from "./compare.js";
import { createMap } from "./map.js";
import { renderPanel, lineChart, METRICS, metricLabel } from "./panel.js";
import { initStories, activeStory, startStory, stopStory } from "./stories.js";
import { FREQS, freqLabel, periodLabel, nearestIndex } from "./time.js";
import { initI18n, t, getLang, setLang, LANGS } from "./i18n.js";
import { money, ratioPct, share, fmtUnit, escapeHTML as esc } from "./format.js";

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
  view: "map",       // "map", "compare" (scatter of two metrics) or "trends" (line charts over time)
  sx: "gdp",         // Compare view axes: metric ids from metrics.js
  sy: "exports",
  mapBy: "trade",    // world-view map colors: "trade" or a metric id (e.g. gdp_pc)
  scale: "usd",      // Trends view: "usd", "log" or "share"
  set: null,         // Trends view: economies side by side; null = the largest ones at the selected period
  list: null,        // highlighted country list (config/lists.json), e.g. "BRI", or null
};

let map, scatter, current = null, playTimer = null, updateToken = 0, markers = [];
let metricsCache = { key: null, metrics: null };
const year = () => +period().slice(0, 4);

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

function buildScale(allValues, metric, back, fmtV = null) {
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
      color: s, kind: "diverging", pos: (v) => toUnit(v), fmt: fmtV ? (v) => fmtV(v, true) : (v) => money(v, { sign: true }),
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
    ticks, fmt: fmtV ? (v) => fmtV(v) : (v) => money(v),
  };
}

/** Metrics for the Compare view and indicator map colors, built from annual data of the active product. */
async function getMetrics() {
  const [ind, bil] = await Promise.all([loadIndicators(), loadBilateral()]);
  const key = state.product;
  if (metricsCache.key !== key) {
    const annual = await loadTotals(state.product, "A");
    const periods = state.product === "TOTAL" ? store.meta.periods.A : store.meta.products.periods.A;
    // every year any metric can have a value in (trade, indicators, bilateral)
    const ys = [periods, ind?.periods, bil?.periods].flatMap((ps) => (ps ?? []).map(Number));
    const years = ys.length ? d3.range(d3.min(ys), d3.max(ys) + 1) : [];
    metricsCache = { key, metrics: buildMetrics(ind, annual, periods, state.product, bil), ind, bil, years };
  }
  return metricsCache;
}

/** Map colors from an indicator (world view only), with a domain over all years. */
function indicatorColors(metric, keys, years) {
  const all = [];
  for (const k of keys) for (const y of years) { const v = metric.value(k, y); if (v != null) all.push(v); }
  const fmtV = (v, sign = false) => fmtUnit(v, metric.unit, { sign });
  if (metric.log) return buildScale(all.filter((v) => v > 0), "total", 0, fmtV);
  if (metric.share) {
    // shares (0–100%): one color ramp from 0, capped at the 98th percentile
    const max = d3.quantile(all.filter((v) => v >= 0).sort(d3.ascending), 0.98) || 1;
    const s = d3.scaleSequential([0, max], d3.interpolateRgbBasis(palettes().total)).clamp(true);
    return { color: (v) => s(v), kind: "linear", pos: (v) => v / max, ticks: [0, max / 4, max / 2, (3 * max) / 4, max], fmt: (v) => fmtV(v) };
  }
  // diverging: a few extreme years (e.g. +123% growth) would wash out everything else, so the range is the
  // 98th percentile of absolute values and anything beyond gets the end colors
  const q = d3.quantile(all.map(Math.abs).sort(d3.ascending), 0.98) || 1;
  return buildScale([-q, q], "balance", 0, fmtV);
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
  if (current.worldKey !== `${product}/${freq}`) Object.assign(current, { worldKey: `${product}/${freq}`, world: worldSeries() });
  Object.assign(current, { seriesMap, focusSeries, intra, flows: focus ? await loadFlows(focus, freq, product) : null });
  const highlight = state.list ? listMembers(state.list) : null;
  current.listSplit = highlight && focus ? splitByList(current.flows, highlight) : null;
  const { metrics, ind, bil, years } = await getMetrics();
  if (token !== updateToken) return;
  current.metrics = metrics;
  syncMetricSelects(metrics);

  if (state.view === "compare") {
    renderCompare(metrics, ind);
  } else if (state.view === "trends") {
    renderTrendsView(seriesMap, focusSeries);
  } else {
    const byMetric = !focus && state.mapBy !== "trade" ? metrics.get(state.mapBy) : null;
    let colorOf;
    if (byMetric) {
      const keys = [...seriesMap.keys(), ...Object.keys(ind?.values.gdp ?? {}).filter((k) => !isGroup(k) && !seriesMap.has(k))];
      const ik = `ind|${state.mapBy}|${product}|${[...groupsOn].sort()}|${dark.matches}`;
      if (current.indKey !== ik) Object.assign(current, { indKey: ik, indScale: indicatorColors(byMetric, keys, years) });
      colorOf = (k) => { const v = byMetric.value(k, year()); return v == null || (byMetric.log && v <= 0) ? null : current.indScale.color(v); };
    } else {
      const values = new Map();
      for (const [k, s] of seriesMap) values.set(k, valueAt(s, pi));
      colorOf = (k) => { const v = values.get(k); return v == null ? null : current.scale.color(v); };
    }
    current.byMetric = byMetric;
    map.render({ focus, pi, groupsOn, colorOf, arcs: focus ? buildArcs(seriesMap) : [], highlight });
    renderLegend(byMetric ? current.indScale : current.scale);
    renderTitle(byMetric);
  }
  renderSpark();
  renderPanel($("#panel"), {
    ind, bil, metrics, year: year(),
    focus, pi, metric, compare: compareN(), label: label(), groupsOn, product,
    seriesMap, partners: seriesMap, focusSeries, intra, pair: state.pair, breakdown,
    list: state.list, listSplit: current.listSplit, flows: current.flows,
    world: current.world, hasData: !focus || hasFlows(focus),
    onFocus: setFocus,
    onProduct: setProduct,
    onPair: (k) => { state.pair = state.pair === k ? null : k; update(); },
  });
  writeHash();
}

// ------------------------------------------------------------------ compare view

function renderCompare(metrics, ind) {
  const d = compareData({ metrics, xId: state.sx, yId: state.sy, year: year(), groupsOn: state.groupsOn, pi: state.pi, focus: state.focus, ind,
    highlight: state.list ? listMembers(state.list) : null });
  current.compare = d;
  scatter.render({ points: d.points, x: d.x, y: d.y, fit: d.stats.fit, animate: true });
  $("#map-title").innerHTML = t("compare.title", { y: esc(d.y.name), x: esc(d.x.name), year: year() }) + statsHTML(d.stats, d.x, d.y, state.groupsOn);
  const regions = [...new Set(d.points.map((p) => p.region))];
  $("#legend").innerHTML = `<div class="region-key">${Object.entries(REGION_COLORS).filter(([r]) => regions.includes(r))
    .map(([r, c]) => `<span><i style="background:${c}"></i>${esc(regionName(r))}</span>`).join("")}${regions.includes("Group") ? `<span><i style="background:#5d6878"></i>${t("compare.mergedGroup")}</span>` : ""}</div>
    <div>${t("compare.legendNote")}</div>${state.list ? `<div class="list-key"><i></i>${esc(listName(state.list))}</div>` : ""}`;
}

// ------------------------------------------------------------------ trends view

function renderTrendsView(partners, focusSeries) {
  renderTrends($("#trends"), {
    pi: state.pi, metric: state.metric, scale: state.scale, focus: state.focus, focusSeries, partners,
    pair: state.pair, world: current.world, findEntity,
    list: state.list, listSplit: current.listSplit,
    set: state.set ?? defaultSet(displayTotals(state.groupsOn), state.pi),
    onPair: (k) => { state.pair = state.pair === k ? null : k; update(); },
    onFocus: setFocus,
    onSetChange: (keys) => { state.set = keys; update(); },
  });
}

function showDotTip(p, ev) {
  if (!p) { tip.hidden = true; return; }
  const { x, y } = current.compare;
  const pop = current.metrics.get("pop")?.value(p.key, year());
  tip.innerHTML = `<h4>${esc(nameOf(p.key))}</h4><div class="sub">${label()}</div>
    <table>
      <tr><td>${esc(y.name)}</td><td>${fmtUnit(p.y, y.unit)}</td></tr>
      <tr><td>${esc(x.name)}</td><td>${fmtUnit(p.x, x.unit)}</td></tr>
      ${pop ? `<tr><td>${esc(current.metrics.get("pop").name)}</td><td>${fmtUnit(pop, "people")}</td></tr>` : ""}
    </table><div class="hint">${t("tip.clickDetails")}</div>`;
  tip.hidden = false;
  moveTip(ev);
}

function syncMetricSelects(metrics) {
  // a link may name a metric that no longer exists
  if (!metrics.has(state.sx)) state.sx = "gdp";
  if (!metrics.has(state.sy)) state.sy = "exports";
  const sig = [...metrics.values()].map((m) => m.id + m.name).join("|");
  for (const [sel, includeTrade] of [["#sx", true], ["#sy", true], ["#map-by", false]]) {
    const el = $(sel);
    if (el.dataset.sig !== sig) {
      const groups = {};
      for (const m of metrics.values()) {
        if (!includeTrade && m.group === "trade") continue;
        (groups[m.group] ??= []).push(m);
      }
      el.innerHTML = (sel === "#map-by" ? `<option value="trade">${t("mapBy.trade")}</option>` : "") +
        Object.entries(groups).map(([g, ms]) => `<optgroup label="${esc(t(`metricGroup.${g}`))}">${ms.map((m) =>
          `<option value="${m.id}">${esc(m.name)}</option>`).join("")}</optgroup>`).join("");
      el.dataset.sig = sig;
    }
  }
  $("#sx").value = state.sx;
  $("#sy").value = state.sy;
  $("#map-by").value = metrics.has(state.mapBy) ? state.mapBy : "trade";
}

async function setView(view) {
  stopPlay();
  state.view = view;
  tip.hidden = true;
  // the Compare view uses annual data
  if (view === "compare" && state.freq !== "A") await changeSlice(state.product, "A");
  syncControls();
  update();
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

function renderTitle(byMetric = null) {
  if (byMetric) {
    $("#map-title").innerHTML = `${t("title.indicator", { name: esc(byMetric.name), year: year() })}<small>${esc(byMetric.description ?? "")}${byMetric.group === "economy" ? " · World Bank WDI" : ""}</small>`;
    return;
  }
  const { focus, metric, back, product } = state;
  // "China: crude oil exports to each partner, 2024" / "Total trade with the world, 2024"
  const prod = product === "TOTAL" ? "" : productNameLower(product);
  const what = prod ? t(`title.what.${metric}`, { product: prod }) : metricLabel(metric);
  const head = focus
    ? t(`title.focus.${metric}`, { name: esc(nameOf(focus)), what: esc(what), period: label() })
    : t(`title.world.${metric}`, { what: esc(what[0].toUpperCase() + what.slice(1)), period: label() });
  const unit = t(product !== "TOTAL" ? "title.unit.product" : state.freq === "M" ? "title.unit.monthly" : "title.unit.goods");
  const base = state.pi - backN();
  const sub = !back ? unit
    : base >= 0 ? t("title.changeSince", { period: label(base), unit })
    : t(state.back > 1 ? "title.noBaseN" : "title.noBase1", { n: state.back });
  $("#map-title").innerHTML = `${head}<small>${sub}${isProvisional() ? ` · <span class="prov">${t("provisional.short")}</span>` : ""}</small>`;
}

function renderLegend(sc = current.scale) {
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
  const legendNote = state.focus && !current.byMetric
    ? `<div class="arc-key">${state.metric === "total"
      ? `<span style="color:var(--accent)">${t("legend.top10")}</span>`
      : `<span class="x">${t(state.metric === "balance" ? "legend.surplus" : "legend.exportsTo")}</span><span class="m">${t(state.metric === "balance" ? "legend.deficit" : "legend.importsFrom")}</span>`}</div>`
    : "";
  if (state.list) el.insertAdjacentHTML("beforeend", `<div class="list-key"><i></i>${esc(listName(state.list))}</div>`);
  el.insertAdjacentHTML("beforeend", `<div>${t("legend.noData")} <span style="display:inline-block;width:10px;height:10px;background:var(--land);border-radius:2px;vertical-align:middle"></span></div>${legendNote}`);
}

/** Map legend position t∈[0,1] to a color by bisecting the scale's pos() function. */
function sampleScale(sc) {
  const lo = sc.ticks[0], hi = sc.ticks.at(-1);
  if (sc.kind === "ratio") return (t) => sc.color(2 ** (t * 4 - 2));
  if (sc.kind === "linear") return (t) => sc.color(t * hi);
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
  svg.append("text").attr("x", 8).attr("y", 11).text(t(state.product === "TOTAL" ? "spark.total" : "spark.product", {
    name: state.focus ? nameOf(state.focus) : t("world"), product: productNameLower(state.product),
  }));
}

// ------------------------------------------------------------------ tooltip

const tip = $("#tooltip");

function showTip(key, ev, feature) {
  if (!key) { tip.hidden = true; return; }
  const { focus, pi } = state;
  let body;
  if (key === focus || (feature?.id === focus)) {
    body = `<h4>${esc(nameOf(focus))}</h4><div class="sub">${t("tip.selected")} · ${label()}</div>`;
  } else if (!current) {
    return;
  } else {
    const s = current.seriesMap.get(key);
    const name = nameOf(key);
    // shapes without an entity id (e.g. Antarctica) only have Natural Earth's English name
    const shapeName = feature ? (feature.id ? nameOf(feature.id) : feature.properties.name) : name;
    const memberOf = feature?.id && feature.id !== key ? t("tip.incl", { name: esc(shapeName) }) : "";
    if (!s) {
      body = `<h4>${esc(shapeName)}</h4><div class="sub">${focus ? t("tip.noDataWith", { name: esc(nameOf(focus)) }) : t("legend.noData")}</div>`;
    } else if (focus) {
      const fs = current.focusSeries;
      const fn = esc(shortNameOf(focus));
      body = `<h4>${esc(name)}${memberOf}</h4>
        <div class="sub">${t("tip.with", { name: esc(nameOf(focus)), period: label() })}</div>
        <table>
          <tr><td>${t("tip.exportsTo", { name: fn })}</td><td>${money(metricAt(s, pi, "exports"))}</td></tr>
          <tr><td>${t("tip.importsFrom", { name: fn })}</td><td>${money(metricAt(s, pi, "imports"))}</td></tr>
          <tr><td>${t("metric.balance")}</td><td>${money(metricAt(s, pi, "balance"), { sign: true })}</td></tr>
          <tr><td>${t("tip.shareOf", { name: fn })}</td><td>${share(metricAt(s, pi, "total"), metricAt(fs, pi, "total")) || "—"}</td></tr>
          ${changeRow(s)}
        </table>
        <div class="chart" id="tip-chart"></div>
        <div class="hint">${t("tip.clickFocus", { name: esc(name) })}</div>`;
    } else {
      body = `<h4>${esc(name)}${memberOf}</h4>
        <div class="sub">${t(isGroup(key) ? "tip.nonMembers" : "tip.world", { period: label() })}</div>
        <table>
          <tr><td>${t("metric.exports")}</td><td>${money(metricAt(s, pi, "exports"))}</td></tr>
          <tr><td>${t("metric.imports")}</td><td>${money(metricAt(s, pi, "imports"))}</td></tr>
          <tr><td>${t("metric.balance")}</td><td>${money(metricAt(s, pi, "balance"), { sign: true })}</td></tr>
          ${changeRow(s)}
          ${current.byMetric ? `<tr><td>${esc(current.byMetric.name)}</td><td>${fmtUnit(current.byMetric.value(key, year()), current.byMetric.unit)}</td></tr>` : ""}
        </table>
        <div class="chart" id="tip-chart"></div>
        <div class="hint">${t("tip.clickPartners")}</div>`;
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
  return `<tr><td>${t("tip.changeVs", { metric: metricLabel(metric), period: label(state.pi - b) })}</td><td class="${r == null ? "" : r >= 1 ? "up" : "down"}">${ratioPct(r)}</td></tr>`;
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

/** Whether the selected period is one the IMF may still revise or has partly estimated (meta.provisional). */
function isProvisional() {
  const from = state.product === "TOTAL" ? store.meta.provisional?.[state.freq] : null;
  return !!from && period() >= from;
}

function syncTimeline() {
  $("#year").value = state.pi;
  $("#year").setAttribute("aria-valuetext", label());
  const el = $("#year-label");
  el.textContent = label();
  el.classList.toggle("provisional", isProvisional());
  el.title = isProvisional() ? t("provisional.title") : "";
}

function syncControls() {
  const freqs = availableFreqs(state.product);
  for (const b of document.querySelectorAll("#freq button")) {
    b.setAttribute("aria-checked", b.dataset.v === state.freq);
    b.disabled = !freqs.includes(b.dataset.v);
    b.title = b.disabled ? t("freq.allGoodsOnly") : "";
  }
  $("#product").value = state.product;
  const compare = state.view === "compare", trends = state.view === "trends", map = state.view === "map";
  $(".map-wrap").classList.toggle("compare", compare);
  $(".map-wrap").classList.toggle("trends", trends);
  for (const b of document.querySelectorAll("#view button")) b.setAttribute("aria-checked", b.dataset.v === state.view);
  $("#metric").hidden = compare;
  $("#mode").hidden = !map;
  $("#scale").hidden = !trends;
  for (const b of document.querySelectorAll("#scale button")) {
    b.setAttribute("aria-checked", b.dataset.v === state.scale);
    b.disabled = b.dataset.v !== "usd" && state.metric === "balance";
  }
  $("#compare-controls").hidden = !compare;
  $("#map-by-wrap").hidden = !map || !!state.focus;
  $("#map").hidden = !map;
  $("#compare").hidden = !compare;
  $("#trends").hidden = !trends;
  for (const el of ["#map-title", "#legend"]) $(el).hidden = trends;
  $(".zoom").hidden = !map;
  if (compare) for (const b of document.querySelectorAll("#freq button")) if (b.dataset.v !== "A") b.disabled = true;
  for (const b of document.querySelectorAll("#metric button")) b.setAttribute("aria-checked", b.dataset.v === state.metric);
  for (const b of document.querySelectorAll("#mode button")) b.setAttribute("aria-checked", +b.dataset.v === state.back);
  for (const b of document.querySelectorAll("#group-chips .chip")) b.setAttribute("aria-pressed", state.groupsOn.has(b.dataset.g));
  $("#world-btn").disabled = !state.focus;
  $("#list").value = state.list ?? "";
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
    .map((p) => `<option value="${p.id}">${esc(productName(p.id))}</option>`).join("");
  $("#product").innerHTML = `<option value="TOTAL">${esc(productName("TOTAL"))}</option>${products().length ? `
    <optgroup label="${t("product.sectors")}">${productOpts("sector")}</optgroup>
    <optgroup label="${t("product.commodities")}">${productOpts("commodity")}</optgroup>` : ""}`;
  $("#product").hidden = !products().length;
  $("#product").addEventListener("change", (e) => setProduct(e.target.value));

  const freqs = availableFreqs();
  $("#freq").innerHTML = freqs.map((f) => `<button data-v="${f}" role="radio">${freqLabel(f)}</button>`).join("");
  $("#freq").hidden = freqs.length < 2;
  $("#freq").addEventListener("click", (e) => {
    const v = e.target.closest("button")?.dataset.v;
    if (v) { stopPlay(); changeFreq(v); }
  });
  $("#view").addEventListener("click", (e) => {
    const v = e.target.closest("button")?.dataset.v;
    if (v && v !== state.view) setView(v);
  });
  $("#sx").addEventListener("change", (e) => { state.sx = e.target.value; update(); });
  $("#sy").addEventListener("change", (e) => { state.sy = e.target.value; update(); });
  $("#swap-axes").addEventListener("click", () => { [state.sx, state.sy] = [state.sy, state.sx]; update(); });
  $("#map-by").addEventListener("change", (e) => { state.mapBy = e.target.value; update(); });
  $("#metric").addEventListener("click", (e) => {
    const v = e.target.closest("button")?.dataset.v;
    if (v) { state.metric = v; syncControls(); update(); }
  });
  $("#list").innerHTML = `<option value="">${t("list.none")}</option>` +
    lists().map((l) => `<option value="${esc(l.id)}">${esc(listName(l.id))}</option>`).join("");
  $("#list-wrap").hidden = !lists().length;
  $("#list").addEventListener("change", (e) => { state.list = e.target.value || null; update(); });
  $("#scale").addEventListener("click", (e) => {
    const v = e.target.closest("button")?.dataset.v;
    if (v) { state.scale = v; syncControls(); update(); }
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
    b.textContent = shortNameOf(g.id);
    b.title = nameOf(g.id);
    b.addEventListener("click", () => {
      const on = !state.groupsOn.has(g.id);
      if (on) {
        state.groupsOn.add(g.id);
      } else {
        state.groupsOn.delete(g.id);
        if (state.focus === g.id) state.focus = null;
      }
      if (activeStory()) rememberGroupChoice(g.id, on);
      state.pair = null;
      syncControls();
      update();
    });
    chips.append(b);
  }

  $("#entity-list").innerHTML = searchOptions().map((o) => `<option value="${esc(o.name)}"></option>`).join("");
  const search = $("#search");
  const pick = () => {
    const code = findEntity(search.value);
    if (code) { setFocus(code); search.value = ""; search.blur(); }
  };
  search.addEventListener("change", pick);
  search.addEventListener("keydown", (e) => { if (e.key === "Enter") pick(); });

  $("#world-btn").addEventListener("click", () => setFocus(null));
  $("#zoom-in").addEventListener("click", () => map.zoomBy(1.6));
  $("#zoom-out").addEventListener("click", () => map.zoomBy(1 / 1.6));
  $("#zoom-reset").addEventListener("click", () => map.reset());

  document.addEventListener("keydown", (e) => {
    // leave keys to form controls; Space also activates a focused button or link
    if (e.target.closest("input, textarea, select, dialog[open]")) return;
    if (e.key === " " && e.target.closest("button, a[href]")) return;
    if (e.key === "ArrowLeft") { stopPlay(); setPeriod(state.pi - 1); }
    else if (e.key === "ArrowRight") { stopPlay(); setPeriod(state.pi + 1); }
    else if (e.key === " ") { e.preventDefault(); togglePlay(); }
    else if (e.key === "Escape") { if (activeStory()) stopStory(); else setFocus(null); }
  });

  $("#about-btn").addEventListener("click", () => $("#about").showModal());
  // the button offers the other language (English <-> 中文)
  const other = Object.keys(LANGS).find((l) => l !== getLang());
  $("#lang-btn").textContent = LANGS[other];
  $("#lang-btn").lang = other;
  $("#lang-btn").addEventListener("click", () => setLang(other));
  dark.addEventListener("change", () => { current = null; update(); });
  new ResizeObserver(() => current && renderSpark()).observe($("#spark"));
}

// ------------------------------------------------------------------ search

let options = null;

/** Groups and reporting economies, by name in the interface language. */
function searchOptions() {
  options ??= [
    ...store.groups.map((g) => ({ code: g.id, name: nameOf(g.id), en: g.name })),
    ...Object.entries(store.entities).filter(([, e]) => e.reporter).map(([code, e]) => ({ code, name: nameOf(code), en: e.name })),
  ].sort((a, b) => a.name.localeCompare(b.name, getLang()));
  return options;
}

/** Entity or group id for a typed name (interface language or English) or code, or null. */
function findEntity(text) {
  const q = text.trim().toLowerCase();
  if (!q) return null;
  const names = (o) => [o.name, o.en].map((n) => n.toLowerCase());
  const opts = searchOptions();
  const hit = opts.find((o) => names(o).includes(q) || o.code.toLowerCase() === q)
    ?? opts.find((o) => names(o).some((n) => n.startsWith(q)));
  return hit?.code ?? null;
}

// ------------------------------------------------------------------ sources

function renderSources() {
  const src = Object.fromEntries(store.meta.sources.map((s) => [s.id, s]));
  const { imf_imts: imf, un_m49: m49, natural_earth: ne } = src;
  const baci = store.meta.products ? src.cepii_baci : null;
  const wb = src.worldbank_wdi;
  const ids = src.worldbank_ids, dip = src.imf_dip;
  const link = (url, text) => `<a href="${url}" target="_blank" rel="noopener">${esc(text)}</a>`;
  const span = (f) => `${periodLabel(store.meta.periods[f][0])}–${periodLabel(store.meta.periods[f].at(-1))}`;
  const coverage = availableFreqs().map((f) => `${freqLabel(f).toLowerCase()} ${span(f)}`).join(t("listSep"));
  // Source names, citations and licences stay in their original language.
  $("#source-line").innerHTML = t("footer.sources", {
    imf: link(imf.url, "IMF, International Trade in Goods by partner country (IMTS)"), accessed: imf.accessed,
    baci: baci ? t("footer.baci", { link: link(baci.url, "CEPII BACI"), terms: esc(baci.terms) }) : "",
    wb: (wb ? t("footer.wb", { link: link(wb.url, "World Bank WDI"), terms: esc(wb.terms) }) : "")
      + (ids && dip ? t("footer.lend", { ids: link(ids.url, "World Bank IDS"), dip: link(dip.url, "IMF DIP") }) : ""),
    m49: link(m49.url, "UN M49"), ne: link(ne.url, "Natural Earth"),
  });
  const memberLabel = (m) => {
    const name = nameOf(m.id);
    if (m.from && m.to) return `${name} (${m.from}–${m.to})`;
    if (m.from) return t("about.memberFrom", { name, year: m.from });
    if (m.to) return t("about.memberUntil", { name, year: m.to });
    return name;
  };
  const groups = store.groups.map((g) => {
    const note = groupNote(g.id);
    return `<li><b>${esc(nameOf(g.id))}</b>: ${esc(g.members.map(memberLabel).join(t("listSep")))}${note ? t("about.groupNote", { note: esc(note) }) : ""}</li>`;
  }).join("");
  $("#about-body").innerHTML = `
    <h2>${t("about.title")}</h2>
    <h3>${t("about.trade.title")}</h3>
    <p>${t("about.trade.intro", { imf: link(imf.url, imf.name), formerly: esc(imf.formerly), coverage: esc(coverage) })}</p>
    <ul>
      <li>${t("about.series", { name: t("metric.exports"), code: esc(imf.series.exports) })}</li>
      <li>${t("about.series", { name: t("metric.imports"), code: esc(imf.series.imports) })}</li>
    </ul>
    <p>${t("about.trade.reported")}</p>
    <p>${t("about.trade.monthly")}</p>
    ${store.meta.provisional ? `<p>${t("about.trade.provisional", { periods: esc(Object.entries(store.meta.provisional)
      .map(([f, p]) => {
        const last = store.meta.periods[f].at(-1);
        return `${freqLabel(f).toLowerCase()} ${periodLabel(p)}${p === last ? "" : `–${periodLabel(last)}`}`;
      }).join(t("listSep"))) })}</p>` : ""}
    ${baci ? productsAbout(baci, link) : ""}
    ${wb ? indicatorsAbout(wb, link) : ""}
    ${ids && dip ? `<h3>${t("about.lend.title")}</h3>
      <p>${t("about.lend.debt", { ids: link(ids.url, ids.name) })}</p>
      <p>${t("about.lend.fdi", { dip: link(dip.url, dip.name) })}</p>
      <p>${t("about.lend.groups")}</p>` : ""}
    <h3>${t("about.groups.title")}</h3>
    <p>${t("about.groups.text", { m49: link(m49.url, t("about.groups.m49")) })}</p>
    <ul>${groups}</ul>
    ${lists().length ? `<h3>${t("about.lists.title")}</h3><p>${t("about.lists.text")}</p>
      <ul>${lists().map((l) => `<li><b>${esc(listName(l.id))}</b> (${l.members.length}): ${esc(listNote(l.id))}
        ${t("list.source", { source: link(l.source.url, l.source.name), date: l.source.accessed })}
        ${(l.withdrawn ?? []).map((w) => t("about.lists.withdrawn", { name: esc(nameOf(w.id)), year: w.year, source: link(w.source.url, w.source.name) })).join(" ")}</li>`).join("")}</ul>` : ""}
    <h3>${t("about.change.title")}</h3>
    <p>${t("about.change.text")}</p>
    <h3>${t("about.stories.title")}</h3>
    <p>${t("about.stories.text")}</p>
    <h3>${t("about.map.title")}</h3>
    <p>${t("about.map.text")}</p>
    <h3>${t("about.citation")}</h3>
    <p>${esc(imf.citation)}</p>
    <p>${t("about.imfTerms", { link: link(imf.terms, imf.terms) })}</p>
    ${wb ? `<p>${t("about.licence", { citation: esc(wb.citation), link: link(wb.terms_url, wb.terms) })}</p>` : ""}
    ${ids ? `<p>${t("about.licence", { citation: esc(ids.citation), link: link(ids.terms_url, ids.terms) })}</p>` : ""}
    ${dip ? `<p>${esc(dip.citation)}</p>` : ""}
    ${baci ? `<p>${t("about.licence", { citation: esc(baci.citation), link: link(baci.terms_url, baci.terms) })}</p>` : ""}
    ${getLang() !== "en" ? `<p>${t("about.translation", { m49: link(m49.url, "UN M49") })}</p>` : ""}
    <p class="note">${t("about.generated", { date: store.meta.generated })}</p>`;
}

function indicatorsAbout(wb, link) {
  return `
    <h3>${t("about.ind.title")}</h3>
    <p>${t("about.ind.source", { wb: link(wb.url, wb.name) })}</p>
    <p>${t("about.ind.groups")}</p>
    <p>${t("about.ind.compare")}</p>`;
}

function productsAbout(baci, link) {
  const ps = store.meta.products;
  const span = `${ps.periods.A[0]}–${ps.periods.A.at(-1)}`;
  const row = (p) => `<li>${esc(productName(p.id))}: HS ${p.hs.length ? esc(p.hs.join(", ")) : t("about.products.other")}</li>`;
  return `
    <h3>${t("about.products.title")}</h3>
    <p>${t("about.products.text", { baci: link(baci.url, baci.name), span })}</p>
    <details><summary>${t("product.sectors")}</summary><ul>${ps.sectors.map(row).join("")}</ul></details>
    <details><summary>${t("product.commodities")}</summary><ul>${ps.commodities.map(row).join("")}</ul></details>`;
}

// ------------------------------------------------------------------ stories

// "Treat as one" changes made during a story, kept for its later steps (each step sets its own groups).
let groupChoices = null; // {story, on: Set, off: Set}

function choicesFor(story) {
  if (groupChoices?.story !== story) groupChoices = { story, on: new Set(), off: new Set() };
  return groupChoices;
}

function rememberGroupChoice(g, on) {
  const c = choicesFor(activeStory().id);
  (on ? c.on : c.off).add(g);
  (on ? c.off : c.on).delete(g);
}

/** A story step's view, with the reader's group choices applied on top of the step's groups. */
function applyStoryView(view) {
  const c = choicesFor(activeStory()?.id);
  if (!c.on.size && !c.off.size) return applyView(view);
  const groups = new Set(view.groups == null ? DEFAULT_GROUPS : view.groups.split(",").filter((g) => g && g !== "none"));
  for (const g of c.on) groups.add(g);
  for (const g of c.off) groups.delete(g);
  return applyView({ ...view, groups: [...groups].join(",") || "none" });
}

// ------------------------------------------------------------------ views & URL state

/** A view is the shareable state: {product, freq, t, focus, metric, change, groups, with}, all strings. */
async function applyView(view) {
  stopPlay();
  const product = view.product && products().some((p) => p.id === view.product) ? view.product : "TOTAL";
  const freq = view.view !== "compare" && availableFreqs(product).includes(view.freq) ? view.freq : "A";
  if (product !== state.product || freq !== state.freq || !store.periods.length) {
    await setSlice(product, freq);
    Object.assign(state, { product, freq });
    current = null;
    setupTimeline();
  }
  const ti = view.t ? nearestIndex(store.periods, view.t) : -1;
  state.pi = ti >= 0 ? ti : defaultPeriodIndex();
  state.metric = METRICS.includes(view.metric) ? view.metric : "total";
  state.back = [1, 5, 10].includes(+view.change) ? +view.change : 0;
  state.groupsOn = view.groups != null
    ? new Set(view.groups.split(",").filter((g) => store.groupById.has(g)))
    : new Set(DEFAULT_GROUPS);
  state.focus = view.focus && (store.entities[view.focus] || isGroup(view.focus)) ? view.focus : null;
  if (state.focus && isGroup(state.focus)) state.groupsOn.add(state.focus);
  state.pair = state.focus && view.with ? view.with : null;
  state.view = ["compare", "trends"].includes(view.view) ? view.view : "map";
  state.scale = SCALES.includes(view.scale) ? view.scale : "usd";
  state.set = view.set == null ? null
    : view.set === "none" ? [] : view.set.split(",").filter((k) => store.entities[k] || isGroup(k));
  state.sx = view.x || "gdp";
  state.sy = view.y || "exports";
  state.mapBy = view.mapby || "trade";
  state.list = lists().some((l) => l.id === view.list) ? view.list : null;
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
  if (state.list) v.list = state.list;
  if (state.view === "compare") Object.assign(v, { view: "compare", x: state.sx, y: state.sy });
  else if (state.view === "trends") {
    v.view = "trends";
    if (state.scale !== "usd") v.scale = state.scale;
    if (state.set) v.set = state.set.join(",") || "none";
  }
  else if (state.mapBy !== "trade") v.mapby = state.mapBy;
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
  await initI18n();
  try {
    await loadBase();
    await setSlice("TOTAL", "A");
  } catch (e) {
    $("#loading").textContent = t("loadError");
    throw e;
  }
  map = createMap($("#map"), {
    onHover: showTip,
    onMove: moveTip,
    onClick: (key) => setFocus(key),
  });
  scatter = createScatter($("#compare"), {
    onHover: showDotTip,
    onMove: moveTip,
    onClick: (key) => setFocus(key),
  });
  setupControls();
  renderSources();
  initStories({
    applyView: applyStoryView,
    playTo: (t, ms) => playTo(nearestIndex(store.periods, t), ms),
    stopPlay,
    setMarkers: (m) => { markers = m; if (current) renderSpark(); },
    onChange: () => { if (!activeStory()) groupChoices = null; writeHash(); },
    knows: (code) => !!store.entities[code] || isGroup(code),
    focus: (code) => { stopPlay(); setFocus(code); },
    outline: (code) => map.outline(code),
  });
  // Links pasted into the address bar or back/forward (writeHash uses replaceState, which doesn't fire this).
  addEventListener("hashchange", readHash);
  await readHash();
}

boot();
