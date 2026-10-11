import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";
import { store, nameOf, isGroup, metricAt, changeAt, groupOf, membersAt, products, productName } from "./data.js";
import { periodLabel, yearOf, yearTicks } from "./time.js";
import { money, ratioPct, share, fmtUnit, escapeHTML as esc } from "./format.js";
import { pearson, describe } from "./stats.js";

const METRIC_LABEL = { total: "total trade", exports: "exports", imports: "imports", balance: "trade balance" };

/** Exports/imports line chart over all periods with a marker at the selected one. */
export function lineChart(el, s, pi, { height = 150, intra = null } = {}) {
  const periods = store.periods;
  const W = 320, H = height, m = { t: 8, r: 8, b: 20, l: 44 };
  const svg = d3.select(el).append("svg").attr("viewBox", [0, 0, W, H]);
  const x = d3.scaleLinear([0, periods.length - 1], [m.l, W - m.r]);
  const all = [...s[0], ...s[1], ...(intra ? intra[0] : [])].filter((v) => v != null);
  const y = d3.scaleLinear([0, d3.max(all) || 1], [H - m.b, m.t]).nice();
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).tickValues(yearTicks(periods, 6)).tickFormat((i) => yearOf(periods[i])).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(4).tickFormat((v) => money(v)).tickSizeOuter(0))
    .call((g) => g.select(".domain").remove());
  const line = d3.line().defined((d) => d[1] != null).x((d) => x(d[0])).y((d) => y(d[1]));
  const pts = (arr) => periods.map((_, i) => [i, arr[i]]);
  svg.append("path").attr("class", "line x").attr("d", line(pts(s[0])));
  svg.append("path").attr("class", "line m").attr("d", line(pts(s[1])));
  if (intra) {
    svg.append("path").attr("class", "line x").attr("stroke-dasharray", "3 3").attr("opacity", 0.6)
      .attr("d", line(pts(intra[0])));
  }
  svg.append("line").attr("class", "yr")
    .attr("x1", x(pi)).attr("x2", x(pi)).attr("y1", m.t).attr("y2", H - m.b);
}

function stat(label, v, d, { balance = false } = {}) {
  const cls = d == null ? "" : (balance ? d : d - 1) >= 0 ? "up" : "down";
  const dTxt = d == null ? "" : balance ? money(d, { sign: true }) : ratioPct(d);
  return `<div class="stat"><div class="k">${label}</div><div class="v">${money(v)}</div>
    <div class="d ${cls}">${dTxt}</div></div>`;
}

function stats(s, yi, b) {
  return `<div class="stats">
    ${stat("Exports", metricAt(s, yi, "exports"), changeAt(s, yi, "exports", b))}
    ${stat("Imports", metricAt(s, yi, "imports"), changeAt(s, yi, "imports", b))}
    ${stat("Balance", metricAt(s, yi, "balance"), changeAt(s, yi, "balance", b), { balance: true })}
  </div>
  <p class="note">Change vs. ${periodLabel(store.periods[yi - b])}.</p>`;
}

function rankList(rows, total, metric, active) {
  const max = d3.max(rows, (r) => Math.abs(r.v)) || 1;
  return `<ul class="partners">${rows.map((r, i) => `
    <li data-key="${esc(r.key)}" class="${r.key === active ? "active" : ""}" tabindex="0">
      <span class="rank">${i + 1}</span>
      <span class="nm">${esc(nameOf(r.key))}</span>
      <span class="val">${money(r.v)}${metric !== "balance" ? `<span class="share">${share(r.v, total)}</span>` : ""}</span>
      <span class="bar"><i style="width:${(Math.abs(r.v) / max) * 100}%;${r.v < 0 ? "background:var(--imports)" : ""}"></i></span>
    </li>`).join("")}</ul>`;
}

function topRows(seriesMap, yi, metric, n = 15) {
  return [...seriesMap]
    .map(([key, s]) => ({ key, v: metricAt(s, yi, metric) }))
    .filter((r) => r.v != null && r.v !== 0)
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
    .slice(0, n);
}

