function wilsonInterval(successes, total, z = 1.96) {
  const n = Number(total);
  const k = Number(successes);
  if (!Number.isFinite(n) || !Number.isFinite(k) || n <= 0) return null;
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denominator;
  const halfWidth = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / denominator;
  return [round(Math.max(0, center - halfWidth), 4), round(Math.min(1, center + halfWidth), 4)];
}

function rateSummary(successes, total) {
  const n = Number(total);
  const k = Number(successes);
  return {
    numerator: k,
    denominator: n,
    rate: n ? round(k / n, 6) : null,
    wilson_95: wilsonInterval(k, n),
  };
}

function formatRate(summary) {
  if (!summary || summary.rate === null) return "N/A";
  return `${summary.numerator}/${summary.denominator}, ${(summary.rate * 100).toFixed(1)}% [${(summary.wilson_95[0] * 100).toFixed(1)}, ${(summary.wilson_95[1] * 100).toFixed(1)}]`;
}

function round(value, digits = 3) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function mean(values) {
  const filtered = values.filter(Number.isFinite);
  return filtered.length ? filtered.reduce((sum, value) => sum + value, 0) / filtered.length : null;
}

module.exports = {
  wilsonInterval,
  rateSummary,
  formatRate,
  round,
  countBy,
  mean,
};
