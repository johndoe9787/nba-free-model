// Shared HTTP scaffolding for stats.nba.com endpoints.
//
// Two libs hit stats.nba.com (nba-stats, matchup-defender) and a third may
// follow. The headers, timeout, and null-on-failure contract were duplicated
// across them; this file is the single place to fix when stats.nba.com
// tightens its bot detection or rotates header expectations.

import { log } from "./logger.js";

export const NBA_BASE = "https://stats.nba.com/stats";
export const WNBA_BASE = "https://stats.wnba.com/stats";

// stats.nba.com / stats.wnba.com both check these x-nba-stats-* headers and a
// browser-y User-Agent; missing any of them yields a silent 4xx. Origin and
// Referer are flipped to wnba.com for WNBA traffic in headersFor().
const BASE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token": "true",
  "Connection": "keep-alive",
};

export const NBA_HEADERS = {
  ...BASE_HEADERS,
  "Origin": "https://www.nba.com",
  "Referer": "https://www.nba.com/",
};

// stats.wnba.com's CDN blocks the Chrome-on-Windows User-Agent that
// stats.nba.com accepts (returns an HTML 503 page). Chrome-on-Mac is allowed.
// Empirically verified 2026-05; revisit if the WNBA endpoint starts 503'ing.
export const WNBA_HEADERS = {
  ...BASE_HEADERS,
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Origin": "https://www.wnba.com",
  "Referer": "https://www.wnba.com/",
};

function hostFor(params) {
  return String(params?.LeagueID) === "10" ? WNBA_BASE : NBA_BASE;
}

function headersFor(params) {
  return String(params?.LeagueID) === "10" ? WNBA_HEADERS : NBA_HEADERS;
}

// Vercel egress IPs are often silently dropped by stats.nba.com (no response,
// not a 4xx). Without a timeout, each call hangs until Node's socket timeout
// fires (~60-120s). 6s is enough for a healthy response from a working IP
// and short enough to not dominate orchestrator latency.
export const NBA_FETCH_TIMEOUT_MS = 6000;

// stats.wnba.com (and to a lesser degree stats.nba.com) intermittently
// returns 503 or times out, especially when several requests fire in
// parallel. A single 350ms-backoff retry on 5xx/timeout converts most
// transient blips into successful responses without meaningfully
// inflating orchestrator latency. 4xx is treated as terminal — those
// are typically auth/parameter problems and retrying won't help.
async function fetchOnce(url, headers) {
  return fetch(url, {
    headers,
    signal: AbortSignal.timeout(NBA_FETCH_TIMEOUT_MS),
  });
}

export async function nbaFetch(endpoint, params) {
  const qs = new URLSearchParams(params).toString();
  const base = hostFor(params);
  const headers = headersFor(params);
  const url = `${base}/${endpoint}?${qs}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchOnce(url, headers);
      if (res.ok) return await res.json();
      if (res.status < 500 || attempt === 1) {
        log.error("nba_stats.http_error", { base, endpoint, status: res.status });
        return null;
      }
      log.warn("nba_stats.http_retry", { base, endpoint, status: res.status });
    } catch (err) {
      if (attempt === 1) {
        log.error("nba_stats.threw", { base, endpoint, error: err.message });
        return null;
      }
      log.warn("nba_stats.threw_retry", { base, endpoint, error: err.message });
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  return null;
}

export function rowToObj(headers, row) {
  return Object.fromEntries(headers.map((h, i) => [h, row[i]]));
}

export function findResultSet(payload, name) {
  return payload?.resultSets?.find((rs) => rs.name === name) ?? null;
}
