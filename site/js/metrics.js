// Metrics that can be plotted against each other in the Compare view or colored on the map:
// trade values from the active product's annual totals, World Bank indicators, and ratios of both.
import { metricAt, productName, productNameLower } from "./data.js";
import { names, t } from "./i18n.js";

/** Units that are positive and span orders of magnitude get log axes. */
function wantsLog(unit, id) {
  return ["usd", "usd_pc", "people"].includes(unit) && !["fdi_in", "current_account", "balance"].includes(id);
}

/**
 * @param ind      indicators.json document (or null)
 * @param totals   annual totals {entity: [x[], m[]]} of the active product
 * @param tPeriods periods of `totals`
 * @param product  active product id ("TOTAL" = all goods)
 * @returns Map id -> {id, name, unit, log, group: "trade"|"economy"|"ratio", value(key, year)}
 * Names are in the interface language.
 */
export function buildMetrics(ind, totals, tPeriods, product) {
  const metrics = new Map();
  const yearIdx = new Map(tPeriods.map((p, i) => [+p.slice(0, 4), i]));
  const goods = product === "TOTAL" ? t("goods") : productNameLower(product);
  const trade = (kind) => (key, year) => {
    const i = yearIdx.get(year);
    return i == null ? null : metricAt(totals[key], i, kind);
  };
  const add = (m) => metrics.set(m.id, { log: wantsLog(m.unit, m.id), ...m });

  for (const id of ["exports", "imports", "total", "balance"]) {
    add({ id, name: t(`m.${id}`, { goods }), unit: "usd", group: "trade", value: trade(id) });
  }

  if (!ind) return metrics;
  const iYear = new Map(ind.periods.map((p, i) => [+p, i]));
  const indVal = (id) => (key, year) => {
    const i = iYear.get(year);
    return i == null ? null : ind.values[id]?.[key]?.[i] ?? null;
  };
  for (const spec of ind.indicators) {
    const tr = names("indicators", spec.id);
    add({ id: spec.id, name: tr?.name ?? spec.name, unit: spec.unit, group: "economy",
      description: tr?.description ?? spec.description, value: indVal(spec.id) });
  }
  const gdp = indVal("gdp");
  const ratio = (tradeKind) => (key, year) => {
    const v = trade(tradeKind)(key, year), g = gdp(key, year);
    return v == null || !g ? null : (v / g) * 100;
  };
  add({ id: "exports_gdp", name: t("m.exports_gdp", { goods }), unit: "pct", group: "ratio", value: ratio("exports"), log: true });
  add({ id: "trade_gdp", name: t("m.trade_gdp", { goods }), unit: "pct", group: "ratio", value: ratio("total"), log: true });
  return metrics;
}
