// Head to head: a story generated for any two economies the reader picks. Its steps are built from
// the site's data when it starts (indicators.json, annual totals and flows), so every figure it quotes
// is computed, not written. Story id: "vs-<A>-<B>", e.g. vs-CHN-USA (shareable as #story=vs-CHN-USA).
import * as d3 from "../vendor/d3.js";
import {
  store, nameOf, shortNameOf, isGroup, hasFlows, loadFlows, loadTotals, loadIndicators, metricAt,
} from "./data.js";
import { buildMetrics } from "./metrics.js";
import { money, fmtUnit, share, escapeHTML as esc } from "./format.js";
import { t } from "./i18n.js";

const DEFAULT_GROUPS = ["EU"];
export const COLORS = d3.schemeTableau10.slice(0, 2); // the same colors as the Trends view's set lines
const CARD_ROWS = ["gdp", "pop", "gdp_pc", "gdp_growth", "exports", "inflation", "unemployment", "life_exp", "hdi", "co2_pc"];

export function versusId(a, b) {
  return `vs-${a}-${b}`;
}

/** [A, B] from a story id, or null. */
export function parseVersusId(id) {
  const m = /^vs-([A-Z][A-Z0-9_]{1,9})-([A-Z][A-Z0-9_]{1,9})$/.exec(id ?? "");
  return m && m[1] !== m[2] ? [m[1], m[2]] : null;
}

const known = (code) => !!store.entities[code] || isGroup(code);

/** Groups this entity has ever belonged to (so it is never drawn merged into one). */
function groupsOfEntity(code) {
  return (store.entities[code]?.groups ?? []).map((s) => s.g);
}

/** Entity ids to outline on the map and in Compare: the two economies, and a group's members of any year. */
function marksOf(codes) {
  const out = new Set(codes);
  for (const c of codes) for (const m of store.groupById.get(c)?.members ?? []) out.add(m.id);
  return out;
}

/** "×5.2" / "5.2倍" */
const times = (r) => t("vs.times", { n: r >= 10 ? r.toFixed(0) : r.toFixed(1) });

/**
 * The story for economies a and b, or null if either is unknown or there is nothing to compare.
 * Steps are left out when either economy lacks the data (e.g. no development indicators for groups).
 */
