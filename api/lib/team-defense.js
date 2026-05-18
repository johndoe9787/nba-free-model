// Opponent defensive rating + league rank. Two-tier reliability:
//   1. Live: stats.nba.com leaguedashteamstats (cached SWR fresh 6h / stale 24h)
//   2. Fallback: data/team-defense{,-wnba}.json snapshot (committed, refreshed manually)
//
// The snapshot keeps Rule 5h satisfied even when stats.nba.com 403s the
// Vercel egress IP (a documented, recurring failure mode). Refresh the
// snapshot with `npm run refresh-team-defense` / `npm run refresh-wnba-team-defense`.

import * as cache from "./cache.js";
import { getLeagueTeamDefense, currentSeasonForLeague } from "./nba-stats.js";
import { toNbaAbbr } from "./espn.js";
import { log } from "./logger.js";
import { getLeagueConfig } from "./league-config.js";
import nbaSnapshot from "../../data/team-defense.json" with { type: "json" };
import wnbaSnapshot from "../../data/team-defense-wnba.json" with { type: "json" };

const FRESH_TTL_MS = 6 * 60 * 60 * 1000;
const STALE_TTL_MS = 24 * 60 * 60 * 1000;

const SNAPSHOTS = { nba: nbaSnapshot, wnba: wnbaSnapshot };

function cacheKey(league, season, seasonType) {
  return `team-defense:${league}:${season}:${seasonType}`;
}

async function fetchLeague(league, season, seasonType) {
  const cfg = getLeagueConfig(league);
  return cache.swr(
    cacheKey(league, season, seasonType),
    () => getLeagueTeamDefense({
      season,
      seasonType,
      leagueId: cfg.stats_league_id,
      teamIdToAbbr: cfg.team_id_to_abbr,
    }),
    { freshTtlMs: FRESH_TTL_MS, staleTtlMs: STALE_TTL_MS }
  );
}

function snapshotLookup(league, seasonType) {
  return SNAPSHOTS[league]?.seasons?.[seasonType] ?? null;
}

// Returns { def_rating, def_rank, source } for the opponent, or null if
// the abbreviation is unknown to both live and snapshot data.
export async function getOpponentDefense(opponentEspnAbbr, {
  season,
  seasonType = "Regular Season",
  league = "nba",
} = {}) {
  const cfg = getLeagueConfig(league);
  const nbaAbbr = toNbaAbbr(opponentEspnAbbr, league);
  if (!nbaAbbr) return null;
  const seasonLabel = season ?? currentSeasonForLeague(cfg.stats_league_id);

  const live = await fetchLeague(league, seasonLabel, seasonType);
  if (live && live[nbaAbbr]) {
    const row = live[nbaAbbr];
    return {
      def_rating: row.def_rating,
      def_rank: row.def_rank,
      source: "live",
    };
  }

  const snap = snapshotLookup(league, seasonType);
  if (snap && snap[nbaAbbr]) {
    const row = snap[nbaAbbr];
    return {
      def_rating: row.def_rating,
      def_rank: row.def_rank,
      source: "snapshot",
    };
  }

  log.warn("team_defense.miss", { nbaAbbr, espnAbbr: opponentEspnAbbr, league });
  return null;
}
