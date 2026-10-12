import * as d3 from "../vendor/d3.js";
import {
  store, nameOf, shortNameOf, isGroup, metricAt, changeAt, groupOf, membersAt, products, productName, productNameLower,
  groupNote, regionName, listById, listName, listNote, listMembers,
} from "./data.js";
import { periodLabel, yearOf, yearTicks, nearestIndex } from "./time.js";
import { money, ratioPct, share, fmtUnit, escapeHTML as esc } from "./format.js";
import { pearson, describe } from "./stats.js";
import { has, t } from "./i18n.js";

export const METRICS = ["total", "exports", "imports", "balance"];
/** "total trade", "exports", … for use inside a sentence. */
export const metricLabel = (metric) => t(`metricIn.${metric}`);

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
    .call(d3.axisLeft(y).ticks(4).tickFormat((v) => money(v, { compact: true })).tickSizeOuter(0))
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
  const dTxt = d == null ? "" : balance ? money(d, { sign: true, compact: true }) : ratioPct(d);
  // compact values with the currency in the label, so Chinese amounts ("3.58万亿") fit the card
  return `<div class="stat"><div class="k">${t("panel.statLabel", { name: label })}</div><div class="v">${money(v, { compact: true })}</div>
    <div class="d ${cls}">${dTxt}</div></div>`;
}

