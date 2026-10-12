// Data loading and aggregation. All values are USD millions; every series is
// a pair of arrays [exports[], imports[]] aligned to store.periods, the periods of the
// active slice: a frequency (store.freq) of all goods (data/<freq>/) or of one product
// (store.product, data/products/<product>/<freq>/).
import { yearOf } from "./time.js";
import { names, t } from "./i18n.js";

export const store = {
  meta: null,
  freq: "A",
  product: "TOTAL",
  periods: [],
  totals: {},
  topo: null,
  entities: {},
  groups: [],
  groupById: new Map(),
};

const flowsCache = new Map();
const totalsCache = new Map();
const breakdownCache = new Map();

function sliceDir(product, freq) {
  return product === "TOTAL" ? `data/${freq}` : `data/products/${product}/${freq}`;
}

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

export async function loadBase() {
  const [meta, topo] = await Promise.all([getJSON("data/meta.json"), getJSON("data/world.json")]);
  Object.assign(store, { meta, topo, entities: meta.entities, groups: meta.groups });
  for (const g of meta.groups) store.groupById.set(g.id, g);
  return store;
}

/** Frequencies available for a product ("TOTAL" = all goods). */
export function availableFreqs(product = "TOTAL") {
  return Object.keys(periodsOf(product));
}

function periodsOf(product) {
  return product === "TOTAL" ? store.meta.periods : store.meta.products?.periods ?? {};
}

/** Switch the active slice (product + frequency), loading its totals on first use. */
export async function setSlice(product, freq) {
  const key = `${product}/${freq}`;
  if (!totalsCache.has(key)) totalsCache.set(key, getJSON(`${sliceDir(product, freq)}/totals.json`));
  const totals = await totalsCache.get(key);
  Object.assign(store, { product, freq, totals, periods: periodsOf(product)[freq] });
}

export function products() {
  const p = store.meta.products;
  return p ? [...p.sectors.map((s) => ({ ...s, kind: "sector" })), ...p.commodities.map((c) => ({ ...c, kind: "commodity" }))] : [];
}

export function productName(id) {
  if (id === "TOTAL") return t("product.all");
  return names("products", id) ?? products().find((p) => p.id === id)?.name ?? id;
}

/** Product name for use inside a sentence: "crude oil", "natural gas (incl. LNG)" (acronyms keep their case). */
export function productNameLower(id) {
  const n = productName(id);
  return /^\p{Lu}\p{Ll}/u.test(n) ? n[0].toLowerCase() + n.slice(1) : n;
}

/** {product: series} of an entity's annual trade with the world, by product (CEPII BACI). */
export function loadBreakdown(code) {
  if (!store.meta.products) return Promise.resolve(null);
  if (!breakdownCache.has(code)) {
    breakdownCache.set(code, getJSON(`data/products/breakdown/${code}.json`).catch(() => null));
  }
  return breakdownCache.get(code);
}

export function hasFlows(code) {
  return store.groupById.has(code) || !!store.entities[code]?.reporter;
}

export function loadFlows(code, freq = store.freq, product = store.product) {
  const key = `${product}/${freq}/${code}`;
  if (!flowsCache.has(key)) {
    // A product slice may lack a file for an entity that has no trade in it.
    flowsCache.set(key, hasFlows(code)
      ? getJSON(`${sliceDir(product, freq)}/flows/${code}.json`).catch(() => ({ p: {} }))
      : Promise.resolve({ p: {} }));
  }
  return flowsCache.get(key);
}

// Names in the interface language (i18n "names"), falling back to the English names in meta.json.

function entityName(code) {
  return names("entities", code) ?? store.entities[code]?.name ?? code;
}

export function nameOf(code) {
  const g = store.groupById.get(code);
  return g ? names("groups", code)?.name ?? g.name : entityName(code);
}

export function shortNameOf(code) {
  const g = store.groupById.get(code);
  return g ? names("groups", code)?.short ?? g.short : entityName(code);
}

export function groupNote(code) {
  const g = store.groupById.get(code);
  return names("groups", code)?.note ?? g?.note;
}

/** UN M49 region or sub-region name. */
export function regionName(name) {
  return names("regions", name) ?? name;
}

export function isGroup(code) {
  return store.groupById.has(code);
}

/** Group a country belongs to at period index `pi` (membership is dated by year), or undefined. */
export function groupOf(code, pi) {
  const spans = store.entities[code]?.groups;
  if (!spans) return undefined;
  const y = yearOf(store.periods[pi]);
  return spans.find((s) => (s.from ?? -Infinity) <= y && y <= (s.to ?? Infinity))?.g;
}

/** Members of a group at period index `pi`. */
export function membersAt(groupId, pi) {
  const y = yearOf(store.periods[pi]);
  return store.groupById.get(groupId).members
    .filter((m) => (m.from ?? -Infinity) <= y && y <= (m.to ?? Infinity))
    .map((m) => m.id);
}

