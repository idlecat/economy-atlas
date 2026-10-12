// Trends view: trade over time as line charts instead of a map.
//   With a focus: its exports, imports and balance, and its top partners (one line each).
//   Always: a set of economies side by side, which the reader can edit.
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";
import { store, metricAt, nameOf, shortNameOf, isGroup, productName, productNameLower } from "./data.js";
import { periodLabel, yearOf, yearTicks } from "./time.js";
import { money, escapeHTML as esc } from "./format.js";
import { t } from "./i18n.js";
import { metricLabel } from "./panel.js";

const TOP_PARTNERS = 8;
export const DEFAULT_SET_SIZE = 6;
export const SCALES = ["usd", "log", "share"];

/** Values of a metric over all periods, transformed for the scale ("share" divides by `base`'s same metric). */
function valuesOf(s, metric, scale, base) {
  return store.periods.map((_, i) => {
    const v = metricAt(s, i, metric);
    if (v == null) return null;
    if (scale === "share") {
      const b = metricAt(base, i, metric);
      return b ? (v / b) * 100 : null;
    }
    return v;
  });
}

/** Top partners at period index `pi`, by the size of the metric there. */
function topPartners(partners, pi, metric) {
  return [...partners]
    .map(([key, s]) => ({ key, s, v: metricAt(s, pi, metric) }))
    .filter((r) => r.v != null && r.v !== 0)
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
    .slice(0, TOP_PARTNERS);
}

/** Default set: the largest economies (as displayed, so merged groups count as one) at period index `pi`. */
export function defaultSet(displayed, pi) {
  return [...displayed]
    .map(([key, s]) => ({ key, v: metricAt(s, pi, "total") }))
    .filter((r) => r.v != null)
    .sort((a, b) => b.v - a.v)
    .slice(0, DEFAULT_SET_SIZE)
    .map((r) => r.key);
}

/**
 * ctx: {pi, metric, scale, focus, focusSeries, partners: Map, pair, set: [keys], world,
 *       onPair(key), onFocus(key), onSetChange(keys), findEntity(text) -> key|null}
 */
