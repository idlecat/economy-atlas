// Data loading and aggregation. All values are USD millions; every series is
// a pair of arrays [exports[], imports[]] aligned to store.periods, the periods of
// the active frequency (store.freq). Each frequency has its own files under data/<freq>/.
import { yearOf } from "./time.js";

export const store = {
  meta: null,
  freq: "A",
  periods: [],
  totals: {},
  topo: null,
  entities: {},
  groups: [],
  groupById: new Map(),
};

const flowsCache = new Map();
const totalsCache = new Map();

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

export function availableFreqs() {
  return Object.keys(store.meta.periods);
}

/** Switch the active frequency, loading its totals on first use. */
export async function setFreq(freq) {
  if (!totalsCache.has(freq)) totalsCache.set(freq, getJSON(`data/${freq}/totals.json`));
  const totals = await totalsCache.get(freq);
  Object.assign(store, { freq, totals, periods: store.meta.periods[freq] });
}

export function hasFlows(code) {
  return store.groupById.has(code) || !!store.entities[code]?.reporter;
}

export function loadFlows(code, freq = store.freq) {
  const key = `${freq}/${code}`;
  if (!flowsCache.has(key)) {
    flowsCache.set(key, hasFlows(code) ? getJSON(`data/${freq}/flows/${code}.json`) : Promise.resolve({ p: {} }));
  }
  return flowsCache.get(key);
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
