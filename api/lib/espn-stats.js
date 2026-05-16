// ESPN athlete-stats client — fallback for stats.nba.com (which 4xxs from
// Vercel egress IPs). One gamelog call covers both season averages and L5,
// since ESPN buckets events by season type (Regular / Postseason) and
// includes per-game positional stat arrays.
//
// Endpoint: site.web.api.espn.com/.../athletes/{id}/gamelog?season={endYear}
// where season is the END year of the season label, e.g. 2026 for "2025-26".

import { logPrefix } from "./request-context.js";
import { getLeagueConfig } from "./league-config.js";

function gamelogBase(league) {
  const cfg = getLeagueConfig(league);
  return `https://site.web.api.espn.com/apis/common/v3/sports/${cfg.espn_sport_path}/athletes`;
}

// Statistic positions in event.stats[] differ between leagues — ESPN reorders
// the gamelog columns on the WNBA endpoint (PTS/REB/AST come right after MIN
// instead of after the shooting block). We hard-code per-league indices
// because ESPN's WNBA bucket ships no labels array, leaving the layout
// validator with nothing to check against. If the on-screen ESPN.com gamelog
// header order ever changes, refresh this map.
const IDX_BY_LEAGUE = {
  nba: {
    minutes: 0,
    fgma: 1,        // "FGM-FGA"
    fg_pct: 2,
    fg3ma: 3,       // "3PM-3PA"
    fg3_pct: 4,
    ftma: 5,        // "FTM-FTA"
    ft_pct: 6,
    reb: 7,
    ast: 8,
    blk: 9,
    stl: 10,
    pf: 11,
    to: 12,
    pts: 13,
  },
  wnba: {
    minutes: 0,
    pts: 1,
    reb: 2,
    ast: 3,
    stl: 4,
    blk: 5,
    to: 6,
    fgma: 7,        // "FGM-FGA"
    fg_pct: 8,
    fg3ma: 9,       // "3PM-3PA"
    fg3_pct: 10,
    ftma: 11,       // "FTM-FTA"
    ft_pct: 12,
    pf: 13,
  },
};

function endYearFromSeasonLabel(label) {
  if (typeof label === "number") return label;
  const str = String(label);
  // NBA cross-year label: "2025-26" → end year 2026.
  const cross = str.match(/^(\d{4})-(\d{2})$/);
  if (cross) return Number(cross[1]) + 1;
  // WNBA single-year label: "2026" → end year 2026.
  const single = str.match(/^(\d{4})$/);
  if (single) return Number(single[1]);
  return null;
}

function seasonLabelFromEndYear(endYear, league = "nba") {
  if (league === "wnba") return String(endYear);
  return `${endYear - 1}-${String(endYear % 100).padStart(2, "0")}`;
}

function num(s) {
  if (s == null || s === "") return 0;
  const n = Number(s);
  return Number.isNaN(n) ? 0 : n;
}

function splitFgPair(s) {
  if (typeof s !== "string") return [0, 0];
  const [m, a] = s.split("-").map(num);
  return [m, a];
}

