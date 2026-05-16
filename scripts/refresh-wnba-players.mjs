// Hydrate data/players-wnba.json by looking up WNBA player IDs at stats.nba.com
// (LeagueID=10 playerindex) and ESPN IDs via the ESPN search API.
//
// Re-runs are idempotent. Names already present in players-wnba.json have their
// nba/espn IDs filled in (or refreshed if missing); the script also adds any
// new players found in the current-season WNBA playerindex who already appear
// in players-wnba.json by name. To onboard a brand-new player, add their name
// (with null IDs) to data/players-wnba.json first, then run this script.
//
// Usage: node scripts/refresh-wnba-players.mjs
//        npm run refresh-wnba-players

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PLAYER_INFO_WNBA } from "../api/lib/player-ids.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = path.join(ROOT, "data/players-wnba.json");

const SEARCH = "https://site.web.api.espn.com/apis/search/v2";

function currentWnbaSeason(date = new Date()) {
  return String(date.getUTCFullYear());
}

function playerIndexUrl(season) {
  // Historical=1 because stats.wnba.com's "Active=1 Historical=0" view is
  // sparse early in a season — many established stars (A'ja Wilson, Caitlin
  // Clark) only appear under Historical=1 until later in the year. The result
  // is larger (~1200 rows) but we filter by name match anyway.
  return `https://stats.wnba.com/stats/playerindex?LeagueID=10&Season=${season}&Active=&AllStar=&College=&Country=&DraftPick=&DraftRound=&DraftYear=&Height=&Historical=1&TeamID=0&Weight=`;
}

// stats.wnba.com's CDN blocks the Chrome-on-Windows UA stats.nba.com accepts.
// Chrome-on-Mac is allowed. Keep these two scripts in sync with WNBA_HEADERS
// in api/lib/nba-http.js if you have to rotate the UA.
const NBA_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  Referer: "https://www.wnba.com/",
  Origin: "https://www.wnba.com",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token": "true",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normName(s) {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[.'’\-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function jsonFetch(url, opts = {}) {
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

async function fetchWnbaPlayerIndex() {
  // Early in a new WNBA season (e.g., May before games are played) the
  // playerindex for the current year returns HTTP 500 because the roster
  // isn't populated yet. Fall back to the previous year, which holds the
  // most recently active rosters.
  const thisYear = Number(currentWnbaSeason());
  const tryYears = [thisYear, thisYear - 1];
  for (const season of tryYears) {
    const data = await jsonFetch(playerIndexUrl(String(season)), { headers: NBA_HEADERS });
    const rs = data?.resultSets?.[0];
    if (!rs?.rowSet?.length) {
      console.warn(`  playerindex Season=${season} empty — trying previous season`);
      continue;
    }
    console.log(`  using Season=${season}`);
    const idIdx = rs.headers.indexOf("PERSON_ID");
    const firstIdx = rs.headers.indexOf("PLAYER_FIRST_NAME");
    const lastIdx = rs.headers.indexOf("PLAYER_LAST_NAME");
    const map = new Map();
    for (const row of rs.rowSet) {
      map.set(normName(`${row[firstIdx]} ${row[lastIdx]}`), row[idIdx]);
    }
    return map;
  }
  console.error("  ! stats.wnba.com/playerindex returned nothing for any tried season");
  return new Map();
}

async function espnSearch(name) {
  const data = await jsonFetch(
    `${SEARCH}?query=${encodeURIComponent(name)}&type=player&limit=5`
  );
  const players = data?.results?.find((r) => r.type === "player")?.contents ?? [];
  const match =
    players.find(
      (p) =>
        p.sport === "basketball" &&
        p.defaultLeagueSlug === "wnba" &&
        p.displayName?.toLowerCase() === name.toLowerCase()
    ) ?? players.find((p) => p.sport === "basketball" && p.defaultLeagueSlug === "wnba");
  if (!match) return null;
  const espnId = match.uid?.match(/a:(\d+)/)?.[1] ?? null;
  return { team: match.subtitle ?? null, espnId: espnId ? Number(espnId) : null };
}

async function main() {
  console.log("=== refresh-wnba-players ===");

  const seedNames = Object.keys(PLAYER_INFO_WNBA).sort();
  console.log(`\n[1/3] ${seedNames.length} names in data/players-wnba.json`);

  console.log(`\n[2/3] fetching stats.nba.com WNBA playerindex (LeagueID=10, Season=${currentWnbaSeason()})...`);
  const nbaIdByName = await fetchWnbaPlayerIndex();
  console.log(`  ${nbaIdByName.size} active WNBA players in index`);

  console.log(`\n[3/3] resolving ESPN IDs and merging...`);
  const merged = {};
  const missingNba = [];
  const missingEspn = [];
  for (const name of seedNames) {
    const prior = PLAYER_INFO_WNBA[name] ?? {};
    const nbaId = nbaIdByName.get(normName(name)) ?? prior.nba ?? null;
    if (!nbaId) missingNba.push(name);

    let espnId = prior.espn ?? null;
    if (!espnId) {
      const r = await espnSearch(name);
      espnId = r?.espnId ?? null;
      await sleep(120);
    }
    if (!espnId) missingEspn.push(name);

    merged[name] = { nba: nbaId, espn: espnId };
  }

  const sorted = Object.fromEntries(
    Object.entries(merged).sort(([a], [b]) => a.localeCompare(b))
  );
  await fs.writeFile(OUT_PATH, JSON.stringify(sorted, null, 2) + "\n");
  console.log(`\nWrote ${OUT_PATH}`);

  const resolved = Object.values(merged).filter((v) => v.nba && v.espn).length;
  console.log(`\nFully resolved: ${resolved}/${seedNames.length}`);
  if (missingNba.length) {
    console.log("\nMISSING stats.nba.com id:");
    for (const n of missingNba) console.log(`  ! ${n}`);
  }
  if (missingEspn.length) {
    console.log("\nMISSING ESPN id:");
    for (const n of missingEspn) console.log(`  ! ${n}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