function groupBlurb(code, yi) {
  const g = store.groupById.get(code);
  const names = membersAt(code, yi).map((c) => store.entities[c]?.name ?? c);
  return `<div class="members">${names.length} members in ${yearOf(store.periods[yi])}: ${esc(names.join(", "))}</div>
    ${g.note ? `<p class="note">${esc(g.note)}</p>` : ""}
    <p class="note">Figures are trade with countries outside the group. Dashed line: exports between members.</p>`;
}

function bindList(el, onPick) {
  el.querySelectorAll(".partners li[data-key]").forEach((li) => {
    const pick = () => onPick(li.dataset.key);
    li.addEventListener("click", pick);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") pick(); });
  });
}

/** Annual product breakdown: index into the product periods for the selected period's year,
 *  falling back to the latest earlier year (product data ends before the all-goods data). */
function breakdownIndex(yi) {
  const years = store.meta.products?.periods.A ?? [];
  const y = yearOf(store.periods[yi]);
  let i = years.indexOf(String(y));
  if (i < 0 && years.length && y > +years.at(-1)) i = years.length - 1;
  return i < 0 ? null : { i, year: years[i], exact: years[i] === String(y) };
}

function productsSection(ctx, yi) {
  const bd = ctx.breakdown;
  const at = breakdownIndex(yi);
  if (!bd || !at) return "";
  const metric = ctx.metric === "balance" ? "total" : ctx.metric;
  const value = (pid) => metricAt(bd[pid], at.i, metric);
  const all = products();
  const total = all.filter((p) => p.kind === "sector").reduce((sum, p) => sum + (value(p.id) ?? 0), 0);
  if (!total) return "";
  const list = (kind) => {
    const rows = all.filter((p) => p.kind === kind)
      .map((p) => ({ id: p.id, v: value(p.id) }))
      .filter((r) => r.v)
      .sort((a, b) => b.v - a.v);
    const max = d3.max(rows, (r) => r.v) || 1;
    return rows.map((r) => `
      <li data-product="${r.id}" class="${r.id === ctx.product ? "current" : ""}" tabindex="0">
        <span class="rank"></span>
        <span class="nm">${esc(productName(r.id))}</span>
        <span class="val">${money(r.v)}<span class="share">${share(r.v, total)}</span></span>
        <span class="bar"><i style="width:${(r.v / max) * 100}%"></i></span>
      </li>`).join("");
  };
  const word = { exports: "exports", imports: "imports" }[metric] ?? "trade";
  return `
    <h3>What ${esc(nameOf(ctx.focus))} trades, by product</h3>
    <p class="note">Share of ${word} in ${at.year}${at.exact ? "" : " (latest year with product data)"}. Click to map a product.</p>
    <ul class="partners products-list">
      ${ctx.product !== "TOTAL" ? `<li data-product="TOTAL" tabindex="0"><span class="rank"></span><span class="nm">← All goods</span><span class="val"></span></li>` : ""}
      <li class="kind">Sectors</li>${list("sector")}
      <li class="kind">Commodities</li>${list("commodity")}
    </ul>`;
}

/** "Crude oil is 41% of Saudi Arabia's exports (2024)" for a selected product. */
function productShare(ctx, yi) {
  const bd = ctx.breakdown;
  const at = breakdownIndex(yi);
  if (ctx.product === "TOTAL" || !bd || !at) return "";
  const metric = ctx.metric === "imports" ? "imports" : "exports";
  const total = products().filter((p) => p.kind === "sector").reduce((s, p) => s + (metricAt(bd[p.id], at.i, metric) ?? 0), 0);
  const v = metricAt(bd[ctx.product], at.i, metric);
  if (!total || v == null) return "";
  return `<p class="note"><b>${esc(productName(ctx.product))}</b> made up ${share(v, total)} of ${esc(nameOf(ctx.focus))}'s goods ${metric} in ${at.year}.</p>`;
}

const ECON_ROWS = ["gdp", "gdp_pc", "gdp_growth", "pop", "inflation", "unemployment", "fdi_in", "current_account", "trade_gs_gdp", "exports_gdp"];