export async function buildVersus(a, b) {
  if (!known(a) || !known(b) || a === b) return null;
  const [ind, annual] = await Promise.all([loadIndicators(), loadTotals("TOTAL", "A")]);
  const tPeriods = store.meta.periods.A;
  const metrics = buildMetrics(ind, annual, tPeriods, "TOTAL");
  const years = d3.range(
    Math.min(+tPeriods[0], +(ind?.periods[0] ?? Infinity)),
    Math.max(+tPeriods.at(-1), +(ind?.periods.at(-1) ?? -Infinity)) + 1);
  const pair = [a, b];
  const value = (id, k, y) => metrics.get(id)?.value(k, y) ?? null;
  const both = (id) => years.filter((y) => value(id, a, y) != null && value(id, b, y) != null);
  const fmt = (id, v, opts) => fmtUnit(v, metrics.get(id).unit, opts);
  const link = (k) => `[${nameOf(k)}](${k})`;
  const L = { a: link(a), b: link(b) };

  // nothing of either is merged into a group, and a group that is compared is drawn as one
  const groups = new Set(DEFAULT_GROUPS);
  for (const k of pair) {
    for (const g of groupsOfEntity(k)) groups.delete(g);
    if (isGroup(k)) groups.add(k);
  }
  const base = { groups: [...groups].join(",") || "none" };
  const replay = (y0, y1) => ({ to: String(y1), ms: Math.max(180, Math.min(450, 9000 / Math.max(1, y1 - y0))) });
  const chart = (id, opts = {}) => figureChart({ metric: metrics.get(id), pair, years, ...opts });
  const steps = [];

  // 1. size of the economy (GDP, current US$), with a guess first
  const gy = both("gdp");
  if (gy.length >= 2) {
    const [y0, y1] = [gy[0], gy.at(-1)];
    const v = (k, y) => value("gdp", k, y);
    const grew = pair.map((k) => v(k, y1) / v(k, y0));
    const text = [
      t("vs.size.then", { ...L, y0, va: fmt("gdp", v(a, y0)), vb: fmt("gdp", v(b, y0)) }),
      t("vs.size.now", { ...L, y0, y1, va: fmt("gdp", v(a, y1)), vb: fmt("gdp", v(b, y1)), ma: times(grew[0]), mb: times(grew[1]) }),
    ];
    // the last year the larger one changed
    const lead = (y) => Math.sign(v(a, y) - v(b, y));
    const flip = [...gy].reverse().find((y, i, rev) => i + 1 < rev.length && lead(y) !== lead(rev[i + 1]) && lead(y) !== 0);
    const [big, small] = v(a, y1) >= v(b, y1) ? [a, b] : [b, a];
    text.push(flip != null && flip !== gy[0]
      ? t("vs.size.overtook", { big: link(big), small: link(small), year: flip, r: times(v(big, y1) / v(small, y1)), y1 })
      : t("vs.size.lead", { big: link(big), small: link(small), r: times(v(big, y1) / v(small, y1)), y1 }));
    text.push(t("vs.size.note"));
    if (pair.some(isGroup)) text.push(t("vs.size.groups"));
    steps.push({
      title: t("vs.size.title"),
      ask: { q: t("vs.size.ask", { y0, y1 }), choices: pair, answer: grew[0] >= grew[1] ? 0 : 1 },
      text, view: { ...base, mapby: "gdp", t: String(y0) }, play: replay(y0, y1), figure: chart("gdp"),
    });
  }

  // 2. people and income per person
  const py = both("gdp_pc");
  if (py.length >= 2) {
    const [y0, y1] = [py[0], py.at(-1)];
    const v = (k, y) => value("gdp_pc", k, y), p = (k, y) => value("pop", k, y);
    const text = [];
    if (p(a, y0) != null && p(b, y0) != null) {
      text.push(t("vs.pc.pop", { ...L, y0, y1, pa0: fmt("pop", p(a, y0)), pa1: fmt("pop", p(a, y1)), pb0: fmt("pop", p(b, y0)), pb1: fmt("pop", p(b, y1)) }));
    }
    text.push(t("vs.pc.income", { ...L, y0, y1, va0: fmt("gdp_pc", v(a, y0)), va1: fmt("gdp_pc", v(a, y1)), vb0: fmt("gdp_pc", v(b, y0)), vb1: fmt("gdp_pc", v(b, y1)) }));
    const [rich, poor] = v(a, y1) >= v(b, y1) ? [a, b] : [b, a];
    const r0 = v(rich, y0) / v(poor, y0);
    const r1 = v(rich, y1) / v(poor, y1);
    text.push(t(r1 < 1.05 ? "vs.pc.even" : r0 >= 1 ? "vs.pc.gap" : "vs.pc.gapFlip", {
      rich: link(rich), poor: link(poor), lead0: link(r0 >= 1 ? rich : poor), y0, y1, r: times(r1), r0: times(r0 >= 1 ? r0 : 1 / r0) }));
    steps.push({ title: t("vs.pc.title"), text, view: { ...base, mapby: "gdp_pc", t: String(y0) }, play: replay(y0, y1), figure: chart("gdp_pc") });
  }

  // 3. real growth, year by year
  const ry = both("gdp_growth");
  if (ry.length >= 3) {
    const [y0, y1] = [ry[0], ry.at(-1)];
    const g = (k, y) => value("gdp_growth", k, y);
    const avg = (k) => (Math.exp(d3.mean(ry, (y) => Math.log1p(g(k, y) / 100))) - 1) * 100;
    const text = [t("vs.growth.avg", { ...L, y0, y1, ga: fmt("gdp_growth", avg(a), { sign: true }), gb: fmt("gdp_growth", avg(b), { sign: true }) })];
    for (const k of pair) {
      const down = ry.filter((y) => g(k, y) < 0);
      const worst = d3.least(ry, (y) => g(k, y));
      text.push(down.length
        ? t("vs.growth.shrank", { name: link(k), n: down.length, year: worst, g: fmt("gdp_growth", g(k, worst)) })
        : t("vs.growth.never", { name: link(k) }));
    }
    steps.push({ title: t("vs.growth.title"), text, view: { ...base, mapby: "gdp_growth", t: String(y0) }, play: replay(y0, y1), figure: chart("gdp_growth", { zero: true }) });
  }

  // 4. trade in goods (IMF, as reported), with shares of world exports
  const xy = both("exports");
  if (xy.length >= 2) {
    const [y0, y1] = [xy[0], xy.at(-1)];
    const x = (k, y) => value("exports", k, y), bal = (k, y) => value("balance", k, y);
    const yi = new Map(tPeriods.map((p, i) => [+p, i]));
    const world = (y) => d3.sum(Object.entries(annual), ([k, s]) => (isGroup(k) ? 0 : metricAt(s, yi.get(y), "exports") ?? 0));
    const text = [
      t("vs.trade.now", { ...L, y1, xa: money(x(a, y1)), xb: money(x(b, y1)), sa: share(x(a, y1), world(y1)), sb: share(x(b, y1), world(y1)) }),
      t("vs.trade.then", { y0, xa: money(x(a, y0)), xb: money(x(b, y0)), sa: share(x(a, y0), world(y0)), sb: share(x(b, y0), world(y0)) }),
    ];
    if (bal(a, y1) != null && bal(b, y1) != null) text.push(t("vs.trade.balance", { ...L, y1, ba: money(bal(a, y1), { sign: true }), bb: money(bal(b, y1), { sign: true }) }));
    if (pair.some(isGroup)) text.push(t("vs.trade.groups"));
    steps.push({ title: t("vs.trade.title"), text, view: { ...base, view: "trends", set: pair.join(","), t: String(y0) }, play: replay(y0, y1) });
  }

  // 5. trade with each other, as reported by the first of the two that reports
  // prefer an economy's own reports to mirror data (Taiwan)
  const reports = (k) => hasFlows(k) && !store.entities[k]?.mirror;
  const [rep, other] = reports(a) ? [a, b] : reports(b) ? [b, a] : hasFlows(a) ? [a, b] : hasFlows(b) ? [b, a] : [null, null];
  if (rep) {
    const flows = await loadFlows(rep, "A", "TOTAL");
    // partners at each year, folded into the merged groups by that year's membership (as the map shows them)
    const keyAt = (p, y) => store.entities[p]?.groups?.find((s) => groups.has(s.g) && (s.from ?? -Infinity) <= y && y <= (s.to ?? Infinity))?.g ?? p;
    const partnersAt = (i) => {
      const out = new Map();
      for (const [p, s] of Object.entries(flows.p)) {
        const k = keyAt(p, +tPeriods[i]), v = metricAt(s, i, "total");
        if (k !== rep && v != null) out.set(k, (out.get(k) ?? 0) + v);
      }
      return out;
    };
    const withOther = tPeriods.map((_, i) => partnersAt(i).get(other) ?? null);
    const own = (i) => metricAt(annual[rep], i, "total");
    const yi = tPeriods.map((p, i) => [+p, i]).filter(([, i]) => withOther[i] > 0);
    if (yi.length >= 2) {
      const [[y0, i0], [y1, i1]] = [yi[0], yi.at(-1)];
      const rank = 1 + [...partnersAt(i1).values()].filter((v) => v > withOther[i1]).length;
      const text = [
        t("vs.pair.now", { rep: link(rep), other: link(other), y1, v: money(withOther[i1]), s: share(withOther[i1], own(i1)), rank }),
        t("vs.pair.then", { y0, v: money(withOther[i0]), s: share(withOther[i0], own(i0)) }),
        t("vs.pair.panel", { rep: link(rep) }),
      ];
      steps.push({ title: t("vs.pair.title"), text, view: { ...base, focus: rep, with: other, t: String(y0) }, play: replay(y0, y1), panel: "pair" });
    }
  }

  // 6. health and development (not computed for groups)
  const ly = both("life_exp");
  if (ly.length >= 2) {
    const [y0, y1] = [ly[0], ly.at(-1)];
    const v = (k, y) => value("life_exp", k, y);
    const text = [t("vs.lives.life", { ...L, y0, y1, a0: fmt("life_exp", v(a, y0)), a1: fmt("life_exp", v(a, y1)), b0: fmt("life_exp", v(b, y0)), b1: fmt("life_exp", v(b, y1)) })];
    const cy = both("child_mort");
    if (cy.length >= 2) {
      const c = (k, y) => fmtUnit(value("child_mort", k, y), "per1000", { compact: true });
      text.push(t("vs.lives.child", { ...L, y0: cy[0], y1: cy.at(-1), a0: c(a, cy[0]), a1: c(a, cy.at(-1)), b0: c(b, cy[0]), b1: c(b, cy.at(-1)) }));
    }
    const hy = both("hdi").at(-1);
    if (hy != null) text.push(t("vs.lives.hdi", { ...L, y: hy, ha: fmt("hdi", value("hdi", a, hy)), hb: fmt("hdi", value("hdi", b, hy)) }));
    steps.push({ title: t("vs.lives.title"), text, view: { ...base, mapby: "life_exp", t: String(y0) }, play: replay(y0, y1), figure: chart("life_exp") });
  }

  if (!steps.length) return null;

  // 7. side by side: the latest year both have, for each measure
  const rows = CARD_ROWS.filter((id) => metrics.has(id)).map((id) => ({ id, y: both(id).at(-1) })).filter((r) => r.y != null);
  const lastYear = d3.max(rows, (r) => r.y);
  const scatter = both("life_exp").length ? { x: "gdp_pc", y: "life_exp" } : { x: "gdp", y: "exports" };
  steps.push({
    title: t("vs.card.title"),
    text: [t("vs.card.text", L)],
    view: { ...base, view: "compare", ...scatter, t: String(both(scatter.y).at(-1) ?? lastYear) },
    figure: figureTable({ rows, pair, metrics, value }),
  });

  return {
    id: versusId(a, b),
    title: t("vs.title", { a: shortNameOf(a), b: shortNameOf(b) }),
    generated: true,
    marks: marksOf(pair),
    steps,
  };
}

