// Pull league-wide team defensive ratings from stats.nba.com (WNBA, LeagueID=10)
// and write data/team-defense-wnba.json. Mirror of refresh-team-defense.mjs.
//
// Usage: node scripts/refresh-wnba-team-defense.mjs
//        npm run refresh-wnba-team-defense

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WNBA_TEAM_ID_TO_ABBR } from "../api/lib/league-config.js";
import { WNBA_HEADERS } from "../api/lib/nba-http.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = path.join(ROOT, "data/team-defense-wnba.json");

function currentWnbaSeason(date = new Date()) {
  return String(date.getUTCFullYear());
}

const DASH_DEFAULTS = {
  LastNGames: 0,
  LeagueID: "10",
  Month: 0,
  OpponentTeamID: 0,
  PaceAdjust: "N",
  PerMode: "PerGame",
  Period: 0,
  PlusMinus: "N",
  Rank: "N",
  DateFrom: "",
  DateTo: "",
  GameSegment: "",
  Location: "",
  Outcome: "",
  ShotClockRange: "",
  VsConference: "",
  VsDivision: "",
  TeamID: 0,
  Conference: "",
  Division: "",
  GameScope: "",
  PlayerExperience: "",
  PlayerPosition: "",
  StarterBench: "",
  TwoWay: 0,
};

async function fetchLeagueAdvanced(season, seasonType) {
  const params = new URLSearchParams({
    ...DASH_DEFAULTS,
    MeasureType: "Advanced",
    Season: season,
    SeasonType: seasonType,
  }).toString();
  const url = `https://stats.wnba.com/stats/leaguedashteamstats?${params}`;
  const res = await fetch(url, {
    headers: WNBA_HEADERS,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`stats.nba.com HTTP ${res.status} for WNBA ${seasonType}`);
  return res.json();
}

function parseLeagueDefense(payload) {
  const rs = payload?.resultSets?.find((r) => r.name === "LeagueDashTeamStats");
  if (!rs?.rowSet?.length) throw new Error("LeagueDashTeamStats result set empty");
  const headers = rs.headers;
  const idx = (name) => {
    const i = headers.indexOf(name);
    if (i < 0) throw new Error(`column ${name} missing from response`);
    return i;
  };
  const tIdIdx = idx("TEAM_ID");
  const tNameIdx = idx("TEAM_NAME");
  const tDefIdx = idx("DEF_RATING");

  const rows = rs.rowSet.map((row) => ({
    team_id: row[tIdIdx],
    team_name: row[tNameIdx],
    def_rating: row[tDefIdx],
  }));
  rows.sort((a, b) => a.def_rating - b.def_rating);
  return rows.map((r, i) => ({ ...r, def_rank: i + 1 }));
}

async function fetchWithFallback(season, seasonType) {
  // Early in a new WNBA season (e.g., May before games are played) the live
  // dashboard is empty/errors. Fall back to the previous year so the snapshot
  // holds a meaningful baseline.
  const tryYears = [Number(season), Number(season) - 1];
  let lastErr;
  for (const y of tryYears) {
    try {
      const payload = await fetchLeagueAdvanced(String(y), seasonType);
      const rows = parseLeagueDefense(payload);
      if (rows.length) {
        if (String(y) !== season) console.warn(`  (using Season=${y} as fallback for ${season})`);
        return { rows, season: String(y) };
      }
    } catch (err) {
      lastErr = err;
      console.warn(`  Season=${y} failed: ${err.message}`);
    }
  }
  if (lastErr) throw lastErr;
  throw new Error("all seasons returned empty");
}

async function buildSnapshot() {
  const season = currentWnbaSeason();
  const out = {
    season,
    fetched_at: new Date().toISOString(),
    seasons: {},
  };

  for (const seasonType of ["Regular Season", "Playoffs"]) {
    console.log(`Fetching WNBA ${seasonType} ${season}...`);
    let rows;
    try {
      const result = await fetchWithFallback(season, seasonType);
      rows = result.rows;
    } catch (err) {
      console.error(`  ${seasonType}: ${err.message}`);
      if (seasonType === "Playoffs") {
        console.error("  (skipping playoffs — likely no games yet)");
        continue;
      }
      throw err;
    }
    const teams = {};
    for (const r of rows) {
      const abbr = WNBA_TEAM_ID_TO_ABBR[r.team_id];
      if (!abbr) {
        console.error(`  warning: no abbr for team_id ${r.team_id} (${r.team_name}) — update WNBA_TEAM_ID_TO_ABBR in league-config.js`);
        continue;
      }
      teams[abbr] = {
        team_id: r.team_id,
        team_name: r.team_name,
        def_rating: r.def_rating,
        def_rank: r.def_rank,
      };
    }
    out.seasons[seasonType] = teams;
    console.log(`  ${Object.keys(teams).length} teams`);
  }
  return out;
}

async function main() {
  console.log("=== refresh-wnba-team-defense ===");
  const snapshot = await buildSnapshot();
  await fs.writeFile(OUT_PATH, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(`\nWrote ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
