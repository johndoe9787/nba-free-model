// Pure pick-log math. No React, no localStorage, no DOM — these helpers are
// the calibration-curve placeholders that Phase 2 will replace with fitted
// coefficients, so keeping them side-effect free makes the swap mechanical.

export const DEFAULT_MULTIPLIER = 3.0; // 2-leg Power Play default

// Tier → midpoint probability. Decision-category proxies, NOT calibrated.
// Surfaces "what would EV be IF the tier label matches reality" until enough
// outcomes accumulate to fit calibration in Phase 2.
const TIER_MIDPOINT = { S: 0.86, A: 0.75, B: 0.65, SKIP: 0.50 };

export function tierImpliedP(tier) {
  return TIER_MIDPOINT[tier] ?? null;
}

export function tentativeEv(p, multiplier) {
  if (p == null || !Number.isFinite(multiplier) || multiplier <= 0) return null;
  return p * multiplier - 1;
}

// Wilson 95% CI on observed win rate. Small-n appropriate (vs. normal
// approximation which breaks at the bounds when n is tiny). Returns
// { n, hitRate, ci: [lo, hi] | null, total }.
export function wilsonStats(entries) {
  const total = entries.length;
  const decided = entries.filter((p) => p.outcome === "W" || p.outcome === "L");
  const n = decided.length;
  if (n === 0) return { n: 0, hitRate: null, ci: null, total };
  const wins = decided.filter((p) => p.outcome === "W").length;
  const hitRate = wins / n;
  const z = 1.96;
  const denom = 1 + (z * z) / n;
  const centre = hitRate + (z * z) / (2 * n);
  const margin = z * Math.sqrt((hitRate * (1 - hitRate)) / n + (z * z) / (4 * n * n));
  const lo = Math.max(0, (centre - margin) / denom);
  const hi = Math.min(1, (centre + margin) / denom);
  return { n, hitRate, ci: [lo, hi], total };
}
