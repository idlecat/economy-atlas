// Data loading and aggregation. All values are USD millions; every series is
// a pair of arrays [exports[], imports[]] aligned to store.years.

export const store = {
  meta: null,
  years: [],
  totals: {},
  topo: null,
  entities: {},
  groups: [],
  groupById: new Map(),
};

const flowsCache = new Map();

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

export async function loadBase() {
  const [meta, totals, topo] = await Promise.all([
    getJSON("data/meta.json"),
    getJSON("data/totals.json"),
    getJSON("data/world.json"),
  ]);
  Object.assign(store, { meta, totals, topo, years: meta.years, entities: meta.entities, groups: meta.groups });
  for (const g of meta.groups) store.groupById.set(g.id, g);
  return store;
}

export function hasFlows(code) {
  return store.groupById.has(code) || !!store.entities[code]?.reporter;
}

export function loadFlows(code) {
  if (!flowsCache.has(code)) {
    flowsCache.set(code, hasFlows(code) ? getJSON(`data/flows/${code}.json`) : Promise.resolve({ p: {} }));
  }
  return flowsCache.get(code);
}

export function nameOf(code) {
  return store.groupById.get(code)?.name ?? store.entities[code]?.name ?? code;
}

export function shortNameOf(code) {
  return store.groupById.get(code)?.short ?? store.entities[code]?.name ?? code;
}

export function isGroup(code) {
  return store.groupById.has(code);
}

/** The entity a country is shown as, given which groups are aggregated. */
export function displayOf(code, groupsOn) {
  const g = store.entities[code]?.group;
  return g && groupsOn.has(g) ? g : code;
}

function addSeries(acc, s) {
  for (let k = 0; k < 2; k++) {
    const a = acc[k], b = s[k];
    for (let i = 0; i < b.length; i++) {
      if (b[i] != null) a[i] = (a[i] ?? 0) + b[i];
    }
  }
}

export function emptySeries() {
  const n = store.years.length;
  return [new Array(n).fill(null), new Array(n).fill(null)];
}

/** Partner series for a focus, with partners folded into aggregated groups. */
export function partnerSeries(flows, focus, groupsOn) {
  const out = new Map();
  for (const [p, s] of Object.entries(flows.p)) {
    const key = displayOf(p, groupsOn);
    if (key === focus) continue;
    if (!out.has(key)) out.set(key, emptySeries());
    addSeries(out.get(key), s);
  }
  return out;
}

/** World-level series for each displayed entity (groups = extra-group trade). */
export function displayTotals(groupsOn) {
  const out = new Map();
  for (const [code, s] of Object.entries(store.totals)) {
    if (isGroup(code)) {
      if (groupsOn.has(code)) out.set(code, s);
    } else if (displayOf(code, groupsOn) === code) {
      out.set(code, s);
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

/** Latest year in which most reporters have published data. */
export function defaultYearIndex() {
  const counts = store.years.map((_, i) =>
    Object.entries(store.totals).filter(([c, s]) => !isGroup(c) && s[0][i] != null).length);
  const max = Math.max(...counts);
  for (let i = counts.length - 1; i >= 0; i--) if (counts[i] >= max * 0.85) return i;
  return counts.length - 1;
}
