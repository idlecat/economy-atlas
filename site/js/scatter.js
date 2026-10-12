// Compare view: one dot per country or merged group, x and y from two metrics for one year.
import * as d3 from "../vendor/d3.js";
import { fmtUnit } from "./format.js";
import { getLang, t } from "./i18n.js";

export function createScatter(container, { onHover, onMove, onClick }) {
  const svg = d3.select(container).append("svg").attr("class", "scatter").attr("role", "img").attr("aria-label", t("compare.aria"));
  const gx = svg.append("g").attr("class", "axis");
  const gy = svg.append("g").attr("class", "axis");
  const grid = svg.append("g").attr("class", "grid");
  const fitPath = svg.append("path").attr("class", "fit");
  const dots = svg.append("g");
  const labels = svg.append("g").attr("class", "labels");
  const xTitle = svg.append("text").attr("class", "axis-title");
  const yTitle = svg.append("text").attr("class", "axis-title").attr("transform", "rotate(-90)");
  let last = null;

  function render(opts) {
    last = opts;
    const { width, height } = container.getBoundingClientRect();
    if (!width || !height) return;
    const narrow = width < 600;
    // top space for the title and legend overlays; Chinese tick labels ("1000亿美元") need a wider left margin
    const m = { t: narrow ? 118 : 96, r: narrow ? 14 : 28, b: 56, l: (narrow ? 58 : 72) + (getLang() === "zh" ? 16 : 0) };
    svg.attr("viewBox", [0, 0, width, height]);
    const { points, x: xm, y: ym } = opts;
    const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
    const scale = (log, vals, range) => {
      if (!vals.length) return d3.scaleLinear([0, 1], range);
      const [lo, hi] = d3.extent(vals);
      return log
        ? d3.scaleLog([lo / 1.3, hi * 1.3], range).clamp(true)
        : d3.scaleLinear([Math.min(0, lo), hi], range).nice();
    };
    const x = scale(xm.log, xs, [m.l, width - m.r]);
    const y = scale(ym.log, ys, [height - m.b, m.t]);
    const r = d3.scaleSqrt([0, d3.max(points, (p) => p.size) || 1], [3, Math.min(34, width / 30)]);
    const fmtTick = (metric) => (v) => fmtUnit(v, metric.unit);
    // log axes: 1-2-5 steps, or only powers of ten when there are many decades or little room
    const ticks = (s, log) => {
      if (!log) return s.ticks(narrow ? 4 : 6);
      const all = s.ticks(5);
      const decades = Math.log10(s.domain()[1] / s.domain()[0]);
      return all.filter((t) => (narrow || decades > 5 ? /^1(\.0+)?e/ : /^(1|2|5)(\.0+)?e/).test(t.toExponential()));
    };

    gx.attr("transform", `translate(0,${height - m.b})`)
      .call(d3.axisBottom(x).tickValues(ticks(x, xm.log)).tickFormat(fmtTick(xm)).tickSizeOuter(0));
    gy.attr("transform", `translate(${m.l},0)`)
      .call(d3.axisLeft(y).tickValues(ticks(y, ym.log)).tickFormat(fmtTick(ym)).tickSizeOuter(0));
    grid.selectAll("line").data(ticks(y, ym.log)).join("line")
      .attr("x1", m.l).attr("x2", width - m.r).attr("y1", (v) => y(v)).attr("y2", (v) => y(v));
    xTitle.attr("x", (m.l + width - m.r) / 2).attr("y", height - 14).attr("text-anchor", "middle")
      .text(xm.log ? t("compare.logAxis", { name: xm.name }) : xm.name);
    yTitle.attr("x", -(m.t + height - m.b) / 2).attr("y", 18).attr("text-anchor", "middle")
      .text(ym.log ? t("compare.logAxis", { name: ym.name }) : ym.name);

    // regression line, fitted in the transformed space
    if (opts.fit) {
      const tx = xm.log ? Math.log10 : (v) => v;
      const [x0, x1] = x.domain();
      const line = d3.range(0, 1.0001, 0.02).map((t) => {
        const xv = xm.log ? 10 ** (Math.log10(x0) + t * (Math.log10(x1) - Math.log10(x0))) : x0 + t * (x1 - x0);
        const yt = opts.fit.a + opts.fit.b * tx(xv);
        return [x(xv), y(ym.log ? 10 ** yt : yt)];
      }).filter(([, py]) => py >= m.t && py <= height - m.b);
      fitPath.attr("d", line.length > 1 ? d3.line()(line) : null);
    } else {
      fitPath.attr("d", null);
    }

    const trans = svg.transition().duration(opts.animate ? 450 : 0);
    dots.selectAll("circle")
      .data(points, (p) => p.key)
      .join(
        (enter) => enter.append("circle").attr("cx", (p) => x(p.x)).attr("cy", (p) => y(p.y)).attr("r", 0),
        (update) => update,
        (exit) => exit.transition(trans).attr("r", 0).remove(),
      )
      .attr("class", (p) => `dot${p.focus ? " focus" : ""}${p.listed ? " listed" : ""}`)
      .style("fill", (p) => p.color)
      .on("pointerenter", (ev, p) => onHover(p, ev))
      .on("pointermove", (ev) => onMove(ev))
      .on("pointerleave", () => onHover(null))
      .on("click", (_, p) => onClick(p.key))
      .transition(trans)
      .attr("cx", (p) => x(p.x)).attr("cy", (p) => y(p.y)).attr("r", (p) => r(p.size));
    dots.selectAll("circle.focus").raise();

    // label the largest dots and the focus
    const labelled = [...points].sort((a, b) => b.size - a.size).slice(0, narrow ? 5 : opts.labelCount ?? 12);
    for (const p of points) if (p.focus && !labelled.includes(p)) labelled.push(p);
    labels.selectAll("text")
      .data(labelled, (p) => p.key)
      .join("text")
      .attr("class", (p) => (p.focus ? "focus" : ""))
      .text((p) => p.label)
      // near the right edge, put the label on the left of the dot so it isn't cut off
      .attr("text-anchor", (p) => (x(p.x) > width - 130 ? "end" : "start"))
      .transition(trans)
      .attr("x", (p) => (x(p.x) > width - 130 ? x(p.x) - r(p.size) - 3 : x(p.x) + r(p.size) + 3))
      .attr("y", (p) => y(p.y) + 4);
  }

  new ResizeObserver(() => last && render({ ...last, animate: false })).observe(container);
  return { render, svg };
}
