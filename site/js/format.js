// Number formatting. Inputs are USD millions.

export function money(v, { sign = false } = {}) {
  if (v == null || Number.isNaN(v)) return "—";
  const s = v < 0 ? "−" : sign && v > 0 ? "+" : "";
  const a = Math.abs(v);
  let out;
  if (a >= 1e6) out = `${trim(a / 1e6, 2)}T`;
  else if (a >= 1e3) out = `${trim(a / 1e3, a >= 1e5 ? 0 : 1)}B`;
  else if (a >= 1) out = `${trim(a, a >= 100 ? 0 : 1)}M`;
  else if (a > 0) out = `${trim(a * 1e3, 0)}K`;
  else return "$0";
  return `${s}$${out}`;
}

function trim(n, d) {
  return n.toFixed(d).replace(/\.0+$/, "");
}

export function pct(v, { sign = true } = {}) {
  if (v == null || !Number.isFinite(v)) return "—";
  const p = v * 100;
  const a = Math.abs(p);
  const body = a >= 100 ? a.toFixed(0) : a >= 10 ? a.toFixed(0) : a.toFixed(1);
  return `${p < 0 ? "−" : sign && p > 0 ? "+" : ""}${body}%`;
}

/** Ratio (v/v0) -> "+12%" */
export function ratioPct(r) {
  return r == null ? "—" : pct(r - 1);
}

export function share(v, total) {
  if (v == null || !total) return "";
  const p = (v / total) * 100;
  return p >= 10 ? `${p.toFixed(0)}%` : p >= 0.1 ? `${p.toFixed(1)}%` : "<0.1%";
}

export function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