function parseStatsRow(stats, league = "nba") {
  const idx = IDX_BY_LEAGUE[league] ?? IDX_BY_LEAGUE.nba;
  const [fgm, fga] = splitFgPair(stats[idx.fgma]);
  const [fg3m, fg3a] = splitFgPair(stats[idx.fg3ma]);
  const [ftm, fta] = splitFgPair(stats[idx.ftma]);
  return {
    minutes: num(stats[idx.minutes]),
    fgm, fga,
    fg_pct: num(stats[idx.fg_pct]) / 100,
    fg3m, fg3a,
    fg3_pct: num(stats[idx.fg3_pct]) / 100,
    ftm, fta,
    ft_pct: num(stats[idx.ft_pct]) / 100,
    reb: num(stats[idx.reb]),
    ast: num(stats[idx.ast]),
    blk: num(stats[idx.blk]),
    stl: num(stats[idx.stl]),
    tov: num(stats[idx.to]),
    pts: num(stats[idx.pts]),
  };
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, "0")}, ${d.getUTCFullYear()}`;
}

async function fetchGamelog(athleteId, endYear, league = "nba") {
  const url = `${gamelogBase(league)}/${athleteId}/gamelog?season=${endYear}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.error(`${logPrefix()}espn gamelog ${athleteId} ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`${logPrefix()}espn gamelog ${athleteId} threw:`, err.message);
    return null;
  }
}

function findBucket(seasonTypes, postseason) {
  if (!Array.isArray(seasonTypes)) return null;
  const re = postseason ? /post/i : /regular/i;
  return seasonTypes.find((s) => re.test(s.displayName)) ?? null;
}

function flatEvents(bucket) {
  if (!bucket?.categories) return [];
  return bucket.categories.flatMap((c) => c.events ?? []).filter((e) => Array.isArray(e.stats));
}

// ESPN's gamelog response carries a column-name array on the season-type
// bucket (or per category). If they ever reorder or insert a column, the
// hard-coded IDX positions silently produce wrong averages. Validate the
// layout matches expectations before trusting parseStatsRow output. ESPN
// currently ships labels on NBA buckets but omits them on WNBA buckets.
const EXPECTED_LABELS_BY_LEAGUE = {
  nba: [
    "MIN", "FG", "FG%", "3PT", "3P%", "FT", "FT%",
    "REB", "AST", "BLK", "STL", "PF", "TO", "PTS",
  ],
  wnba: [
    "MIN", "PTS", "REB", "AST", "STL", "BLK", "TO",
    "FG", "FG%", "3PT", "3P%", "FT", "FT%", "PF",
  ],
};

function findLabels(bucket) {
  if (!bucket) return null;
  if (Array.isArray(bucket.labels) && bucket.labels.length) return bucket.labels;
  if (Array.isArray(bucket.names) && bucket.names.length) return bucket.names;
  if (Array.isArray(bucket.displayNames) && bucket.displayNames.length) return bucket.displayNames;
  for (const c of bucket.categories ?? []) {
    if (Array.isArray(c.labels) && c.labels.length) return c.labels;
    if (Array.isArray(c.names) && c.names.length) return c.names;
  }
  return null;
}

function bucketLayoutOk(bucket, league = "nba") {
  const expected = EXPECTED_LABELS_BY_LEAGUE[league] ?? EXPECTED_LABELS_BY_LEAGUE.nba;
  const labels = findLabels(bucket);
  if (!labels) return true; // absent — happy path, IDX assumed
  if (labels.length < expected.length) {
    console.error(`${logPrefix()}espn ${league} gamelog layout diverged: expected >=${expected.length} cols, got ${labels.length}`);
    return false;
  }
  for (let i = 0; i < expected.length; i++) {
    if (String(labels[i]).toUpperCase() !== expected[i]) {
      console.error(`${logPrefix()}espn ${league} gamelog layout diverged at col ${i}: expected "${expected[i]}", got "${labels[i]}"`);
      return false;
    }
  }
  return true;
}

export async function getSeasonAverages(athleteId, { season, league = "nba" } = {}) {
  if (!athleteId) return null;
  const endYear = endYearFromSeasonLabel(season);
  if (!endYear) return null;
  const data = await fetchGamelog(athleteId, endYear, league);
  if (!data) return null;
  const bucket = findBucket(data.seasonTypes, false);
  if (!bucketLayoutOk(bucket, league)) return null;
  const events = flatEvents(bucket);
  if (!events.length) return null;
  const rows = events.map((e) => parseStatsRow(e.stats, league));
  const avg = (k) => Number((rows.reduce((s, r) => s + (r[k] || 0), 0) / rows.length).toFixed(2));
  return {
    season: seasonLabelFromEndYear(endYear, league),
    season_type: "Regular Season",
    games: rows.length,
    minutes: avg("minutes"),
    ppg: avg("pts"),
    rpg: avg("reb"),
    apg: avg("ast"),
    fgm: avg("fgm"),
    fga: avg("fga"),
    fg_pct: avg("fg_pct"),
    fg3m: avg("fg3m"),
    fg3a: avg("fg3a"),
    fg3_pct: avg("fg3_pct"),
    ftm: avg("ftm"),
    fta: avg("fta"),
    ft_pct: avg("ft_pct"),
    blk: avg("blk"),
    stl: avg("stl"),
    tov: avg("tov"),
  };
}

export async function getLastNGames(athleteId, n = 5, { season, postseason = false, league = "nba" } = {}) {
  if (!athleteId) return null;
  const endYear = endYearFromSeasonLabel(season);
  if (!endYear) return null;
  const data = await fetchGamelog(athleteId, endYear, league);
  if (!data) return null;
  const bucket = findBucket(data.seasonTypes, postseason);
  if (!bucketLayoutOk(bucket, league)) return null;
  const events = flatEvents(bucket);
  if (!events.length) return null;

  const meta = data.events ?? {};
  const enriched = events.map((e) => {
    const m = meta[e.eventId];
    const row = parseStatsRow(e.stats, league);
    const oppAbbr = m?.opponent?.abbreviation ?? "?";
    const ownAbbr = m?.team?.abbreviation ?? "";
    const atVs = m?.atVs ?? "vs";
    const matchup = ownAbbr ? `${ownAbbr} ${atVs} ${oppAbbr}` : `${atVs} ${oppAbbr}`;
    return {
      eventId: e.eventId,
      gameDate: m?.gameDate,
      matchup,
      result: m?.gameResult ?? null,
      ...row,
    };
  });
  enriched.sort((a, b) => new Date(b.gameDate || 0).getTime() - new Date(a.gameDate || 0).getTime());

  const top = enriched.slice(0, n);
  const games = top.map((g) => ({
    game_id: String(g.eventId),
    date: fmtDate(g.gameDate),
    matchup: g.matchup,
    result: g.result,
    minutes: g.minutes,
    pts: g.pts,
    reb: g.reb,
    ast: g.ast,
    fg3m: g.fg3m,
    fg3a: g.fg3a,
    fgm: g.fgm,
    fga: g.fga,
    fg_pct: g.fg_pct,
    ftm: g.ftm,
    fta: g.fta,
    blk: g.blk,
    stl: g.stl,
    tov: g.tov,
    pra: g.pts + g.reb + g.ast,
  }));
  if (!games.length) return null;
  const avg = (k) => Number((games.reduce((s, g) => s + (g[k] || 0), 0) / games.length).toFixed(2));
  return {
    season: seasonLabelFromEndYear(endYear, league),
    season_type: postseason ? "Playoffs" : "Regular Season",
    n: games.length,
    games,
    averages: {
      ppg: avg("pts"),
      rpg: avg("reb"),
      apg: avg("ast"),
      fg3m: avg("fg3m"),
      fg3a: avg("fg3a"),
      fgm: avg("fgm"),
      fga: avg("fga"),
      ftm: avg("ftm"),
      fta: avg("fta"),
      blk: avg("blk"),
      stl: avg("stl"),
      tov: avg("tov"),
      pra: avg("pra"),
      minutes: avg("minutes"),
    },
  };
}
