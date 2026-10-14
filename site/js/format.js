// Number formatting. Inputs are USD millions. Chinese uses 万 (1e4), 亿 (1e8) and 万亿 (1e12).
import { getLang } from "./i18n.js";

/** "$1.6T" / "1.6万亿美元". `compact` drops the currency in Chinese, for axis ticks. */
export function money(v, { sign = false, compact = false } = {}) {
  if (v == null || Number.isNaN(v)) return "—";
  const s = v < 0 ? "−" : sign && v > 0 ? "+" : "";
  const a = Math.abs(v);
  if (getLang() === "zh") return s + moneyZh(a, compact ? "" : "美元");
  let out;
  if (a >= 1e6) out = `${trim(a / 1e6, 2)}T`;
  else if (a >= 1e3) out = `${trim(a / 1e3, a >= 1e5 ? 0 : 1)}B`;
  else if (a >= 1) out = `${trim(a, a >= 100 ? 0 : 1)}M`;
  else if (a > 0) out = `${trim(a * 1e3, 0)}K`;
  else return "$0";
  return `${s}$${out}`;
}

function moneyZh(a, unit) {
  if (a >= 1e6) return `${trim(a / 1e6, 2)}万亿${unit}`;
  if (a >= 100) return `${trim(a / 100, a >= 1e3 ? 0 : 1)}亿${unit}`;
  if (a >= 0.01) return `${trim(a * 100, 0)}万${unit}`;
  return a > 0 ? `${trim(a * 1e6, 0)}${unit}` : `0${unit}`;
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

/** Format an indicator value by unit: usd (USD millions), usd_pc, people, pct, years, per1000, mt (million
 *  tonnes), t_pc (tonnes per person), index (0–1). `compact` (legend ticks) drops the unit where the title gives it. */
export function fmtUnit(v, unit, { sign = false, compact = false } = {}) {
  if (v == null || Number.isNaN(v)) return "—";
  switch (unit) {
    case "usd": return money(v, { sign, compact });
    case "usd_pc": {
      const n = Math.round(Math.abs(v)).toLocaleString("en-US");
      return `${v < 0 ? "−" : ""}${getLang() === "zh" ? `${n}美元` : `$${n}`}`;
    }
    case "people": {
      const a = Math.abs(v);
      if (getLang() === "zh") return a >= 1e8 ? `${trim(a / 1e8, 2)}亿` : a >= 1e4 ? `${trim(a / 1e4, a >= 1e6 ? 0 : 1)}万` : String(Math.round(a));
      return a >= 1e9 ? `${trim(a / 1e9, 2)}B` : a >= 1e6 ? `${trim(a / 1e6, a >= 1e8 ? 0 : 1)}M` : a >= 1e3 ? `${trim(a / 1e3, 0)}K` : String(Math.round(a));
    }
    case "pct": return `${sign && v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(Math.abs(v) >= 10 ? 0 : 1)}%`;
    case "years": return compact ? v.toFixed(0) : getLang() === "zh" ? `${v.toFixed(1)}岁` : `${v.toFixed(1)} years`;
    case "per1000": {
      const n = trim(v, v >= 10 ? 0 : 1);
      return compact ? n : getLang() === "zh" ? `${n}‰` : `${n} per 1,000`;
    }
    case "mt": {
      const a = Math.abs(v);
      if (getLang() === "zh") return a >= 1e4 ? `${trim(a / 1e4, 1)}亿吨` : `${trim(a * 100, 0)}万吨`;
      return a >= 1e3 ? `${trim(a / 1e3, 1)} Gt` : a >= 1 ? `${trim(a, 0)} Mt` : `${trim(a * 1e3, 0)} kt`;
    }
    case "t_pc": return getLang() === "zh" ? `${trim(v, 1)}吨` : `${trim(v, 1)} t`;
    case "index": return v.toFixed(3);
    default: return String(v);
  }
}
