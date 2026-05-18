// Shared helpers for scripts/refresh-*.mjs and scripts/audit-*.mjs.
// Keep CLI-only — no AsyncLocalStorage, no Sentry. These run on a developer
// laptop or in the refresh-data GitHub Action, not on Vercel.

// Strip accents, case, punctuation; collapse whitespace. Two names normalize
// equal iff they refer to the same player. Matches the convention used in
// api/lib/balldontlie.js#normalize and downstream lookups.
export function normName(s) {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[.'’\-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Fetch + JSON parse with null-on-failure semantics so callers can chain
// data sources without try/catch noise. Errors are logged to stderr so a
// failed cron-run leaves a trace in the workflow log.
export async function jsonFetch(url, opts = {}) {
  try {
    const res = await fetch(url, opts);
    if (!res.ok) {
      console.error(`  HTTP ${res.status} ${url.slice(0, 90)}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`  fetch threw on ${url.slice(0, 80)}: ${err.message}`);
    return null;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
