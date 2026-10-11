import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";
import {
  store, loadBase, loadFlows, hasFlows, nameOf, shortNameOf, isGroup, partnerSeries,
  displayTotals, worldSeries, metricAt, changeAt, defaultYearIndex, emptySeries,
} from "./data.js";
import { createMap } from "./map.js";
import { renderPanel, lineChart, METRIC_LABEL } from "./panel.js";
import { money, ratioPct, share, escapeHTML as esc } from "./format.js";

const $ = (s) => document.querySelector(s);
const dark = matchMedia("(prefers-color-scheme: dark)");

const state = {
  focus: null,
  yi: 0,
  metric: "total",
  back: 0,
  groupsOn: new Set(["EU"]),
  pair: null,
};

let map, current = null, playTimer = null, updateToken = 0;

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
    const pos = (v) => toUnit(v);
    return {
      color: s, kind: "diverging", pos, fmt: (v) => money(v, { sign: true }),
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
  return state.back ? changeAt(s, i, state.metric, state.back) : metricAt(s, i, state.metric);
}

// ------------------------------------------------------------------ main update

async function update() {
  const token = ++updateToken;
  const { focus, yi, metric, back, groupsOn } = state;
  let seriesMap, focusSeries = null, intra = null;

  if (focus) {
    const flows = await loadFlows(focus);
    if (token !== updateToken) return;
    seriesMap = partnerSeries(flows, focus, groupsOn);
    focusSeries = store.totals[focus] ?? emptySeries();
    intra = flows.intra ?? null;
  } else {
    seriesMap = displayTotals(groupsOn);
  }
  $("#loading").hidden = true;

  // Fixed color domain across all years, so animation shows real change.
  const scaleKey = [focus, metric, back, [...groupsOn].sort(), dark.matches].join("|");
  if (!current || current.scaleKey !== scaleKey) {
    const all = [];
    for (const s of seriesMap.values()) {
      for (let i = back; i < store.years.length; i++) {
        const v = back ? changeAt(s, i, metric, back) : metricAt(s, i, metric);
        if (v != null) all.push(v);
      }
    }
    current = { scaleKey, scale: buildScale(all, metric, back) };
  }
  Object.assign(current, { seriesMap, focusSeries, intra });

  const values = new Map();
  for (const [k, s] of seriesMap) values.set(k, valueAt(s, yi));
  const colorOf = (k) => {
    const v = values.get(k);
    return v == null ? null : current.scale.color(v);
  };

  map.render({ focus, yi, groupsOn, colorOf, arcs: focus ? buildArcs(seriesMap) : [] });
  renderLegend();
  renderTitle();
  renderSpark();
  renderPanel($("#panel"), {
    focus, yi, metric, back, year: store.years[yi], groupsOn,
    seriesMap, partners: seriesMap, focusSeries, intra, pair: state.pair,
    world: worldSeries(), hasData: !focus || hasFlows(focus),
    onFocus: setFocus,
    onPair: (k) => { state.pair = state.pair === k ? null : k; update(); },
  });
  writeHash();
}

function buildArcs(partners) {
  const { focus, yi, metric } = state;
  const rows = [...partners]
    .map(([key, s]) => ({ key, s, v: metricAt(s, yi, metric) }))
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
  const { focus, metric, back, yi } = state;
  const y = store.years[yi];
  const what = METRIC_LABEL[metric];
  const prep = { exports: "to", imports: "from" }[metric] ?? "with";
  const head = focus
    ? `${esc(nameOf(focus))}: ${what} ${prep} each partner, ${y}`
    : `${what[0].toUpperCase() + what.slice(1)} ${prep} the world, ${y}`;
  const sub = back
    ? `Change since ${store.years[yi - back] ?? "—"} · goods, current US$`
    : "Goods, current US$";
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
  const stops = d3.range(0, 1.0001, 0.05);
  const samples = sampleScale(sc);
  grad.selectAll("stop").data(stops).join("stop")
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
  const ticks = sc.ticks;
  const lo = ticks[0], hi = ticks.at(-1);
  if (sc.kind === "ratio") return (t) => sc.color(2 ** (t * 4 - 2));
  if (sc.kind === "diverging") {
    return (t) => {
      let a = lo, b = hi;
      for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (sc.pos(m) < t) a = m; else b = m; }
      return sc.color((a + b) / 2);
    };
  }
  return (t) => {
    // sequential log: pos is linear in log(v)
    const p0 = sc.pos(lo), p1 = sc.pos(hi);
    const lv = Math.log(lo) + ((t - p0) / (p1 - p0 || 1)) * (Math.log(hi) - Math.log(lo));
    return sc.color(Math.exp(lv)) ?? "transparent";
  };
}

