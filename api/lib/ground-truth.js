// Pure composer. Takes raw outputs from nba-stats / espn helpers and produces
// the typed groundTruth payload + a list of missing required fields.
// No fetches here.

import { toEspnAbbr } from "./espn.js";
import { computeWeightedL5, matchesOpponent } from "./weighted-l5.js";

export function composeGroundTruth({
  player,
  propType,
  line,
  league = "nba",
  leagueCfg,      // Required for derived.ft_floor_baseline lookup
  info,           // commonPlayerInfo (NBA stats) — info.position used for FT-floor
  game,           // ESPN game (or null)
  daysOut = 0,   // 0 = today, 1+ = upcoming game found via lookahead
  seasonType,    // "Regular Season" | "Playoffs"
  seasonAvg,     // Regular-season averages, used as stable baseline
  l5,            // Last 5 in current seasonType
  l20,           // Last 20 in current seasonType — used for variance only (averages unchanged)
  splits,        // Home/Away splits (regular season)
  winProb,       // ESPN predictor result
  allInjuries,   // ESPN league-wide injury list
  opponentDefense, // { def_rating, def_rank, source } | null
  primaryDefender, // { player, defender_id, share_pct, n_games, total_poss, confirmed, source } | null
}) {
  const playerAbbr = info?.team_abbr ?? null;
  const playerEspnAbbr = toEspnAbbr(playerAbbr, league);

  const homeAway = (playerEspnAbbr && game)
    ? (game.home.abbr === playerEspnAbbr ? "home"
      : game.away.abbr === playerEspnAbbr ? "away"
      : null)
    : null;

  const playerSide   = homeAway === "home" ? game?.home : homeAway === "away" ? game?.away : null;
  const opponentSide = homeAway === "home" ? game?.away : homeAway === "away" ? game?.home : null;

  const sliceInjuries = (espnTeamId) => {
    if (!allInjuries || !espnTeamId) return [];
    const group = allInjuries.find((g) => g.team_id === String(espnTeamId));
    return group?.injuries ?? [];
  };

  const ownInjuries = sliceInjuries(playerSide?.team_id);
  const oppInjuries = sliceInjuries(opponentSide?.team_id);

  const isListedInjured = ownInjuries.some(
    (i) => i.player && namesMatch(i.player, player)
  );

  const series = buildSeriesState({ game, playerSide, opponentSide, l5, seasonType });

  const winPctForPlayer = winProb
    ? (homeAway === "home" ? winProb.home_win_pct : winProb.away_win_pct)
    : null;

  const groundTruth = {
    player: info?.full_name ?? player,
    prop_type: propType,
    line: Number(line),
    game: game ? {
      date: game.date,
      state: game.state,
      days_out: daysOut,
      home_team: game.home.name,
      away_team: game.away.name,
    } : null,
    player_team: playerSide ? {
      espn_id: playerSide.team_id,
      abbr: playerSide.abbr,
      name: playerSide.name,
    } : null,
    opponent_team: opponentSide ? {
      espn_id: opponentSide.team_id,
      abbr: opponentSide.abbr,
      name: opponentSide.name,
    } : null,
    home_away: homeAway,
    season: seasonAvg ? {
      label: seasonAvg.season,
      type: seasonAvg.season_type,
      averages: pickAverages(seasonAvg),
    } : null,
    l5: l5 ? {
      type: l5.season_type,
      n: l5.n,
      games: l5.games,
      averages: enrichL5Averages(l5.averages),
      weighted: computeWeightedL5(l5, seasonAvg, opponentDefense, {
        isPlayoff: seasonType === "Playoffs",
        seriesGamesPlayed: series?.games_played ?? 0,
        opponentAbbr: opponentSide?.abbr ?? null,
      }),
    } : null,
    splits: splits ? {
      home: splits.home ? pickAverages(splits.home) : null,
      road: splits.road ? pickAverages(splits.road) : null,
    } : null,
    win_prob: winProb ? {
      player_team_pct: winPctForPlayer,
      opponent_pct: homeAway === "home" ? winProb.away_win_pct : winProb.home_win_pct,
      source: winProb.source,
    } : null,
    injuries: {
      player_team: ownInjuries,
      opponent: oppInjuries,
    },
    player_recent: {
      is_listed_injured: isListedInjured,
    },
    opponent_defense: opponentDefense
      ? { ...opponentDefense, primary_defender: primaryDefender ?? null }
      : (primaryDefender ? { primary_defender: primaryDefender } : null),
    series,
    variance: computeVariance(l20?.games),
    derived: deriveValues({ info, leagueCfg }),
  };

  const missing = [];
  if (!groundTruth.season)         missing.push("season_avg");
  if (!groundTruth.l5)             missing.push("l5_avg");
  if (!groundTruth.home_away)      missing.push("home_away");
  if (!groundTruth.opponent_team)  missing.push("opponent");
  if (needsWinProb(propType) && !groundTruth.win_prob) missing.push("win_prob");

  return { groundTruth, missing };
}

function enrichL5Averages(a) {
  if (!a) return a;
  const round1 = (n) => Number(n.toFixed(1));
  const ppg = a.ppg ?? 0;
  const rpg = a.rpg ?? 0;
  const apg = a.apg ?? 0;
  return {
    ...a,
    pra: round1(ppg + rpg + apg),
    pr: round1(ppg + rpg),
    pa: round1(ppg + apg),
    ra: round1(rpg + apg),
  };
}