/** The entity a country is shown as at period index `pi`, given which groups are merged. */
export function displayOf(code, groupsOn, pi) {
  const g = groupOf(code, pi);
  return g && groupsOn.has(g) ? g : code;
}

/** Display key of `code` for every period, or a single string when it never changes. */
function displayKeys(code, groupsOn) {
  const spans = store.entities[code]?.groups;
  if (!spans || !spans.some((s) => groupsOn.has(s.g))) return code;
  const keys = store.periods.map((_, i) => displayOf(code, groupsOn, i));
  return keys.every((k) => k === keys[0]) ? keys[0] : keys;
}

function addSeries(acc, s, onlyYear = -1) {
  for (let k = 0; k < 2; k++) {
    const a = acc[k], b = s[k];
    const [lo, hi] = onlyYear < 0 ? [0, b.length] : [onlyYear, onlyYear + 1];
    for (let i = lo; i < hi; i++) {
      if (b[i] != null) a[i] = (a[i] ?? 0) + b[i];
    }
  }
}

export function emptySeries() {
  const n = store.periods.length;
  return [new Array(n).fill(null), new Array(n).fill(null)];
}

/** Partner series for a focus, folded into merged groups using each year's membership. */
export function partnerSeries(flows, focus, groupsOn) {
  const out = new Map();
  const add = (key, s, i) => {
    if (key === focus) return;
    if (!out.has(key)) out.set(key, emptySeries());
    addSeries(out.get(key), s, i);
  };
  for (const [p, s] of Object.entries(flows.p)) {
    const keys = displayKeys(p, groupsOn);
    if (typeof keys === "string") add(keys, s);
    else keys.forEach((k, i) => add(k, s, i));
  }
  return out;
}

/** World-level series for each displayed entity (groups = extra-group trade).
 *  A country's own series only covers the years it is not merged into a group. */
export function displayTotals(groupsOn) {
  const out = new Map();
  for (const [code, s] of Object.entries(store.totals)) {
    if (isGroup(code)) {
      if (groupsOn.has(code)) out.set(code, s);
      continue;
    }
    const keys = displayKeys(code, groupsOn);
    if (keys === code) out.set(code, s);
    else if (typeof keys !== "string") {
      const own = emptySeries();
      keys.forEach((k, i) => { if (k === code) addSeries(own, s, i); });
      out.set(code, own);
    }
  }
  return out;
}

/** Sum of all individual reporters' trade with the world. */
export function worldSeries() {
  const acc = emptySeries();
  for (const [code, s] of Object.entries(store.totals)) {
    if (!isGroup(code)) addSeries(acc, s);
  }
  return acc;
}

export function metricAt(s, i, metric) {
  if (!s || i < 0) return null;
  const x = s[0][i], m = s[1][i];
  switch (metric) {
    case "exports": return x;
    case "imports": return m;
    case "balance": return x != null && m != null ? x - m : null;
    default: return x == null && m == null ? null : (x ?? 0) + (m ?? 0);
  }
}

/** Change of a metric between year index i and i - back. Ratio for flows, difference for balance. */
export function changeAt(s, i, metric, back) {
  const v = metricAt(s, i, metric), v0 = metricAt(s, i - back, metric);
  if (v == null || v0 == null) return null;
  if (metric === "balance") return v - v0;
  if (v0 <= 0 || v <= 0) return null;
  return v / v0;
}

/** Latest period in which most reporters have published data. */
export function defaultPeriodIndex() {
  const counts = store.periods.map((_, i) =>
    Object.entries(store.totals).filter(([c, s]) => !isGroup(c) && s[0][i] != null).length);
  const max = Math.max(...counts);
  for (let i = counts.length - 1; i >= 0; i--) if (counts[i] >= max * 0.85) return i;
  return counts.length - 1;
}

// ------------------------------------------------------------------ indicators (World Bank, annual)

let indicatorsPromise = null;

/** {periods: ["1990", …], indicators: [{id, name, unit, description, source}], values: {id: {entity: [..]}}} */
export function loadIndicators() {
  indicatorsPromise ??= getJSON("data/indicators.json").catch(() => null);
  return indicatorsPromise;
}

let bilateralPromise = null;

/** Country-to-counterpart measures (debt by creditor, direct investment by investor), or null:
 *  {periods, measures: [{id, unit, source, counterparts}], basis: {m: {cp: {entity: "investor"}}}, values: {m: {cp: {entity: [..]}}}} */
export function loadBilateral() {
  bilateralPromise ??= getJSON("data/bilateral.json").catch(() => null);
  return bilateralPromise;
}

/** Annual totals of a slice regardless of the active one (e.g. annual exports while viewing monthly data). */
export function loadTotals(product, freq) {
  const key = `${product}/${freq}`;
  if (!totalsCache.has(key)) totalsCache.set(key, getJSON(`${sliceDir(product, freq)}/totals.json`));
  return totalsCache.get(key);
}