export function renderTrends(el, ctx) {
  const scroll = el.scrollTop;
  const { focus, metric } = ctx;
  // share of a balance means nothing; log needs positive values
  const scale = metric === "balance" ? "usd" : ctx.scale;
  const what = metricLabel(metric);
  const period = periodLabel(store.periods[ctx.pi]);
  const unitNote = (shareKey, vars = {}) => t(scale === "share" ? shareKey : scale === "log" ? "trends.unitLog" : "trends.unitUsd", vars);
  const sections = [];

  if (focus) {
    const name = esc(nameOf(focus));
    sections.push(`
      <section class="trend">
        <h3>${t(`trends.focusTitle${isGroup(focus) ? "Group" : ""}${store.product === "TOTAL" ? "" : "Product"}`, { name, product: esc(productNameLower(store.product)) })}</h3>
        <p class="note">${t(scale === "log" ? "trends.unitLog" : "trends.unitUsd")}</p>
        <div class="trend-chart" id="tr-focus"></div>
      </section>
      <section class="trend">
        <h3>${t("trends.partnersTitle", { name, n: TOP_PARTNERS, metric: what, period })}</h3>
        <p class="note">${unitNote("trends.unitShareFocus", { name })} ${t("trends.partnersNote", { name })}</p>
        <div class="trend-chart" id="tr-partners"></div>
      </section>`);
  } else {
    sections.push(`<p class="note trend-hint">${t("trends.noFocusHint")}</p>`);
  }
  const chips = ctx.set.map((k) => `<span class="chip set-chip" aria-pressed="true">${esc(shortNameOf(k))}<button type="button" data-remove="${esc(k)}" aria-label="${esc(t("trends.remove", { name: nameOf(k) }))}">×</button></span>`).join("");
  sections.push(`
    <section class="trend">
      <h3>${t("trends.setTitle", { metric: what })}</h3>
      <div class="set-edit">${chips}
        <input type="search" list="entity-list" class="set-add" placeholder="${esc(t("trends.add"))}" aria-label="${esc(t("trends.add"))}">
        <button type="button" class="linklike" data-reset>${t("trends.reset", { n: DEFAULT_SET_SIZE })}</button>
      </div>
      <p class="note">${unitNote("trends.unitShareWorld")} ${t("trends.setNote")}</p>
      ${ctx.set.length ? `<div class="trend-chart" id="tr-set"></div>` : `<p class="note">${t("trends.empty")}</p>`}
    </section>`);
  el.innerHTML = sections.join("");

  const palette = d3.schemeTableau10;
  if (focus) {
    const fs = ctx.focusSeries;
    const lines = [
      { key: "x", label: t("metric.exports"), color: "var(--exports)", values: valuesOf(fs, "exports", "usd") },
      { key: "m", label: t("metric.imports"), color: "var(--imports)", values: valuesOf(fs, "imports", "usd") },
    ];
    if (scale !== "log") lines.push({ key: "b", label: t("metric.balance"), color: "var(--muted)", dash: true, values: valuesOf(fs, "balance", "usd") });
    multiLine(el.querySelector("#tr-focus"), { lines, pi: ctx.pi, log: scale === "log", pct: false, height: 220 });

    const top = topPartners(ctx.partners, ctx.pi, metric);
    multiLine(el.querySelector("#tr-partners"), {
      lines: top.map((r, i) => ({
        key: r.key, label: shortNameOf(r.key), color: palette[i % palette.length], strong: r.key === ctx.pair,
        values: valuesOf(r.s, metric, scale, fs),
      })),
      pi: ctx.pi, log: scale === "log", pct: scale === "share", height: 300, onClick: ctx.onPair,
    });
  }
  if (ctx.set.length) {
    multiLine(el.querySelector("#tr-set"), {
      lines: ctx.set.map((k, i) => ({
        key: k, label: shortNameOf(k), color: palette[i % palette.length], strong: k === focus,
        values: valuesOf(store.totals[k], metric, scale, ctx.world),
      })),
      pi: ctx.pi, log: scale === "log", pct: scale === "share", height: 300, onClick: ctx.onFocus,
    });
  }

  // set editing
  el.querySelectorAll("[data-remove]").forEach((b) => {
    b.onclick = () => ctx.onSetChange(ctx.set.filter((k) => k !== b.dataset.remove));
  });
  el.querySelector("[data-reset]").onclick = () => ctx.onSetChange(null);
  const add = el.querySelector(".set-add");
  const pick = () => {
    const key = ctx.findEntity(add.value);
    if (key && !ctx.set.includes(key)) ctx.onSetChange([...ctx.set, key]);
    else add.value = "";
  };
  add.addEventListener("change", pick);
  add.addEventListener("keydown", (e) => { if (e.key === "Enter") pick(); });
  el.scrollTop = scroll;
}

/**
 * Multi-line chart over store.periods with labels at the line ends, a marker at the selected period
 * and a hover readout of every line's value.
 * lines: [{key, label, color, values[], dash?, strong?}]
 */