// Population σ over a per-game sample. n<8 returns nulls — a smaller window
// is too noisy for the Rule 5a addendum to act on. stats.nba.com playergamelog
// supplies pts/reb/ast as integers per game, so square-root of variance is
// stable as soon as 8+ games exist.
export function computeVariance(games) {
  if (!Array.isArray(games) || games.length < 8) {
    return { ppg_stddev: null, rpg_stddev: null, apg_stddev: null, n_games: games?.length ?? 0 };
  }
  const sigma = (key) => {
    const xs = games.map((g) => g[key] ?? 0);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length;
    return Number(Math.sqrt(variance).toFixed(2));
  };
  return {
    ppg_stddev: sigma("pts"),
    rpg_stddev: sigma("reb"),
    apg_stddev: sigma("ast"),
    n_games: games.length,
  };
}

// stats.nba.com `commonplayerinfo.POSITION` returns NBA-style strings:
// "Guard", "Forward", "Center", "Guard-Forward", "Forward-Guard",
// "Forward-Center", "Center-Forward". Hyphenated forms list the primary
// designation first.
export function normalizePosition(raw) {
  if (!raw || typeof raw !== "string") return null;
  const primary = raw.split("-")[0].trim().toLowerCase();
  if (primary === "guard") return "G";
  if (primary === "forward") return "F";
  if (primary === "center") return "C";
  return null;
}

function deriveValues({ info, leagueCfg }) {
  const table = leagueCfg?.framework?.ft_floor_by_position;
  if (!table) return null;
  const pos = normalizePosition(info?.position);
  // Forward used as the safe fallback when ESPN/balldontlie identity paths
  // didn't supply position — F sits between G and C in every league table.
  const ft_floor_baseline = table[pos] ?? table.F;
  return { player_position: pos, ft_floor_baseline };
}

function pickAverages(s) {
  const ppg = s.ppg ?? 0;
  const rpg = s.rpg ?? 0;
  const apg = s.apg ?? 0;
  const round1 = (n) => Number(n.toFixed(1));
  return {
    games: s.games,
    minutes: s.minutes,
    ppg: s.ppg,
    rpg: s.rpg,
    apg: s.apg,
    pra: round1(ppg + rpg + apg),
    pr: round1(ppg + rpg),
    pa: round1(ppg + apg),
    ra: round1(rpg + apg),
    fgm: s.fgm,
    fga: s.fga,
    fg_pct: s.fg_pct,
    fg3m: s.fg3m,
    fg3a: s.fg3a,
    fg3_pct: s.fg3_pct,
    ftm: s.ftm,
    fta: s.fta,
    ft_pct: s.ft_pct,
    blk: s.blk,
    stl: s.stl,
    tov: s.tov,
  };
}

function needsWinProb(propType) {
  // Rule 5f (blowout) caps OVERs; Rule 5c gates assist props.
  return /\bOVER\b/i.test(propType) || /assist/i.test(propType);
}

function normalize(s) {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[.'’-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function namesMatch(a, b) {
  return normalize(a) === normalize(b);
}

function leadingTeamAbbr({ playerWins, opponentWins, playerSide, opponentSide }) {
  if (playerWins > opponentWins) return playerSide?.abbr ?? null;
  if (opponentWins > playerWins) return opponentSide?.abbr ?? null;
  return null; // tied — no leader
}

function buildSeriesState({ game, playerSide, opponentSide, l5, seasonType }) {
  // Authoritative path: ESPN attaches series state to playoff scoreboard
  // events. Match by ESPN team_id (no abbreviation aliasing). Pre-formatted
  // summary string ("BOS leads series 3-1") comes straight from ESPN.
  const espn = game?.series;
  if (espn && espn.type === "playoff" && playerSide && opponentSide) {
    const playerComp = espn.competitors?.find(
      (c) => String(c.id) === String(playerSide.team_id)
    );
    const oppComp = espn.competitors?.find(
      (c) => String(c.id) === String(opponentSide.team_id)
    );
    const playerWins = playerComp?.wins ?? 0;
    const opponentWins = oppComp?.wins ?? 0;
    const gamesPlayed = playerWins + opponentWins;
    return {
      games_played: gamesPlayed,
      player_team_wins: playerWins,
      opponent_wins: opponentWins,
      next_game_number: gamesPlayed + 1,
      series_record: `${playerWins}-${opponentWins}`,
      series_summary: espn.summary ?? null,
      leading_team_abbr: leadingTeamAbbr({ playerWins, opponentWins, playerSide, opponentSide }),
      round: game.round ?? null,
      source: "espn_event",
    };
  }

  // Fallback: ESPN didn't tag the event with series data but we forced
  // seasonType=Playoffs upstream. Reconstruct from gamelog (less reliable
  // — capped at L5, anchored substring match).
  if (seasonType === "Playoffs" && l5?.games?.length && opponentSide) {
    const derived = deriveSeriesFromL5(l5.games, opponentSide.abbr);
    return {
      ...derived,
      leading_team_abbr: leadingTeamAbbr({
        playerWins: derived.player_team_wins,
        opponentWins: derived.opponent_wins,
        playerSide,
        opponentSide,
      }),
      source: "l5_fallback",
    };
  }

  return null;
}

function deriveSeriesFromL5(games, oppAbbr) {
  const vs = games.filter((g) => matchesOpponent(g.matchup, oppAbbr));
  let pw = 0, ow = 0;
  for (const g of vs) {
    if (g.result === "W") pw++;
    else if (g.result === "L") ow++;
  }
  return {
    games_played: vs.length,
    player_team_wins: pw,
    opponent_wins: ow,
    next_game_number: vs.length + 1,
    series_record: `${pw}-${ow}`,
    series_summary: null,
    round: null,
  };
}