function renderSpark() {
  const s = state.focus ? current.focusSeries : worldSeries();
  const el = $("#spark");
  el.innerHTML = "";
  const W = el.clientWidth || 600, H = 34;
  const vals = store.years.map((_, i) => metricAt(s, i, "total"));
  const x = d3.scaleLinear([0, store.years.length - 1], [8, W - 8]);
  const y = d3.scaleLinear([0, d3.max(vals) || 1], [H - 2, 4]);
  const svg = d3.select(el).append("svg").attr("viewBox", [0, 0, W, H]).attr("preserveAspectRatio", "none");
  const area = d3.area().defined((v) => v != null).x((_, i) => x(i)).y0(H).y1((v) => y(v));
  svg.append("path").attr("class", "area").attr("d", area(vals));
  svg.append("path").attr("class", "ln").attr("d", area.lineY1()(vals));
  svg.append("circle").attr("cx", x(state.yi)).attr("cy", y(vals[state.yi] ?? 0)).attr("r", 3).attr("fill", "var(--accent)");
  svg.append("text").attr("x", 8).attr("y", 11).text(`${state.focus ? esc(nameOf(state.focus)) : "World"} total trade`);
}

// ------------------------------------------------------------------ tooltip

const tip = $("#tooltip");

function showTip(key, ev, feature) {
  if (!key) { tip.hidden = true; return; }
  const { focus, yi } = state;
  const y = store.years[yi];
  let body;
  if (key === focus || (feature?.id === focus)) {
    body = `<h4>${esc(nameOf(focus))}</h4><div class="sub">Selected · ${y}</div>`;
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
        <div class="sub">with ${esc(nameOf(focus))}, ${y}</div>
        <table>
          <tr><td>${fn} exports to</td><td>${money(metricAt(s, yi, "exports"))}</td></tr>
          <tr><td>${fn} imports from</td><td>${money(metricAt(s, yi, "imports"))}</td></tr>
          <tr><td>Balance</td><td>${money(metricAt(s, yi, "balance"), { sign: true })}</td></tr>
          <tr><td>Share of ${fn}'s trade</td><td>${share(metricAt(s, yi, "total"), metricAt(fs, yi, "total")) || "—"}</td></tr>
          ${changeRow(s)}
        </table>
        <div class="chart" id="tip-chart"></div>
        <div class="hint">Click to focus on ${esc(name)}</div>`;
    } else {
      body = `<h4>${esc(name)}${memberOf}</h4>
        <div class="sub">${isGroup(key) ? "Trade with non-members" : "Trade with the world"}, ${y}</div>
        <table>
          <tr><td>Exports</td><td>${money(metricAt(s, yi, "exports"))}</td></tr>
          <tr><td>Imports</td><td>${money(metricAt(s, yi, "imports"))}</td></tr>
          <tr><td>Balance</td><td>${money(metricAt(s, yi, "balance"), { sign: true })}</td></tr>
          ${changeRow(s)}
        </table>
        <div class="chart" id="tip-chart"></div>
        <div class="hint">Click to see trading partners</div>`;
    }
  }
  tip.innerHTML = body;
  const chartEl = tip.querySelector("#tip-chart");
  const s = current?.seriesMap.get(key);
  if (chartEl && s) lineChart(chartEl, s, yi, { height: 90 });
  tip.hidden = false;
  moveTip(ev);
}

function changeRow(s) {
  const b = state.back || 1;
  const metric = state.metric === "balance" ? "total" : state.metric;
  const r = changeAt(s, state.yi, metric, b);
  return `<tr><td>${METRIC_LABEL[metric]} vs ${store.years[state.yi - b] ?? "—"}</td><td class="${r == null ? "" : r >= 1 ? "up" : "down"}">${ratioPct(r)}</td></tr>`;
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

function setYear(i) {
  state.yi = Math.max(0, Math.min(store.years.length - 1, i));
  $("#year").value = store.years[state.yi];
  $("#year-label").textContent = store.years[state.yi];
  update();
}

function togglePlay() {
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = null;
    $("#play").textContent = "▶";
    return;
  }
  if (state.yi >= store.years.length - 1) setYear(0);
  $("#play").textContent = "❚❚";
  playTimer = setInterval(() => {
    if (state.yi >= store.years.length - 1) return togglePlay();
    setYear(state.yi + 1);
  }, 700);
}

function syncControls() {
  for (const b of document.querySelectorAll("#metric button")) b.setAttribute("aria-checked", b.dataset.v === state.metric);
  for (const b of document.querySelectorAll("#mode button")) b.setAttribute("aria-checked", +b.dataset.v === state.back);
  for (const b of document.querySelectorAll("#group-chips .chip")) b.setAttribute("aria-pressed", state.groupsOn.has(b.dataset.g));
  $("#world-btn").disabled = !state.focus;
  $("#year").value = store.years[state.yi];
  $("#year-label").textContent = store.years[state.yi];
}

function setupControls() {
  const yearInput = $("#year");
  yearInput.min = store.years[0];
  yearInput.max = store.years.at(-1);
  yearInput.addEventListener("input", () => setYear(store.years.indexOf(+yearInput.value)));
  $("#play").addEventListener("click", togglePlay);

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
    if (e.key === "ArrowLeft") setYear(state.yi - 1);
    else if (e.key === "ArrowRight") setYear(state.yi + 1);
    else if (e.key === " ") { e.preventDefault(); togglePlay(); }
    else if (e.key === "Escape") setFocus(null);
  });

  $("#about-btn").addEventListener("click", () => $("#about").showModal());
  dark.addEventListener("change", () => { current = null; update(); });
  new ResizeObserver(() => current && renderSpark()).observe($("#spark"));
}

// ------------------------------------------------------------------ sources

function renderSources() {
  const src = Object.fromEntries(store.meta.sources.map((s) => [s.id, s]));
  const { imf_imts: imf, un_m49: m49, natural_earth: ne } = src;
  $("#source-line").innerHTML = `Source: <a href="${imf.url}" target="_blank" rel="noopener">IMF, International Trade in Goods by partner country (IMTS)</a>, accessed ${imf.accessed}.
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
    <p>Bilateral merchandise (goods) trade from the <a href="${imf.url}" target="_blank" rel="noopener">${esc(imf.name)}</a>, formerly the ${esc(imf.formerly)}. Annual data, ${store.years[0]}–${store.years.at(-1)}, in current US dollars (not adjusted for inflation). Services trade is not included.</p>
    <ul>
      <li>Exports: <code>${esc(imf.series.exports)}</code></li>
      <li>Imports: <code>${esc(imf.series.imports)}</code></li>
    </ul>
    <p>Each country's figures are <b>as reported by that country</b> (the selected focus). Because exports are valued FOB and imports CIF, and because of timing, re-exports and confidentiality, A's reported exports to B rarely equal B's reported imports from A. The IMF fills gaps for non-reporting economies with estimates derived from partner data. Taiwan is not published as a reporter by the IMF, so its figures here are built from partners' reports ("mirror" data). The latest years may be revised.</p>
    <h3>Groupings</h3>
    <p>When a grouping is “treated as one”, its members' flows are summed and trade <i>between</i> members is excluded, so the group is shown trading only with the outside world. Membership is applied as of each year: for example, the UK is part of the EU through 2020 and Croatia from 2013. Groups are defined from <a href="${m49.url}" target="_blank" rel="noopener">UN M49 regions</a> or explicit member lists:</p>
    <ul>${groups}</ul>
    <h3>Change modes</h3>
    <p>Δ 1/5/10 yr colors each partner by the ratio between the selected year and the earlier year (shown as % change, log scale from −75% to +300%). For the balance metric, change is the difference in US dollars.</p>
    <h3>Map</h3>
    <p>Boundaries from Natural Earth (1:50m, public domain) via the world-atlas package. Their use does not imply any position on the legal status of any territory. Areas with no matching trade data are grey.</p>
    <h3>Citation</h3>
    <p>${esc(imf.citation)}</p>
    <p>Terms of use for IMF data: <a href="${imf.terms}" target="_blank" rel="noopener">${imf.terms}</a>.</p>
    <p class="note">Data files generated ${store.meta.generated} by <code>scripts/build_data.py</code>.</p>`;
}

// ------------------------------------------------------------------ URL state

function writeHash() {
  const p = new URLSearchParams();
  if (state.focus) p.set("focus", state.focus);
  p.set("year", store.years[state.yi]);
  if (state.metric !== "total") p.set("metric", state.metric);
  if (state.back) p.set("change", state.back);
  p.set("groups", [...state.groupsOn].join(",") || "none");
  if (state.pair) p.set("with", state.pair);
  history.replaceState(null, "", `#${p}`);
}

function readHash() {
  Object.assign(state, { focus: null, yi: defaultYearIndex(), metric: "total", back: 0, groupsOn: new Set(["EU"]), pair: null });
  const p = new URLSearchParams(location.hash.slice(1));
  const yr = store.years.indexOf(+p.get("year"));
  if (yr >= 0) state.yi = yr;
  if (METRIC_LABEL[p.get("metric")]) state.metric = p.get("metric");
  if ([1, 5, 10].includes(+p.get("change"))) state.back = +p.get("change");
  if (p.has("groups")) {
    state.groupsOn = new Set(p.get("groups").split(",").filter((g) => store.groupById.has(g)));
  }
  const f = p.get("focus");
  if (f && (store.entities[f] || store.groupById.has(f))) {
    state.focus = f;
    if (isGroup(f)) state.groupsOn.add(f);
  }
  const w = p.get("with");
  if (w && state.focus) state.pair = w;
}

// ------------------------------------------------------------------ boot

async function boot() {
  try {
    await loadBase();
  } catch (e) {
    $("#loading").textContent = "Could not load data files. If you opened index.html directly, serve the site folder over HTTP instead.";
    throw e;
  }
  readHash();
  map = createMap($("#map"), {
    onHover: showTip,
    onMove: moveTip,
    onClick: (key) => setFocus(key === state.focus ? state.focus : key),
  });
  setupControls();
  renderSources();
  syncControls();
  // Links pasted into the address bar or back/forward (writeHash uses replaceState, which doesn't fire this).
  addEventListener("hashchange", () => { readHash(); syncControls(); update(); });
  await update();
}

boot();
