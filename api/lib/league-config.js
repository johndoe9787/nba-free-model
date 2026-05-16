// Single source of truth for per-league configuration. Every layer that
// previously hardcoded NBA values (stats.nba.com LeagueID, ESPN URL path,
// team-id-to-abbr maps, framework thresholds) now reads from here.

export const NBA_TEAM_ID_TO_ABBR = {
  1610612737: "ATL", 1610612738: "BOS", 1610612739: "CLE", 1610612740: "NOP",
  1610612741: "CHI", 1610612742: "DAL", 1610612743: "DEN", 1610612744: "GSW",
  1610612745: "HOU", 1610612746: "LAC", 1610612747: "LAL", 1610612748: "MIA",
  1610612749: "MIL", 1610612750: "MIN", 1610612751: "BKN", 1610612752: "NYK",
  1610612753: "ORL", 1610612754: "IND", 1610612755: "PHI", 1610612756: "PHX",
  1610612757: "POR", 1610612758: "SAC", 1610612759: "SAS", 1610612760: "OKC",
  1610612761: "TOR", 1610612762: "UTA", 1610612763: "MEM", 1610612764: "WAS",
  1610612765: "DET", 1610612766: "CHA",
};

// WNBA team IDs from stats.wnba.com/stats/commonteamyears?LeagueID=10. PDX
// is a historical/inactive franchise included here for completeness; TOR
// (Toronto Tempo) joined as an expansion team in 2026.
export const WNBA_TEAM_ID_TO_ABBR = {
  1611661313: "NYL",
  1611661317: "PHX",
  1611661319: "LVA",
  1611661320: "LAS",
  1611661321: "DAL",
  1611661322: "WAS",
  1611661323: "CON",
  1611661324: "MIN",
  1611661325: "IND",
  1611661327: "PDX",
  1611661328: "SEA",
  1611661329: "CHI",
  1611661330: "ATL",
  1611661331: "GSV",
  1611661332: "TOR",
};

// stats.nba.com abbrs that disagree with ESPN's spelling. Only entries that
// actually mismatch — most abbrs (ATL, BOS, MIN, etc.) are identical.
const NBA_TO_ESPN_ABBR = {
  NYK: "NY",
  SAS: "SA",
  NOP: "NO",
  GSW: "GS",
  UTA: "UTAH",
  WAS: "WSH",
};

// stats.wnba.com and ESPN diverge on a handful of WNBA abbreviations:
//   WAS → WSH, LVA → LV, LAS → LA
// PHX, NYL, GSV, TOR, ATL, CHI, CON, DAL, IND, MIN, SEA, PDX match unchanged.
const WNBA_TO_ESPN_ABBR = {
  WAS: "WSH",
  LVA: "LV",
  LAS: "LA",
};

const CONFIGS = {
  nba: {
    league: "nba",
    display_name: "NBA",
    stats_league_id: "00",
    espn_sport_path: "basketball/nba",
    espn_league_path: "basketball/leagues/nba",
    team_id_to_abbr: NBA_TEAM_ID_TO_ABBR,
    stats_to_espn_abbr: NBA_TO_ESPN_ABBR,
    framework: {
      league_name: "NBA",
      game_minutes: 48,
      // Rule 5a road points deduction.
      road_deduction_pts: 1.5,
      // Rule 5i worst-case FG floor vs elite D, keyed by normalized position.
      // Guards are smaller-volume FG scorers vs elite D; centers retain the
      // highest floor from rim/putback opportunities even when locked up.
      ft_floor_by_position: { G: 6, F: 8, C: 10 },
      // Rule 5a addendum threshold: widen OVER buffer when ppg σ exceeds this.
      variance_threshold_ppg: 6,
      // Playoff series lengths used in the Game 1 / Game 2 hard caps.
      playoff_series: { first_round: 7, semis: 7, conf_finals: 7, finals: 7 },
    },
  },
  wnba: {
    league: "wnba",
    display_name: "WNBA",
    stats_league_id: "10",
    espn_sport_path: "basketball/wnba",
    espn_league_path: "basketball/leagues/wnba",
    team_id_to_abbr: WNBA_TEAM_ID_TO_ABBR,
    stats_to_espn_abbr: WNBA_TO_ESPN_ABBR,
    framework: {
      league_name: "WNBA",
      game_minutes: 40,
      // WNBA scoring scales ~83% of NBA (40/48 of game length). Road
      // deduction and FT-floor baseline scale proportionally.
      road_deduction_pts: 1.2,
      ft_floor_by_position: { G: 4, F: 6, C: 8 },
      // ppg σ threshold scaled by 40/48 from the NBA 6.0 — round to 5.
      variance_threshold_ppg: 5,
      // WNBA 2024+ format: best-of-3 first round, best-of-5 semis, best-of-7 finals.
      playoff_series: { first_round: 3, semis: 5, conf_finals: 5, finals: 7 },
    },
  },
};

export function getLeagueConfig(league) {
  const cfg = CONFIGS[String(league || "nba").toLowerCase()];
  if (!cfg) throw new Error(`Unknown league: ${league}`);
  return cfg;
}

export function isValidLeague(league) {
  return Object.prototype.hasOwnProperty.call(CONFIGS, String(league || "").toLowerCase());
}
