// ESPN public APIs. No auth, no special headers required.
// Used for game schedule, win probability, and injury reports — fields that
// stats.nba.com doesn't expose cleanly.
//
// All exported functions accept a { league } option ("nba" | "wnba"). URLs and
// cache keys are scoped per league so NBA and WNBA traffic don't collide.

import * as cache from "./cache.js";
import { logPrefix } from "./request-context.js";
import { getLeagueConfig } from "./league-config.js";

const TTL_SCOREBOARD_MS = 60_000;
const TTL_INJURIES_FRESH_MS = 120_000;
const TTL_INJURIES_STALE_MS = 600_000;

function urlsFor(league) {
  const cfg = getLeagueConfig(league);
  const sport = cfg.espn_sport_path;          // "basketball/nba" | "basketball/wnba"
  const leaguePath = cfg.espn_league_path;    // "basketball/leagues/nba" | "basketball/leagues/wnba"
  return {
    SCOREBOARD: `https://site.api.espn.com/apis/site/v2/sports/${sport}/scoreboard`,
    CORE: `https://sports.core.api.espn.com/v2/sports/${leaguePath}`,
    SITE: `https://site.api.espn.com/apis/site/v2/sports/${sport}`,
  };
}

// 8s upstream timeout. Bounds inflight SWR promise lifetime — without it, a
// hung connection would pin the inflight entry past the stale window and
// cold callers would await a dead promise.
async function jsonFetch(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.error(`${logPrefix()}espn ${url} ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`${logPrefix()}espn ${url} threw:`, err.message);
    return null;
  }
}

function parseEvent(event) {
  const comp = event.competitions?.[0];
  if (!comp) return null;
  const home = comp.competitors?.find((c) => c.homeAway === "home");
  const away = comp.competitors?.find((c) => c.homeAway === "away");
  if (!home || !away) return null;
  return {
    game_id: event.id,
    competition_id: comp.id,
    date: event.date,
    status: event.status?.type?.name,
    state: event.status?.type?.state, // "pre" | "in" | "post"
    // Playoff series state, present only on playoff events. Authoritative —
    // ground-truth uses this to avoid reconstructing series from gamelog.
    series: comp.series ?? null,
    round: comp.type?.abbreviation ?? null, // e.g. "RD16" | "RD8" | "RD4" | "RD2"
    home: {
      team_id: home.team.id,
      name: home.team.displayName,
      abbr: home.team.abbreviation,
    },
    away: {
      team_id: away.team.id,
      name: away.team.displayName,
      abbr: away.team.abbreviation,
    },
  };
}

export async function getTodaysGames(date, { league = "nba" } = {}) {
  // date: optional "YYYYMMDD"
  const cacheKey = `scoreboard:${league}:${date ?? "today"}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const urls = urlsFor(league);
  const url = date ? `${urls.SCOREBOARD}?dates=${date}` : urls.SCOREBOARD;
  const data = await jsonFetch(url);
  if (!data) return null;
  const events = (data.events || []).map(parseEvent).filter(Boolean);
  cache.set(cacheKey, events, TTL_SCOREBOARD_MS);
  return events;
}

export function toEspnAbbr(abbr, league = "nba") {
  if (!abbr) return null;
  const cfg = getLeagueConfig(league);
  const upper = abbr.toUpperCase();
  return cfg.stats_to_espn_abbr[upper] || upper;
}

export function toNbaAbbr(abbr, league = "nba") {
  if (!abbr) return null;
  const cfg = getLeagueConfig(league);
  const upper = abbr.toUpperCase();
  // Reverse the stats→espn map for this league.
  for (const [stats, espn] of Object.entries(cfg.stats_to_espn_abbr)) {
    if (espn === upper) return stats;
  }
  return upper;
}

export function findGameForTeamAbbr(games, abbr, { league = "nba" } = {}) {
  if (!games || !abbr) return null;
  const upper = toEspnAbbr(abbr, league);
  return (
    games.find(
      (g) => g.home.abbr === upper || g.away.abbr === upper
    ) || null
  );
}

function formatYYYYMMDD(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

// Fetches the next `daysAhead` scoreboards in parallel, then picks the
// smallest days_out match. Returns { game, days_out } or null. The serial
// version's worst case was ~8s on cold days; parallel is bounded by ESPN's
// slowest single-day response (~1-2s). Cached scoreboard hits become free.
export async function findNextGameForTeamAbbr(abbr, daysAhead = 7, { league = "nba" } = {}) {
  if (!abbr) return null;
  const upper = toEspnAbbr(abbr, league);
  const today = new Date();

  const dayResults = await Promise.all(
    Array.from({ length: daysAhead + 1 }, (_, i) => {
      const d = new Date(today);
      d.setUTCDate(today.getUTCDate() + i);
      return getTodaysGames(formatYYYYMMDD(d), { league });
    })
  );

  for (let i = 0; i < dayResults.length; i++) {
    const games = dayResults[i];
    if (!games?.length) continue;
    const found = games.find(
      (g) => g.home.abbr === upper || g.away.abbr === upper
    );
    if (found) return { game: found, days_out: i };
  }
  return null;
}

export function homeAwayForTeam(game, abbr, { league = "nba" } = {}) {
  if (!game) return null;
  const upper = toEspnAbbr(abbr, league);
  if (game.home.abbr === upper) return "home";
  if (game.away.abbr === upper) return "away";
  return null;
}

export function opponentFor(game, abbr, { league = "nba" } = {}) {
  if (!game) return null;
  const upper = toEspnAbbr(abbr, league);
  if (game.home.abbr === upper) return game.away;
  if (game.away.abbr === upper) return game.home;
  return null;
}

function pickGameProjection(side) {
  const stat = side?.statistics?.find((s) => s.name === "gameProjection");
  if (!stat || stat.value == null) return null;
  return stat.value > 1 ? stat.value / 100 : stat.value; // ESPN reports 0–100; normalise to 0–1
}

export async function getWinProbability(eventId, competitionId, { league = "nba" } = {}) {
  if (!eventId || !competitionId) return null;
  const urls = urlsFor(league);
  // Pre-game: ESPN's BPI predictor.
  const predictor = await jsonFetch(
    `${urls.CORE}/events/${eventId}/competitions/${competitionId}/predictor`
  );
  if (predictor) {
    const home = pickGameProjection(predictor.homeTeam);
    const away = pickGameProjection(predictor.awayTeam);
    if (home != null || away != null) {
      return {
        source: "predictor",
        home_win_pct: home ?? (away != null ? 1 - away : null),
        away_win_pct: away ?? (home != null ? 1 - home : null),
      };
    }
  }
  // In-game / post-game fallback.
  const probs = await jsonFetch(
    `${urls.CORE}/events/${eventId}/competitions/${competitionId}/probabilities?limit=200`
  );
  const items = probs?.items || [];
  if (!items.length) return null;
  const latest = items[items.length - 1];
  const home = latest.homeWinPercentage;
  const away = latest.awayWinPercentage;
  if (home == null && away == null) return null;
  return {
    source: "probabilities",
    home_win_pct: home,
    away_win_pct: away ?? (home != null ? 1 - home : null),
  };
}

function normalizeInjury(entry) {
  return {
    player: entry.athlete?.displayName || entry.athlete?.fullName || null,
    status: entry.status || entry.type?.description || null,
    type: entry.type?.description || entry.details?.type || null,
    detail: entry.shortComment || entry.longComment || entry.details?.detail || null,
    date: entry.date || null,
  };
}

export async function getAllInjuries({ league = "nba" } = {}) {
  const urls = urlsFor(league);
  return cache.swr(
    `injuries:${league}:all`,
    async () => {
      const data = await jsonFetch(`${urls.SITE}/injuries`);
      if (!data) return null;
      const groups = data.injuries || [];
      return groups.map((g) => ({
        team_id: String(g.id),
        team_name: g.displayName,
        injuries: (g.injuries || []).map(normalizeInjury),
      }));
    },
    { freshTtlMs: TTL_INJURIES_FRESH_MS, staleTtlMs: TTL_INJURIES_STALE_MS }
  );
}

export async function getTeamInjuries(teamId, { league = "nba" } = {}) {
  if (!teamId) return null;
  const all = await getAllInjuries({ league });
  if (!all) return null;
  const id = String(teamId);
  const group = all.find((g) => g.team_id === id);
  return group?.injuries ?? [];
}
