// Weighted L5 baseline (v3.5). Pure module — no fetches.
//
// Combines three multipliers per game:
//   - recency ramp (0.10 oldest → 0.30 most recent)
//   - opponent quality (def_rank tier, 0.80..1.15) — replaced by series-game
//     modifier on the playoff path when ≥3 of the L5 games are against the
//     current opponent
//   - outlier dampener (0.60 hot / 0.85 cold, vs season.ppg)
//
// Caveats baked into v1:
//   - opponent_defense.def_rank is a CURRENT-SEASON SNAPSHOT used as proxy
//     for every game in the regular-season window. Per-game historical
//     def_rank lookup is deferred to v2.
//   - The recency ramp 0.10/0.15/0.20/0.25/0.30 is a placeholder pending
//     empirical re-calibration after ~20 tracked v3.5 picks.
//   - When the playoff L5 has <3 games vs the current opponent, the module
//     returns mode="playoff_raw_fallback" with weighted == raw; the
//     framework instructs Gemini to fall back to the raw baseline and emit
//     a small-sample flag.

// NBA team abbreviations are unique 3-letter strings; anchor the match to
// non-letter boundaries to avoid substring overlap (e.g. "BOS" inside a
// hypothetical "BOSTON" matchup string).
export function matchesOpponent(matchup, oppAbbr) {
  if (!matchup || !oppAbbr) return false;
  const re = new RegExp(`(^|[^A-Z])${oppAbbr.toUpperCase()}([^A-Z]|$)`);
  return re.test(matchup.toUpperCase());
}

const RECENCY = [0.30, 0.25, 0.20, 0.15, 0.10];

const STAT_KEYS = [
  "ppg", "rpg", "apg", "fgm", "fga", "ftm", "fta",
  "blk", "stl", "tov", "minutes", "pra",
];

const GAME_KEY = {
  ppg: "pts", rpg: "reb", apg: "ast",
  fgm: "fgm", fga: "fga", ftm: "ftm", fta: "fta",
  blk: "blk", stl: "stl", tov: "tov",
  minutes: "minutes", pra: "pra",
};

function opponentMultiplier(defRank) {
  if (defRank == null) return 1.00;
  if (defRank <= 5) return 1.15;
  if (defRank <= 15) return 1.00;
  if (defRank <= 25) return 0.90;
  return 0.80;
}

function seriesMultiplier(seriesGameNumber) {
  if (seriesGameNumber === 1 || seriesGameNumber === 2) return 0.75;
  if (seriesGameNumber === 3 || seriesGameNumber === 4) return 1.00;
  return 1.20;
}

function outlierMultiplier(pts, seasonPpg) {
  if (seasonPpg == null || !Number.isFinite(seasonPpg) || seasonPpg <= 0) return 1.00;
  if (pts > 1.5 * seasonPpg) return 0.60;
  if (pts < 0.50 * seasonPpg) return 0.85;
  return 1.00;
}

function round1(n) {
  return Number(n.toFixed(1));
}

export function computeWeightedL5(l5, seasonAvg, opponentDefense, {
  isPlayoff = false,
  seriesGamesPlayed = 0,
  opponentAbbr = null,
} = {}) {
  const games = l5?.games;
  if (!games?.length) return null;

  const seasonPpg = seasonAvg?.ppg ?? null;
  const defRank = opponentDefense?.def_rank ?? null;

  const n = games.length;

  // Playoff fallback: not enough series games to anchor the series-game
  // modifier. Return raw averages so the framework can detect the mode
  // and emit the small-sample flag.
  if (isPlayoff) {
    const matched = opponentAbbr
      ? games.filter((g) => matchesOpponent(g.matchup, opponentAbbr))
      : [];
    if (matched.length < 3) {
      const rawAvgs = enrich(l5.averages);
      return {
        averages: rawAvgs,
        raw_vs_weighted_delta: { ppg: 0, rpg: 0, apg: 0, pra: 0 },
        outlier_present: false,
        weights: new Array(n).fill(1 / n),
        mode: "playoff_raw_fallback",
      };
    }
  }

  // Build per-game multipliers. For the playoff path, identify which of the
  // L5 games are series games vs the current opponent and assign them
  // ordinal series-game numbers. Games not vs the current opponent
  // (prior-round leftovers) get w_series = 1.00 so they still contribute.
  let perGameOppOrSeries;
  let mode;
  if (isPlayoff) {
    mode = "playoff_series";
    const seriesIndicesOldestFirst = [];
    for (let i = n - 1; i >= 0; i--) {
      if (matchesOpponent(games[i].matchup, opponentAbbr)) {
        seriesIndicesOldestFirst.push(i);
      }
    }
    const k = seriesIndicesOldestFirst.length;
    const firstSeriesGameNumber = seriesGamesPlayed - k + 1;
    const indexToSeriesGame = new Map();
    seriesIndicesOldestFirst.forEach((idx, ord) => {
      indexToSeriesGame.set(idx, firstSeriesGameNumber + ord);
    });
    perGameOppOrSeries = games.map((_, i) => {
      const sg = indexToSeriesGame.get(i);
      return sg != null ? seriesMultiplier(sg) : 1.00;
    });
  } else {
    mode = "regular";
    perGameOppOrSeries = games.map(() => opponentMultiplier(defRank));
  }

  const perGameOutlier = games.map((g) => outlierMultiplier(g.pts ?? 0, seasonPpg));
  const outlier_present = perGameOutlier.some((m) => m === 0.60);

  const rawWeights = games.map((_, i) =>
    RECENCY[i] * perGameOppOrSeries[i] * perGameOutlier[i]
  );
  const W = rawWeights.reduce((s, w) => s + w, 0);
  const weights = W > 0 ? rawWeights.map((w) => w / W) : new Array(n).fill(1 / n);

  const weighted = {};
  for (const stat of STAT_KEYS) {
    const gKey = GAME_KEY[stat];
    const sum = games.reduce((s, g, i) => s + ((g[gKey] ?? 0) * weights[i]), 0);
    weighted[stat] = round1(sum);
  }
  // Mirror enrichL5Averages: pra/pr/pa/ra come from the weighted ppg/rpg/apg
  // so they stay consistent with the underlying components.
  weighted.pr = round1(weighted.ppg + weighted.rpg);
  weighted.pa = round1(weighted.ppg + weighted.apg);
  weighted.ra = round1(weighted.rpg + weighted.apg);
  weighted.pra = round1(weighted.ppg + weighted.rpg + weighted.apg);

  const rawAvgs = l5.averages ?? {};
  const raw_vs_weighted_delta = {
    ppg: round1((weighted.ppg ?? 0) - (rawAvgs.ppg ?? 0)),
    rpg: round1((weighted.rpg ?? 0) - (rawAvgs.rpg ?? 0)),
    apg: round1((weighted.apg ?? 0) - (rawAvgs.apg ?? 0)),
    pra: round1((weighted.pra ?? 0) - ((rawAvgs.ppg ?? 0) + (rawAvgs.rpg ?? 0) + (rawAvgs.apg ?? 0))),
  };

  return {
    averages: weighted,
    raw_vs_weighted_delta,
    outlier_present,
    weights: weights.map((w) => Number(w.toFixed(4))),
    mode,
  };
}

function enrich(a) {
  if (!a) return a;
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