// ------------------------------------------------------------------ figures shown in the story card

/** Two lines over the years with a marker at the year on screen. Returns {draw(el), setYear(y)}. */
function figureChart({ metric, pair, years, zero = false }) {
  const rows = pair.map((k) => years.map((y) => [y, metric.value(k, y)]).filter(([, v]) => v != null && (!metric.log || v > 0)));
  let svg = null, x = null;
  return {
    draw(el) {
      const W = Math.max(240, el.clientWidth || 300), H = 130, m = { t: 8, r: 14, b: 18, l: 48 };
      const all = rows.flat();
      if (!all.length) return;
      x = d3.scaleLinear(d3.extent(all, (d) => d[0]), [m.l, W - m.r]);
      const ext = d3.extent(all, (d) => d[1]);
      const y = metric.log
        ? d3.scaleLog([ext[0] / 1.1, ext[1] * 1.1], [H - m.b, m.t])
        : d3.scaleLinear(zero ? [Math.min(0, ext[0]), Math.max(0, ext[1])] : ext, [H - m.b, m.t]).nice();
      const ticks = metric.log ? y.ticks(4).filter((v) => /^(1|2|5)(\.0+)?e/.test(v.toExponential())).slice(-4) : y.ticks(4);
      svg = d3.select(el).append("svg").attr("viewBox", [0, 0, W, H]).attr("class", "vs-chart")
        .attr("role", "img").attr("aria-label", metric.name);
      svg.append("g").attr("class", "grid").selectAll("line").data(ticks).join("line")
        .attr("x1", m.l).attr("x2", W - m.r).attr("y1", y).attr("y2", y);
      svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
        .call(d3.axisBottom(x).ticks(5).tickFormat(d3.format("d")).tickSizeOuter(0));
      svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`)
        .call(d3.axisLeft(y).tickValues(ticks).tickFormat((v) => fmtUnit(v, metric.unit, { compact: true })).tickSizeOuter(0))
        .call((g) => g.select(".domain").remove());
      if (zero && y.domain()[0] < 0) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(0)).attr("y2", y(0));
      const line = d3.line().x((d) => x(d[0])).y((d) => y(d[1]));
      rows.forEach((r, i) => svg.append("path").attr("class", "tl").attr("d", line(r)).style("stroke", COLORS[i]));
      svg.append("line").attr("class", "yr").attr("y1", m.t).attr("y2", H - m.b).attr("visibility", "hidden");
      el.insertAdjacentHTML("afterbegin", `<div class="vs-key"><b>${esc(metric.name)}</b>${pair.map((k, i) =>
        `<span><i style="background:${COLORS[i]}"></i>${esc(shortNameOf(k))}</span>`).join("")}</div>`);
    },
    setYear(yr) {
      if (!svg) return;
      const [lo, hi] = x.domain();
      svg.select(".yr").attr("x1", x(yr)).attr("x2", x(yr)).attr("visibility", yr >= lo && yr <= hi ? "visible" : "hidden");
    },
  };
}

/** The two economies side by side, each measure at the latest year both have it. */
function figureTable({ rows, pair, metrics, value }) {
  return {
    draw(el) {
      el.innerHTML = `<table class="vs-table">
        <thead><tr><th></th>${pair.map((k, i) => `<th><i style="background:${COLORS[i]}"></i>${esc(shortNameOf(k))}</th>`).join("")}</tr></thead>
        <tbody>${rows.map(({ id, y }) => {
          const m = metrics.get(id);
          const vals = pair.map((k) => value(id, k, y));
          return `<tr><td>${esc(m.name)} <small>${y}</small></td>${vals.map((v) => `<td>${fmtUnit(v, m.unit)}</td>`).join("")}</tr>`;
        }).join("")}</tbody></table>`;
    },
    setYear() {},
  };
}