/** Year-on-year % changes of exports and of nominal GDP (both current US$), over all years with both. */
function growthPairs(ctx) {
  const ex = ctx.metrics.get("exports"), gdp = ctx.metrics.get("gdp");
  if (!ex || !gdp) return [];
  const out = [];
  for (let y = 1991; y <= ctx.year; y++) {
    const e1 = ex.value(ctx.focus, y), e0 = ex.value(ctx.focus, y - 1);
    const g1 = gdp.value(ctx.focus, y), g0 = gdp.value(ctx.focus, y - 1);
    if (e1 > 0 && e0 > 0 && g1 > 0 && g0 > 0) out.push({ y, e: (e1 / e0 - 1) * 100, g: (g1 / g0 - 1) * 100 });
  }
  return out;
}

function growthChart(el, pairs, year) {
  const W = 320, H = 140, m = { t: 8, r: 8, b: 20, l: 36 };
  const svg = d3.select(el).append("svg").attr("viewBox", [0, 0, W, H]);
  const x = d3.scaleLinear(d3.extent(pairs, (p) => p.y), [m.l, W - m.r]);
  const ext = d3.extent(pairs.flatMap((p) => [p.e, p.g]));
  const y = d3.scaleLinear([Math.min(0, ext[0]), Math.max(0, ext[1])], [H - m.b, m.t]).nice();
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).ticks(6, "d").tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(4).tickFormat((v) => `${v}%`).tickSizeOuter(0)).call((g) => g.select(".domain").remove());
  svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(0)).attr("y2", y(0));
  const line = (k) => d3.line().x((p) => x(p.y)).y((p) => y(p[k]))(pairs);
  svg.append("path").attr("class", "line x").attr("d", line("e"));
  svg.append("path").attr("class", "line g").attr("d", line("g"));
  if (year >= pairs[0].y && year <= pairs.at(-1).y) {
    svg.append("line").attr("class", "yr").attr("x1", x(year)).attr("x2", x(year)).attr("y1", m.t).attr("y2", H - m.b);
  }
}

function economySection(ctx) {
  if (!ctx.ind || !ctx.metrics) return "";
  const rows = ECON_ROWS.map((id) => ctx.metrics.get(id)).filter(Boolean)
    .map((m) => ({ m, v: m.value(ctx.focus, ctx.year) }));
  if (!rows.some((r) => r.v != null)) {
    return `<h3>Economy</h3><p class="note">No World Bank indicators for ${esc(nameOf(ctx.focus))}.</p>`;
  }
  const pairs = growthPairs(ctx);
  const r = pearson(pairs.map((p) => p.e), pairs.map((p) => p.g));
  const goods = ctx.product === "TOTAL" ? "goods exports" : `${productName(ctx.product).toLowerCase()} exports`;
  return `
    <h3>Economy, ${ctx.year}</h3>
    <table class="econ">${rows.filter((r) => r.v != null).map(({ m, v }) =>
      `<tr><td title="${esc(m.description ?? "")}">${esc(m.name)}</td><td>${fmtUnit(v, m.unit)}</td></tr>`).join("")}</table>
    <p class="note">Source: World Bank WDI${isGroup(ctx.focus) ? "; group values sum the members of each year" : ""}. Use “Compare” to plot any two of these across countries.</p>
    ${pairs.length >= 5 ? `
      <h3>Do exports move with GDP?</h3>
      <div class="chart" id="growth-chart"></div>
      <div class="chart-key"><span class="x">${esc(goods[0].toUpperCase() + goods.slice(1))}, % change</span><span class="g">GDP, % change</span></div>
      <p class="note">Year-on-year changes, both in current US$, ${pairs[0].y}–${pairs.at(-1).y}: r = ${r?.toFixed(2) ?? "—"} (n = ${pairs.length}), ${describe(r)}. Growth rates are compared rather than levels, because two series that both rise over time always look correlated.</p>` : ""}`;
}

