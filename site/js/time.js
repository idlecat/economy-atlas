// Period helpers. Periods are strings: "2008" (annual), "2008-Q4" (quarterly), "2008-09" (monthly).

export const FREQS = {
  A: { label: "Annual", perYear: 1, playMs: 700 },
  Q: { label: "Quarterly", perYear: 4, playMs: 400 },
  M: { label: "Monthly", perYear: 12, playMs: 220 },
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function freqOf(period) {
  if (/^\d{4}$/.test(period)) return "A";
  if (/^\d{4}-Q\d$/.test(period)) return "Q";
  return "M";
}

export function yearOf(period) {
  return +period.slice(0, 4);
}

/** "2008", "Q4 2008", "Sep 2008" */
export function periodLabel(period) {
  if (!period) return "—";
  const f = freqOf(period);
  if (f === "A") return period;
  if (f === "Q") return `${period.slice(5)} ${period.slice(0, 4)}`;
  return `${MONTHS[+period.slice(5, 7) - 1]} ${period.slice(0, 4)}`;
}

/** Index in `periods` closest to `period`, which may be of another frequency. */
export function nearestIndex(periods, period) {
  if (!period || !periods.length) return -1;
  const exact = periods.indexOf(period);
  if (exact >= 0) return exact;
  const y = yearOf(period);
  const target = freqOf(periods[0]);
  let want;
  if (target === "A") want = String(y);
  else if (freqOf(period) === "A") want = target === "M" ? `${y}-12` : `${y}-Q4`;
  else if (target === "M") want = `${y}-${String(+period.slice(6) * 3).padStart(2, "0")}`; // Q -> last month
  else want = `${y}-Q${Math.ceil(+period.slice(5, 7) / 3)}`; // M -> quarter
  const i = periods.indexOf(want);
  if (i >= 0) return i;
  // outside the covered range: clamp
  return want < periods[0] ? 0 : periods.length - 1;
}

/** Indices to label on a time axis: the first period of every k-th year, at most `max` labels. */
export function yearTicks(periods, max = 7) {
  const starts = [];
  periods.forEach((p, i) => { if (i === 0 || yearOf(p) !== yearOf(periods[i - 1])) starts.push(i); });
  const span = yearOf(periods.at(-1)) - yearOf(periods[0]) + 1;
  const step = [1, 2, 5, 10, 20].find((s) => span / s <= max) ?? 25;
  return starts.filter((i) => yearOf(periods[i]) % step === 0);
}