function stats(s, yi, b) {
  return `<div class="stats">
    ${stat(t("metric.exports"), metricAt(s, yi, "exports"), changeAt(s, yi, "exports", b))}
    ${stat(t("metric.imports"), metricAt(s, yi, "imports"), changeAt(s, yi, "imports", b))}
    ${stat(t("metric.balance"), metricAt(s, yi, "balance"), changeAt(s, yi, "balance", b), { balance: true })}
  </div>
  <p class="note">${t("panel.changeVs", { period: periodLabel(store.periods[yi - b]) })}</p>`;
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
  const names = membersAt(code, yi).map(nameOf);
  const note = groupNote(code);
  return `<div class="members">${t("panel.members", { n: names.length, year: yearOf(store.periods[yi]), names: esc(names.join(t("listSep"))) })}</div>
    ${note ? `<p class="note">${esc(note)}</p>` : ""}
    <p class="note">${t("panel.groupFigures")}</p>`;
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
  return `
    <h3>${t("panel.byProduct", { name: esc(nameOf(ctx.focus)) })}</h3>
    <p class="note">${t(`panel.productShare.${metric}`, { year: at.year })}${at.exact ? "" : t("panel.latestProductYear")} ${t("panel.clickProduct")}</p>
    <ul class="partners products-list">
      ${ctx.product !== "TOTAL" ? `<li data-product="TOTAL" tabindex="0"><span class="rank"></span><span class="nm">← ${esc(productName("TOTAL"))}</span><span class="val"></span></li>` : ""}
      <li class="kind">${t("product.sectors")}</li>${list("sector")}
      <li class="kind">${t("product.commodities")}</li>${list("commodity")}
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
  return `<p class="note">${t(`panel.productOf.${metric}`, { product: `<b>${esc(productName(ctx.product))}</b>`, share: share(v, total), name: esc(nameOf(ctx.focus)), year: at.year })}</p>`;
}

const ECON_ROWS = ["gdp", "gdp_pc", "gdp_growth", "pop", "inflation", "unemployment", "fdi_in", "current_account", "trade_gs_gdp", "exports_gdp"];

/** Year-on-year % changes of exports and of nominal GDP (both current US$), over all years with both. */
function growthPairs(ctx) {
  const ex = ctx.metrics.get("exports"), gdp = ctx.metrics.get("gdp");
  if (!ex || !gdp) return [];
  const out = [];
  for (let y = +ctx.ind.periods[0] + 1; y <= ctx.year; y++) {
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
    return `<h3>${t("econ.title")}</h3><p class="note">${t("econ.none", { name: esc(nameOf(ctx.focus)) })}</p>`;
  }
  const pairs = growthPairs(ctx);
  const r = pearson(pairs.map((p) => p.e), pairs.map((p) => p.g));
  const goods = t("econ.exportsOf", { goods: ctx.product === "TOTAL" ? t("goods") : productNameLower(ctx.product) });
  return `
    <h3>${t("econ.titleYear", { year: ctx.year })}</h3>
    <table class="econ">${rows.filter((r) => r.v != null).map(({ m, v }) =>
      `<tr><td title="${esc(m.description ?? "")}">${esc(m.name)}</td><td>${fmtUnit(v, m.unit)}</td></tr>`).join("")}</table>
    <p class="note">${t(isGroup(ctx.focus) ? "econ.sourceGroup" : "econ.source")}</p>
    ${pairs.length >= 5 ? `
      <h3>${t("econ.growthTitle")}</h3>
      <div class="chart" id="growth-chart"></div>
      <div class="chart-key"><span class="x">${t("econ.pctChange", { what: esc(goods[0].toUpperCase() + goods.slice(1)) })}</span><span class="g">${t("econ.gdpChange")}</span></div>
      <p class="note">${t("econ.growthNote", { from: pairs[0].y, to: pairs.at(-1).y, r: r?.toFixed(2) ?? "—", n: pairs.length, desc: describe(r) })}</p>` : ""}`;
}

function chartKey() {
  return `<div class="chart-key"><span class="x">${t("metric.exports")}</span><span class="m">${t("metric.imports")}</span></div>`;
}

// ------------------------------------------------------------------ highlighted list (e.g. Belt and Road partners)

/** Share of the focus's trade with the list's members, now and in the year before the list started. */
function listSection(ctx) {
  const lst = ctx.list && listById(ctx.list);
  if (!lst || !ctx.focus) return "";
  const name = esc(nameOf(ctx.focus)), list = esc(listName(lst.id));
  const metric = ctx.metric === "balance" ? "total" : ctx.metric;
  const parts = [];
  const members = listMembers(lst.id);
  const withdrawn = (lst.withdrawn ?? []).find((w) => w.id === ctx.focus);
  if (members.has(ctx.focus)) {
    parts.push(t(withdrawn ? "list.memberWithdrawn" : "list.member", { name, list, year: withdrawn?.year,
      source: withdrawn ? `<a href="${esc(withdrawn.source.url)}" target="_blank" rel="noopener">${esc(withdrawn.source.name)}</a>` : "" }));
  }
  if (ctx.listSplit && ctx.focus !== lst.counterpart) {
    // other countries: the counterpart's (China's) share of their trade, from their own partner flows
    const cp = ctx.flows?.p?.[lst.counterpart];
    const shareCp = (i) => {
      const a = metricAt(cp, i, metric);
      const all = metricAt(ctx.listSplit.inList, i, metric) + metricAt(ctx.listSplit.others, i, metric);
      return a == null || !all ? null : a / all;
    };
    const base = nearestIndex(store.periods, String(lst.since - 1));
    const now = cp ? shareCp(ctx.pi) : null, then = cp && base >= 0 && base < ctx.pi ? shareCp(base) : null;
    if (now != null) {
      parts.push(t("list.cpShare", { cp: esc(nameOf(lst.counterpart)), name, metric: metricLabel(metric), share: pctText(now), period: periodLabel(store.periods[ctx.pi]) })
        + (then != null ? ` ${t("list.cpShareBase", { share: pctText(then), period: periodLabel(store.periods[base]) })}` : ""));
    }
  } else if (ctx.listSplit) {
    const share = (i) => {
      const a = metricAt(ctx.listSplit.inList, i, metric), b = metricAt(ctx.listSplit.others, i, metric);
      return a == null || b == null || !(a + b) ? null : a / (a + b);
    };
    const base = nearestIndex(store.periods, String(lst.since - 1));
    const now = share(ctx.pi), then = base >= 0 && base < ctx.pi ? share(base) : null;
    if (now != null) {
      parts.push(t("list.share", { list, name, metric: metricLabel(metric), share: pctText(now), period: periodLabel(store.periods[ctx.pi]) })
        + (then != null ? ` ${t("list.shareBase", { share: pctText(then), period: periodLabel(store.periods[base]) })}` : ""));
    }
  }
  // the list's counterpart as a lender/investor: how much of it is with members
  const bil = ctx.bil;
  if (bil && ctx.focus === lst.counterpart) {
    const at = bilIndex(bil, ctx.year);
    for (const m of at ? bil.measures.filter((x) => x.counterparts.includes(ctx.focus)) : []) {
      let inList = 0, all = 0;
      for (const [e, s] of Object.entries(bil.values[m.id][ctx.focus] ?? {})) {
        const v = s[at.i];
        if (isGroup(e) || v == null || v <= 0) continue;
        all += v;
        if (members.has(e)) inList += v;
      }
      if (all) parts.push(t(`list.${m.id}`, { list, name, amount: money(inList), total: money(all), share: pctText(inList / all), year: at.year }));
    }
  }
  if (!parts.length) return "";
  return `<h3>${list}</h3>${parts.map((p) => `<p class="note">${p}</p>`).join("")}
    <p class="note">${esc(listNote(lst.id))} ${t("list.source", { source: `<a href="${esc(lst.source.url)}" target="_blank" rel="noopener">${esc(lst.source.name)}</a>`, date: lst.source.accessed })}</p>`;
}

/** 48%, 4.5%, and 99.7% rather than a rounded 100%. */
function pctText(r) {
  return `${(r * 100).toFixed(r >= 0.1 && r < 0.99 ? 0 : 1)}%`;
}

// ------------------------------------------------------------------ lending & investment (bilateral.json)

/** Index of `year` in the bilateral periods, or the latest year when `year` is later (the data ends earlier). */
function bilIndex(bil, year) {
  const ps = bil.periods;
  let i = ps.indexOf(String(year));
  if (i < 0 && year > +ps.at(-1)) i = ps.length - 1;
  return i < 0 ? null : { i, year: ps[i], exact: ps[i] === String(year) };
}

/** As a lender/investor: the economies that owe the focus money, and where it has invested. */
function abroadLists(ctx, at) {
  const { bil, focus } = ctx;
  return bil.measures.filter((m) => m.counterparts.includes(focus)).map((m) => {
    const rows = Object.entries(bil.values[m.id][focus] ?? {})
      .filter(([k]) => !isGroup(k))
      .map(([key, s]) => ({ key, v: s[at.i], investor: !!bil.basis[m.id]?.[focus]?.[key] }))
      .filter((r) => r.v > 0)
      .sort((a, b) => b.v - a.v);
    if (!rows.length) return "";
    const total = rows.reduce((sum, r) => sum + r.v, 0);
    const top = rows.slice(0, 10);
    return `
      <h3>${t(`lend.${m.id}.abroad`, { name: esc(nameOf(focus)), year: at.year })}</h3>
      <p class="note">${t(`lend.${m.id}.abroadNote`, { n: rows.length, total: money(total), name: esc(nameOf(focus)) })}</p>
      <ul class="partners lend-list">${top.map((r, i) => `
        <li data-focus="${esc(r.key)}" tabindex="0">
          <span class="rank">${i + 1}</span>
          <span class="nm">${esc(nameOf(r.key))}${r.investor ? " *" : ""}</span>
          <span class="val">${money(r.v)}<span class="share">${share(r.v, total)}</span></span>
          <span class="bar"><i style="width:${(r.v / top[0].v) * 100}%"></i></span>
        </li>`).join("")}</ul>`;
  }).join("");
}

/** As a borrower/host: what the focus owes each lender, and who has invested in it. */
function receivedTable(ctx, at) {
  const { bil, focus } = ctx;
  const measures = bil.measures;
  const cps = [...new Set(measures.flatMap((m) => m.counterparts))].filter((c) => c !== "WLD" && c !== focus);
  const cell = (m, cp) => {
    const v = bil.values[m.id]?.[cp]?.[focus]?.[at.i];
    if (v == null) return "—";
    const total = bil.values[m.id]?.WLD?.[focus]?.[at.i];
    const investor = bil.basis[m.id]?.[cp]?.[focus];
    const pct = cp !== "WLD" && !investor && total > 0 && v >= 0 ? ` <span class="share">${share(v, total)}</span>` : "";
    return `${money(v)}${investor ? " *" : ""}${pct}`;
  };
  const rows = [...cps, "WLD"].filter((cp) => measures.some((m) => bil.values[m.id]?.[cp]?.[focus]?.[at.i] != null));
  if (!rows.length) return "";
  return `
    <h3>${t("lend.received", { name: esc(nameOf(focus)), year: at.year })}</h3>
    <table class="econ lend">
      <tr><th></th>${measures.map((m) => `<th>${t(`lend.${m.id}.col`)}</th>`).join("")}</tr>
      ${rows.map((cp) => `<tr><td>${cp === "WLD" ? t("lend.total") : esc(nameOf(cp))}</td>${measures.map((m) => `<td>${cell(m, cp)}</td>`).join("")}</tr>`).join("")}
    </table>`;
}

function lendingSection(ctx) {
  if (!ctx.bil) return "";
  const at = bilIndex(ctx.bil, ctx.year);
  if (!at) return "";
  const body = abroadLists(ctx, at) + receivedTable(ctx, at);
  if (!body) return "";
  const investorNote = body.includes(" *") ? ` ${t("lend.investorNote")}` : "";
  return `${body}
    <p class="note">${t("lend.note")}${at.exact ? "" : ` ${t("lend.latestYear", { year: at.year })}`}${investorNote}</p>`;
}

/** A panel section that a story step can point at (`panel` in stories/README.md). */
const sec = (id, html) => (html.trim() ? `<div class="psec" data-sec="${id}">${html}</div>` : "");
/** Whose panel this is, pinned to the panel's top on story steps that scroll it to a section (CSS shows it
 *  only under .layout[data-spot]), since the name in the summary is then scrolled away. */
const head = (...parts) => `<div class="panel-head">${parts.filter(Boolean).map(esc).join(" · ")}</div>`;

export function renderPanel(el, ctx) {
  const { focus, pi: yi, metric, compare, label: year } = ctx;
  el.innerHTML = "";

  if (!focus) {
    const rows = topRows(ctx.seriesMap, yi, metric);
    const worldTotal = metricAt(ctx.world, yi, metric === "balance" ? "total" : metric);
    el.innerHTML = head(ctx.product === "TOTAL" ? t("panel.worldTitle") : productName(ctx.product), year) + sec("summary", `
      <div class="kicker">${t("panel.worldKicker", { period: year })}</div>
      <h2>${ctx.product === "TOTAL" ? t("panel.worldTitle") : esc(productName(ctx.product))}</h2>
      <div class="intro">${t("panel.intro")}</div>`) + sec("trade", `
      <h3>${t("panel.worldChart")}</h3>
      <div class="chart" id="p-chart"></div>
      ${chartKey()}`) + sec("partners", `
      <h3>${t("panel.largest", { metric: metricLabel(metric), period: year })}</h3>
      ${rankList(rows, worldTotal, metric)}`);
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
    ? `<p class="note">${t("panel.mirror", { name: esc(nameOf(focus)) })}</p>`
    : "";
  const noData = !ctx.hasData
    ? `<p class="note">${t("panel.noTrade")}</p>` : "";
  const inGroup = !group && groupOf(focus, yi);
  const memberNote = inGroup && ctx.groupsOn.has(inGroup)
    ? `<p class="note">${t("panel.mergedNote", { name: esc(nameOf(inGroup)) })}</p>` : "";
  // Territories that are part of a country (e.g. Hong Kong, Taiwan) say so, and say how to combine them
  // when a group does that; a group can also carry a hint for its core member (the Chinese mainland).
  const mergeable = inGroup && !ctx.groupsOn.has(inGroup);
  const chip = mergeable ? esc(shortNameOf(inGroup)) : "";
  const partOf = ent?.part_of
    ? `<p class="note">${t(mergeable && has(`panel.partOfMerge.${ent.part_of}`) ? `panel.partOfMerge.${ent.part_of}` : `panel.partOf.${ent.part_of}`, { group: chip })}</p>`
    : mergeable && has(`panel.groupHint.${inGroup}`) ? `<p class="note">${t(`panel.groupHint.${inGroup}`, { group: chip })}</p>` : "";

  el.innerHTML = head(nameOf(focus), ctx.product !== "TOTAL" && productName(ctx.product), year) + sec("summary", `
    <div class="kicker">${group ? t("panel.group") : esc(ent?.subregion ? regionName(ent.subregion) : t("panel.economy"))} · ${year}</div>
    <h2>${esc(nameOf(focus))}</h2>
    ${group ? groupBlurb(focus, yi) : ""}${partOf}${ctx.product === "TOTAL" ? mirrorNote : ""}${noData}${memberNote}
    ${productShare(ctx, yi)}
    ${stats(fs, yi, compare)}`) + sec("list", listSection(ctx)) + sec("pair", pair ? `
      <h3>${t("panel.with", { name: esc(nameOf(ctx.pair)) })}</h3>
      <div class="pair-box">
        <div class="row"><span>${t("metric.exports")} ${money(metricAt(pair, yi, "exports"))} · ${t("metric.imports")} ${money(metricAt(pair, yi, "imports"))}</span>
          <button type="button" id="pair-close" aria-label="${t("close")}">✕</button></div>
        <div class="chart" id="pair-chart"></div>
        <div class="row"><span class="note">${t("metric.balance")} ${money(metricAt(pair, yi, "balance"), { sign: true })} · ${t("panel.shareOfTotal", { share: share(metricAt(pair, yi, "total"), metricAt(fs, yi, "total")) })}</span>
          <button type="button" id="pair-focus">${t("panel.focusOn", { name: esc(nameOf(ctx.pair)) })} →</button></div>
      </div>` : "") + sec("trade", `
    <h3>${t(group ? "panel.worldTradeGroup" : "panel.worldTrade")}</h3>
    <div class="chart" id="p-chart"></div>
    ${chartKey()}`) + sec("partners", `
    <h3>${t("panel.topPartners", { metric: metricLabel(metric), period: year })}</h3>
    ${rows.length ? rankList(rows, focusTotal, metric, ctx.pair) : `<p class="note">${t("panel.noPartners", { period: year })}</p>`}
    <p class="note">${t("panel.clickPartner")}</p>`)
    + sec("economy", economySection(ctx)) + sec("lending", lendingSection(ctx)) + sec("products", productsSection(ctx, yi));

  lineChart(el.querySelector("#p-chart"), fs, yi, { intra: group ? ctx.intra : null });
  if (pair) {
    lineChart(el.querySelector("#pair-chart"), pair, yi, { height: 120 });
    el.querySelector("#pair-close").onclick = () => ctx.onPair(null);
    el.querySelector("#pair-focus").onclick = () => ctx.onFocus(ctx.pair);
  }
  bindList(el, ctx.onPair);
  const gc = el.querySelector("#growth-chart");
  if (gc) growthChart(gc, growthPairs(ctx), ctx.year);
  el.querySelectorAll(".lend-list li[data-focus]").forEach((li) => {
    const pick = () => ctx.onFocus(li.dataset.focus);
    li.addEventListener("click", pick);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") pick(); });
  });
  el.querySelectorAll(".products-list li[data-product]").forEach((li) => {
    const pick = () => ctx.onProduct(li.dataset.product);
    li.addEventListener("click", pick);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") pick(); });
  });
}

