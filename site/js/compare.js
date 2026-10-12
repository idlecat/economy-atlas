// Compare view logic: which dots to draw for two metrics in a year, and how strongly they correlate.
import { store, displayTotals, displayOf, isGroup, shortNameOf } from "./data.js";
import { pearson, spearman, linearFit, describe } from "./stats.js";
import { escapeHTML as esc } from "./format.js";
import { t } from "./i18n.js";

export const REGION_COLORS = {
  Africa: "#d08c2b", Americas: "#3a8f75", Asia: "#c2562b", Europe: "#2f5fb3", Oceania: "#8a5cc2",
};
const GROUP_COLOR = "#5d6878";

/** Countries (unless merged into a group in that year) and merged groups, as on the map at period index `pi`.
 *  displayTotals also lists countries that are merged only in some years, e.g. Croatia before it joined the EU. */
function candidates(groupsOn, pi, ind) {
  const shown = (code) => (isGroup(code) ? groupsOn.has(code) : !!store.entities[code] && displayOf(code, groupsOn, pi) === code);
  return new Set([...displayTotals(groupsOn).keys(), ...Object.keys(ind?.values.gdp ?? {})].filter(shown));
}

/**
 * @returns {points, x, y, stats: {n, r, rho, fit, text}}
 * Correlations use log10 values on log axes (points with values <= 0 are left out there).
 */
export function compareData({ metrics, xId, yId, year, groupsOn, pi, focus, ind }) {
  const x = metrics.get(xId), y = metrics.get(yId);
  const pop = metrics.get("pop");
  const points = [];
  for (const key of candidates(groupsOn, pi, ind)) {
    const xv = x.value(key, year), yv = y.value(key, year);
    if (xv == null || yv == null || (x.log && xv <= 0) || (y.log && yv <= 0)) continue;
    const region = isGroup(key) ? null : store.entities[key]?.region;
    points.push({
      key, x: xv, y: yv, label: shortNameOf(key),
      size: pop?.value(key, year) ?? 1,
      color: region ? REGION_COLORS[region] ?? GROUP_COLOR : GROUP_COLOR,
      region: region ?? "Group",
      focus: key === focus,
    });
  }
  const tx = x.log ? Math.log10 : (v) => v, ty = y.log ? Math.log10 : (v) => v;
  const xs = points.map((p) => tx(p.x)), ys = points.map((p) => ty(p.y));
  const r = pearson(xs, ys), rho = spearman(xs, ys);
  const fit = r == null ? null : linearFit(xs, ys);
  return { points, x, y, stats: { n: points.length, r, rho, fit, text: describe(r) } };
}

export function statsHTML(stats, x, y, groupsOn) {
  if (stats.r == null) return `<small>${t("compare.noData")}</small>`;
  const scales = t(x.log && y.log ? "compare.logLog" : x.log || y.log ? "compare.oneLog" : "compare.linear");
  return `<small>${t("compare.stats", {
    text: `<b>${esc(stats.text[0].toUpperCase() + stats.text.slice(1))}</b>`,
    r: stats.r.toFixed(2), scales, rho: stats.rho.toFixed(2), n: stats.n,
  })}${groupsOn.size ? t("compare.merged") : ""}</small>`;
}