export function renderPanel(el, ctx) {
  const { focus, pi: yi, metric, compare, label: year } = ctx;
  el.innerHTML = "";

  if (!focus) {
    const rows = topRows(ctx.seriesMap, yi, metric);
    const worldTotal = metricAt(ctx.world, yi, metric === "balance" ? "total" : metric);
    el.innerHTML = `
      <div class="kicker">World overview · ${year}</div>
      <h2>${ctx.product === "TOTAL" ? "Global goods trade" : esc(productName(ctx.product))}</h2>
      <div class="intro">
        <p>Click a country or region on the map (or search above) to see who it trades with and how that changed over time.</p>
        <ul>
          <li>Drag the time slider or press ▶ to animate. Switch to Monthly for detail, or open a Story for a guided replay.</li>
          <li>“Treat as one” merges countries into a bloc, e.g. the EU.</li>
          <li>Δ modes color by growth instead of size.</li>
        </ul>
      </div>
      <h3>World exports &amp; imports</h3>
      <div class="chart" id="p-chart"></div>
      <div class="chart-key"><span class="x">Exports</span><span class="m">Imports</span></div>
      <h3>Largest by ${METRIC_LABEL[metric]}, ${year}</h3>
      ${rankList(rows, worldTotal, metric)}`;
    lineChart(el.querySelector("#p-chart"), ctx.world, yi);
    bindList(el, ctx.onFocus);
    return;
  }

  const ent = store.entities[focus];
  const group = isGroup(focus);
  const fs = ctx.focusSeries;
  const focusTotal = metricAt(fs, yi, metric === "balance" ? "total" : metric);
  const rows = topRows(ctx.partners, yi, metric);
  const pair = ctx.pair && ctx.partners.get(ctx.pair);
  const mirrorNote = ent?.mirror
    ? `<p class="note">${esc(ent.name)} is not published as a reporter by the IMF; figures are rebuilt from what its partners report (“mirror” data) and tend to overstate exports.</p>`
    : "";
  const noData = !ctx.hasData
    ? `<p class="note">No reported trade data for this economy.</p>` : "";
  const inGroup = !group && groupOf(focus, yi);
  const memberNote = inGroup && ctx.groupsOn.has(inGroup)
    ? `<p class="note">${esc(nameOf(inGroup))} is merged on the map, so its other members appear as one partner.</p>` : "";

  el.innerHTML = `
    <div class="kicker">${group ? "Group" : esc(ent?.subregion ?? "Economy")} · ${year}</div>
    <h2>${esc(nameOf(focus))}</h2>
    ${group ? groupBlurb(focus, yi) : ""}${ctx.product === "TOTAL" ? mirrorNote : ""}${noData}${memberNote}
    ${productShare(ctx, yi)}
    ${stats(fs, yi, compare)}
    ${pair ? `
      <h3>With ${esc(nameOf(ctx.pair))}</h3>
      <div class="pair-box">
        <div class="row"><span>Exports ${money(metricAt(pair, yi, "exports"))} · Imports ${money(metricAt(pair, yi, "imports"))}</span>
          <button type="button" id="pair-close" aria-label="Close">✕</button></div>
        <div class="chart" id="pair-chart"></div>
        <div class="row"><span class="note">Balance ${money(metricAt(pair, yi, "balance"), { sign: true })} · ${share(metricAt(pair, yi, "total"), metricAt(fs, yi, "total"))} of total trade</span>
          <button type="button" id="pair-focus">Focus on ${esc(nameOf(ctx.pair))} →</button></div>
      </div>` : ""}
    <h3>Trade with the world${group ? " (extra-group)" : ""}</h3>
    <div class="chart" id="p-chart"></div>
    <div class="chart-key"><span class="x">Exports</span><span class="m">Imports</span></div>
    <h3>Top partners by ${METRIC_LABEL[metric]}, ${year}</h3>
    ${rows.length ? rankList(rows, focusTotal, metric, ctx.pair) : `<p class="note">No partner data for ${year}.</p>`}
    <p class="note">Click a partner to compare over time.</p>
    ${economySection(ctx)}
    ${productsSection(ctx, yi)}`;

  lineChart(el.querySelector("#p-chart"), fs, yi, { intra: group ? ctx.intra : null });
  if (pair) {
    lineChart(el.querySelector("#pair-chart"), pair, yi, { height: 120 });
    el.querySelector("#pair-close").onclick = () => ctx.onPair(null);
    el.querySelector("#pair-focus").onclick = () => ctx.onFocus(ctx.pair);
  }
  bindList(el, ctx.onPair);
  const gc = el.querySelector("#growth-chart");
  if (gc) growthChart(gc, growthPairs(ctx), ctx.year);
  el.querySelectorAll(".products-list li[data-product]").forEach((li) => {
    const pick = () => ctx.onProduct(li.dataset.product);
    li.addEventListener("click", pick);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") pick(); });
  });
}

export { METRIC_LABEL };
