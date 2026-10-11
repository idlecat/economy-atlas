// Correlation helpers for the Compare view and the panel's growth chart.

function mean(a) { return a.reduce((s, v) => s + v, 0) / a.length; }

/** Pearson correlation, or null with fewer than 3 points or no variance. */
export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

function ranks(a) {
  const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const r = new Array(a.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; // average rank for ties
    i = j + 1;
  }
  return r;
}

/** Spearman rank correlation: robust to outliers and to the choice of log or linear scale. */
export function spearman(xs, ys) {
  return pearson(ranks(xs), ranks(ys));
}

/** Least-squares line y = a + b x. */
export function linearFit(xs, ys) {
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const b = sxx ? sxy / sxx : 0;
  return { a: my - b * mx, b };
}

/** Plain-language strength of a correlation coefficient. */
export function describe(r) {
  if (r == null) return "not enough data";
  const a = Math.abs(r);
  const s = a >= 0.8 ? "very strong" : a >= 0.6 ? "strong" : a >= 0.4 ? "moderate" : a >= 0.2 ? "weak" : "little or no";
  return a < 0.2 ? `${s} correlation` : `${s} ${r > 0 ? "positive" : "negative"} correlation`;
}
