// Metrics that can be plotted against each other in the Compare view or colored on the map:
// trade values from the active product's annual totals, World Bank indicators, and ratios of both.
import { metricAt, productName } from "./data.js";

/** Units that are positive and span orders of magnitude get log axes. */
function wantsLog(unit, id) {
  return ["usd", "usd_pc", "people"].includes(unit) && !["fdi_in", "current_account", "balance"].includes(id);
}

/**
 * @param ind      indicators.json document (or null)
 * @param totals   annual totals {entity: [x[], m[]]} of the active product
 * @param tPeriods periods of `totals`
 * @param product  active product id ("TOTAL" = all goods)
 * @returns Map id -> {id, name, unit, log, group: "Trade"|"Economy", value(key, year)}
 */
export function buildMetrics(ind, totals, tPeriods, product) {
  const metrics = new Map();
  const yearIdx = new Map(tPeriods.map((p, i) => [+p.slice(0, 4), i]));
  const goods = product === "TOTAL" ? "goods" : productName(product).toLowerCase();
  const trade = (kind) => (key, year) => {
    const i = yearIdx.get(year);
    return i == null ? null : metricAt(totals[key], i, kind);
  };
  const add = (m) => metrics.set(m.id, { log: wantsLog(m.unit, m.id), ...m });

  add({ id: "exports", name: `Exports of ${goods}`, unit: "usd", group: "Trade", value: trade("exports") });
  add({ id: "imports", name: `Imports of ${goods}`, unit: "usd", group: "Trade", value: trade("imports") });
  add({ id: "total", name: `Trade in ${goods} (exports + imports)`, unit: "usd", group: "Trade", value: trade("total") });
  add({ id: "balance", name: `Trade balance in ${goods}`, unit: "usd", group: "Trade", value: trade("balance") });

  if (!ind) return metrics;
  const iYear = new Map(ind.periods.map((p, i) => [+p, i]));
  const indVal = (id) => (key, year) => {
    const i = iYear.get(year);
    return i == null ? null : ind.values[id]?.[key]?.[i] ?? null;
  };
  for (const spec of ind.indicators) {
    add({ id: spec.id, name: spec.name, unit: spec.unit, group: "Economy", description: spec.description, value: indVal(spec.id) });
  }
  const gdp = indVal("gdp");
  const ratio = (tradeKind) => (key, year) => {
    const t = trade(tradeKind)(key, year), g = gdp(key, year);
    return t == null || !g ? null : (t / g) * 100;
  };
  add({ id: "exports_gdp", name: `Exports of ${goods}, % of GDP`, unit: "pct", group: "Trade ÷ economy", value: ratio("exports"), log: true });
  add({ id: "trade_gdp", name: `Trade in ${goods}, % of GDP`, unit: "pct", group: "Trade ÷ economy", value: ratio("total"), log: true });
  return metrics;
}
