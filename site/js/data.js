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

/** Group a country belongs to in year index `yi` (membership is dated), or undefined. */
export function groupOf(code, yi) {
  const spans = store.entities[code]?.groups;
  if (!spans) return undefined;
  const y = store.years[yi];
  return spans.find((s) => (s.from ?? -Infinity) <= y && y <= (s.to ?? Infinity))?.g;
}

/** Members of a group in year index `yi`. */
export function membersAt(groupId, yi) {
  const y = store.years[yi];
  return store.groupById.get(groupId).members
    .filter((m) => (m.from ?? -Infinity) <= y && y <= (m.to ?? Infinity))
    .map((m) => m.id);
}

/** The entity a country is shown as in year index `yi`, given which groups are merged. */
export function displayOf(code, groupsOn, yi) {
  const g = groupOf(code, yi);
  return g && groupsOn.has(g) ? g : code;
}

/** Display key of `code` for every year, or a single string when it never changes. */
function displayKeys(code, groupsOn) {
  const spans = store.entities[code]?.groups;
  if (!spans || !spans.some((s) => groupsOn.has(s.g))) return code;
  const keys = store.years.map((_, i) => displayOf(code, groupsOn, i));
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
  const n = store.years.length;
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

/** Latest year in which most reporters have published data. */
export function defaultYearIndex() {
  const counts = store.years.map((_, i) =>
    Object.entries(store.totals).filter(([c, s]) => !isGroup(c) && s[0][i] != null).length);
  const max = Math.max(...counts);
  for (let i = counts.length - 1; i >= 0; i--) if (counts[i] >= max * 0.85) return i;
  return counts.length - 1;
}