function multiLine(el, { lines, pi, log, pct, height, onClick = null }) {
  const periods = store.periods;
  const W = Math.max(280, el.clientWidth), H = height;
  const narrow = W < 520;
  const m = { t: 10, r: narrow ? 74 : 112, b: 22, l: 52 };
  const ok = (v) => v != null && (!log || v > 0);
  const all = lines.flatMap((l) => l.values.filter(ok));
  const svg = d3.select(el).append("svg").attr("viewBox", [0, 0, W, H]).attr("class", "trend-svg");
  if (!all.length) {
    svg.append("text").attr("x", W / 2).attr("y", H / 2).attr("text-anchor", "middle").attr("class", "empty").text(t("legend.noData"));
    return;
  }
  const x = d3.scaleLinear([0, periods.length - 1], [m.l, W - m.r]);
  const [lo, hi] = d3.extent(all);
  const y = log
    ? d3.scaleLog([lo / 1.15, hi * 1.15], [H - m.b, m.t])
    : d3.scaleLinear([Math.min(0, lo), Math.max(0, hi)], [H - m.b, m.t]).nice();
  const fmt = (v) => (pct ? `${+v.toFixed(v >= 10 ? 0 : 1)}%` : money(v, { compact: true }));
  const yTicks = log ? y.ticks(5).filter((v) => /^(1|2|5)(\.0+)?e/.test(v.toExponential())).slice(-6) : y.ticks(5);

  svg.append("g").attr("class", "grid").selectAll("line").data(yTicks).join("line")
    .attr("x1", m.l).attr("x2", W - m.r).attr("y1", y).attr("y2", y);
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).tickValues(yearTicks(periods, narrow ? 4 : 8)).tickFormat((i) => yearOf(periods[i])).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).tickValues(yTicks).tickFormat(fmt).tickSizeOuter(0))
    .call((g) => g.select(".domain").remove());
  if (!log && y.domain()[0] < 0) {
    svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(0)).attr("y2", y(0));
  }
  svg.append("line").attr("class", "yr").attr("x1", x(pi)).attr("x2", x(pi)).attr("y1", m.t).attr("y2", H - m.b);

  const line = d3.line().defined((d) => ok(d[1])).x((d) => x(d[0])).y((d) => y(d[1]));
  const g = svg.append("g");
  for (const l of lines) {
    const pts = l.values.map((v, i) => [i, v]);
    g.append("path").attr("class", `tl${l.strong ? " strong" : ""}`).attr("d", line(pts))
      .style("stroke", l.color).attr("stroke-dasharray", l.dash ? "4 3" : null);
  }

  // end labels at each line's last value, nudged apart so they don't overlap
  const ends = lines.map((l) => {
    let i = l.values.length - 1;
    while (i >= 0 && !ok(l.values[i])) i--;
    return i < 0 ? null : { l, i, y: y(l.values[i]) };
  }).filter(Boolean).sort((a, b) => a.y - b.y);
  // push down to keep 12px apart, then back up from the bottom edge, so all stay inside the plot
  for (let k = 1; k < ends.length; k++) ends[k].y = Math.max(ends[k].y, ends[k - 1].y + 12);
  for (let k = ends.length - 1; k >= 0; k--) ends[k].y = Math.min(ends[k].y, k === ends.length - 1 ? H - m.b : ends[k + 1].y - 12);
  svg.append("g").attr("class", "end-labels").selectAll("text").data(ends).join("text")
    .attr("x", (e) => x(e.i) + 5).attr("y", (e) => e.y + 4)
    .style("fill", (e) => e.l.color).attr("font-weight", (e) => (e.l.strong ? 700 : 500))
    .text((e) => (narrow && e.l.label.length > 10 ? `${e.l.label.slice(0, 9)}…` : e.l.label))
    .style("cursor", onClick ? "pointer" : null)
    .on("click", onClick ? (_, e) => onClick(e.l.key) : null);

  // hover readout
  const tip = d3.select(el).append("div").attr("class", "trend-tip").attr("hidden", true);
  const cursor = svg.append("line").attr("class", "cursor").attr("y1", m.t).attr("y2", H - m.b).attr("visibility", "hidden");
  const indexAt = (px) => Math.max(0, Math.min(periods.length - 1, Math.round(x.invert(px))));
  svg.append("rect").attr("class", "hover").attr("x", m.l).attr("y", m.t).attr("width", W - m.l - m.r).attr("height", H - m.t - m.b)
    .style("cursor", onClick ? "pointer" : null)
    // a click picks the line nearest to the pointer at that period
    .on("click", onClick ? (ev) => {
      const [px, py] = d3.pointer(ev);
      const i = indexAt(px);
      const near = d3.least(lines.filter((l) => ok(l.values[i])), (l) => Math.abs(y(l.values[i]) - py));
      if (near && Math.abs(y(near.values[i]) - py) < 24) onClick(near.key);
    } : null)
    .on("pointermove", (ev) => {
      const [px] = d3.pointer(ev);
      const i = indexAt(px);
      cursor.attr("x1", x(i)).attr("x2", x(i)).attr("visibility", "visible");
      const rows = lines.filter((l) => l.values[i] != null).sort((a, b) => b.values[i] - a.values[i]);
      tip.attr("hidden", null).html(`<b>${periodLabel(periods[i])}</b>${rows.map((l) =>
        `<div><i style="background:${l.color}"></i>${esc(l.label)}<span>${pct ? fmt(l.values[i]) : money(l.values[i], { sign: l.key === "b" })}</span></div>`).join("")}`);
      const left = (x(i) / W) * el.clientWidth;
      tip.style("left", `${left > el.clientWidth / 2 ? left - tip.node().offsetWidth - 12 : left + 12}px`);
    })
    .on("pointerleave", () => { cursor.attr("visibility", "hidden"); tip.attr("hidden", true); });
}
