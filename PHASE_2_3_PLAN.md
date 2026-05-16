# Quant Roadmap — Phase 2 and Phase 3

This document is the implementation plan for the next two phases of the model's evolution from a rule engine toward a calibrated quant model. Phase 1 (variance σ, position-keyed FT floor, tentative EV, pick log) shipped in commit `e0b4d0e`. This doc covers what comes after — gated on accumulated pick-log data.

Read this when the pick log has enough outcomes to unlock either phase. The gating criteria are explicit and non-negotiable: implementing these before the data exists encodes noise as signal and produces worse outputs than the current rule engine.

---

## Context

The framework was reviewed in 2026-05 against a "rule engine vs quant model" critique. The critique's technical points were correct; its sequencing was wrong (it assumed data that didn't exist). The phased adoption splits the work as follows:

- **Phase 1 (done):** Game-log-driven additions that need no pick-log data — per-player σ for variance-adjusted buffers, position-keyed FT floor lookup, tentative EV from tier midpoints, and the pick log itself with Wilson 95% CI on hit rate.
- **Phase 2 (this doc):** Fit β coefficients for situational adjustments (road, win_prob, injury, B2B, def_rank) from outcome-tagged picks; build a per-tier calibration plot.
- **Phase 3 (this doc):** Replace L5/season heuristic with a Kalman filter; emit explicit P(over) per pick; model PRA component correlation with a Gaussian copula.

**Architectural constraint:** Gemini stays as the verdict synthesizer. The quant outputs (β-adjusted baselines, Kalman estimate, P(over)) are computed in `api/lib/` and exposed in `groundTruth` as additional inputs Gemini reasons over. The qualitative rules (5h named defender, 4j sole alpha, 5g UNDER mechanism identification) require judgment that won't survive a move to pure regression.

---

## Phase 2 — Fitted Coefficients and Tier Calibration

### Gating Criteria (all must hold)

1. Pick log has **≥ 100 decided entries** (`outcome ∈ {W, L}`). Push and Void don't count toward the denominator.
2. The 100 entries span **≥ 3 distinct prop types** (e.g., Points, Rebounds, Assists) with **≥ 25 entries per type** to enable per-prop-type regression. If skew is severe (e.g., 90 Points / 10 Rebounds), defer the Rebounds/Assists fits until their counts pass 25.
3. Wilson 95% CI on overall hit rate has narrowed to **≤ ±10 percentage points** (sanity check that the sample is informative).
4. The user has explicitly invoked this phase. Don't auto-promote.

### 2a — Fit β Coefficients

**Goal:** Replace flat constants in Rules 5a (road), 5f (win_prob), 5h (def_rank), 6 (post-injury), and the back-to-back implicit penalty with player-archetype-aware regression coefficients fitted on the pick log.

**Inputs available per log entry** (`pickLog.v1` schema, `src/App.jsx:5-10`):
- `season_avg`, `l5_avg` — baselines at pick time
- `win_prob` — captured per pick
- `opponent` — needed to look up def_rank historically (current snapshot only; treat as proxy)
- `flags_summary` — parse for `"road"`, `"post-injury"`, `"back-to-back"` signals
- `direction`, `line`, `confidence`, `tier` — outcome features
- `outcome` — supervised label (`W` = 1, `L` = 0)

**Inputs already captured in the log (Phase 1.5, done in commit following `e0b4d0e`):**
- `is_road: bool` — derived from `ground_truth.home_away === "away"`
- `is_post_injury: bool` — from `ground_truth.player_recent.is_listed_injured`
- `def_rank: int | null` — from `ground_truth.opponent_defense.def_rank` (current snapshot, treated as proxy for historical pick dates)
- `position: "G" | "F" | "C" | null` — from `ground_truth.derived.player_position`
- `home_split_ppg`, `road_split_ppg` — from `ground_truth.splits.{home,road}.ppg`
- `weighted_l5_avg`, `outlier_present` — v3.5 weighted-L5 diagnostics
- `variance_ppg_stddev` — needed for the `β_variance × σ` interaction term
- `series_game_number` — from `ground_truth.series.next_game_number`, null in regular season

**Still missing — `is_back_to_back` (one outstanding gap):**

The current data layer does not fetch the player's previous game date. `is_back_to_back` is logged as `null` for every entry. Before fitting `β_b2b`, add previous-game-date computation:
- Extend `api/lib/nba-stats.js` (or `espn.js`) with `getPreviousGameDate(playerId, beforeDate)`.
- In `composeGroundTruth()`, compare `game.date` to the previous game date — if 1 calendar day apart, set `is_back_to_back = true`.
- Expose as `groundTruth.player_recent.is_back_to_back` and update App.jsx auto-append to read it.

Entries logged before this fix will have `is_back_to_back: null`; the regression fitter must treat null as missing and exclude those entries from the `β_b2b` coefficient specifically (but include them in fits for other coefficients). The schema is additive — no migration of existing v1 entries is needed; legacy entries simply lack the 1.5 fields.

**Regression model — per prop type:**

For Points OVER (and equivalent for each major prop):

```
P(W | features) = sigmoid(
    β₀
  + β_baseline_gap × (l5_avg − line)
  + β_road        × is_road
  + β_win_prob    × win_prob
  + β_def_rank    × (def_rank / 30)        # normalized 0–1
  + β_post_injury × is_post_injury
  + β_b2b         × is_back_to_back
  + β_variance    × variance.ppg_stddev    # interaction with high-σ players
)
```

Use logistic regression with L2 regularization. Fit per prop type — points, rebounds, assists separately. PRA/PR/PA are derived from components; either fit them as a fourth model or compute joint probability via Phase 3 copula.

**Implementation:**

- New module `api/lib/calibration/fit-coefficients.mjs` — pure offline tool. Reads pick log (export from UI, place at `data/pick-log-snapshot.json`). Outputs `data/fitted-coefficients.json` keyed by prop type.
- `npm` dependency: `ml-logistic-regression` or a minimal hand-rolled gradient descent (the dataset is small; a 30-line implementation is fine).
- Update `framework.js` to read coefficients from `groundTruth.coefficients` when present. Replace flat `f.road_deduction_pts` and equivalents with computed `β_road × is_road` deductions.
- Update `ground-truth.js` to load `fitted-coefficients.json` at composeGroundTruth time and attach to `groundTruth.coefficients`. Add `is_road`, `is_back_to_back`, `is_post_injury` to groundTruth so the values are inspectable in smoke tests.

**Critical files (Phase 2a):**
- `data/fitted-coefficients.json` (new)
- `data/pick-log-snapshot.json` (new — periodic export from UI)
- `api/lib/calibration/fit-coefficients.mjs` (new)
- `api/lib/ground-truth.js` (extend to attach coefficients)
- `api/lib/framework.js` (replace flat deductions with β-driven language)
- `src/App.jsx` (Phase 1.5 schema bump for raw feature capture — do this first)

**Verification:**
- Fit converges (loss decreases monotonically over 200+ iterations).
- Held-out 20% of the log: AUC > 0.55 (better than random; AUC > 0.65 is good).
- Sanity checks: `β_road` is negative for points; `β_def_rank` is positive (higher rank number = weaker D = higher P(W)); `β_post_injury` is negative or near-zero.
- Run `smoke-prompt.mjs` and confirm `groundTruth.coefficients` is non-null and the prompt cites β-adjusted baselines instead of flat numbers.

### 2b — Per-Tier Calibration Plot

**Goal:** Surface tier miscalibration. The tier midpoints used in Phase 1 (S=0.86, A=0.75, B=0.65, SKIP=0.50) are uncalibrated proxies. After 100+ decided picks, plot observed hit rate per tier and compare to the midpoint.

**Implementation:**
- New module `api/lib/calibration/tier-calibration.mjs` — reads pick log, buckets by tier, computes observed hit rate + Wilson CI per bucket.
- Output as a printable table in the UI's pick log header (under the existing summary CI line), or as a separate `/api/calibration` JSON endpoint.
- If observed S-tier hit rate is consistently below the band (e.g., 70% when label claims 82–90%), surface a flag in the framework prompt: "⚠️ S-tier currently calibrating at X% — tighten Section 2 conditions before issuing new S-tier picks."

**Verification:**
- Per-tier n ≥ 20 to be reported (smaller buckets produce noise, not signal).
- Wilson CI on each tier is displayed alongside the point estimate.

---

## Phase 3 — Kalman Baseline, P(over), and Copula

### Gating Criteria (all must hold)

1. Phase 2 shipped and at least 30 days of operation under fitted coefficients.
2. Pick log has **≥ 200 decided entries**.
3. Phase 2 calibration plot shows tier midpoints are within ±5pts of observed hit rate (else tier ranges need tightening first — Phase 2.5).
4. Explicit user greenlight. **This phase is a major architectural shift** — Gemini's role narrows from "decide the tier" to "explain why this P=0.74 pick is or isn't worth taking."

### 3a — Kalman Filter on Rolling Averages

**Goal:** Replace the L5/season step function ("if conflict ≥ 3pts, L5 governs") with an optimally-weighted blend of prior belief (season avg) and recent observation (per-game outputs). The weights are derived from observed signal-to-noise variance, not a hardcoded threshold.

**Why this is right:** The current step function is a heuristic approximation of what a Kalman filter does optimally. A player who shot 3/5 from three in 5 games is not a "6-per-36 shooter" — the filter pulls that back toward the true rate automatically.

**Model:**

For each player × stat, maintain a state `x_t` (the true underlying rate) updated each game:

```
Prediction:
  x_t|t-1 = x_t-1                       # rate is stationary day-to-day
  P_t|t-1 = P_t-1 + Q                   # variance grows without observation

Update (after game with observation y_t):
  K_t = P_t|t-1 / (P_t|t-1 + R)         # Kalman gain
  x_t = x_t|t-1 + K_t × (y_t − x_t|t-1)
  P_t = (1 − K_t) × P_t|t-1
```

Where `Q` is the process variance (how much the player's true rate drifts between games — small) and `R` is the observation variance (per-game noise — large, ≈ σ² from Phase 1). These are fit once per stat category from historical game logs.

**Implementation:**

- New module `api/lib/kalman-baseline.mjs` — exports `kalmanFilteredAvg(games, { Q, R, prior })`. Pure function, no fetches.
- `Q` and `R` priors stored in `data/kalman-priors.json`, keyed by stat (ppg/rpg/apg). Fit offline from full-season game logs of 50+ players (use `nba-stats.js` `getLastNGames` with n=82).
- `ground-truth.js` calls `kalmanFilteredAvg(season.games, priors)` and attaches result as `groundTruth.baseline.kalman` alongside the existing season/L5/weighted-L5 fields. Gemini sees all four; the framework prompt is updated to prefer `kalman` for baseline comparisons.
- Validation: hold out the most recent 20% of games per player; compute MSE of Kalman estimate vs raw L5 vs season avg. **Hard prerequisite: Kalman must beat both on held-out MSE before promotion to primary baseline.**

**Critical files (Phase 3a):**
- `api/lib/kalman-baseline.mjs` (new)
- `data/kalman-priors.json` (new)
- `scripts/fit-kalman-priors.mjs` (new — offline fitting)
- `api/lib/ground-truth.js` (extend baseline block)
- `api/lib/framework.js` (update baseline references)

### 3b — Explicit P(over) Per Pick

**Goal:** Replace tier labels with computed probabilities. P(over) becomes the primary model output; tiers become P-bucket labels (S = P ≥ 0.82, A = 0.70 ≤ P < 0.82, etc).

**Method:**

```
μ_adjusted = kalman_baseline 
           + β_road × is_road
           + β_win_prob × win_prob
           + β_def_rank × (def_rank / 30)
           + β_post_injury × is_post_injury
           + β_b2b × is_back_to_back
σ = variance.{stat}_stddev    # from Phase 1
P(over) = 1 − Φ((line − μ_adjusted) / σ)
```

**Distribution choice per stat — this matters:**
- **Points:** Use Student's t with df ≈ 10 (fatter tails than normal — star scorers have bimodal foul-trouble vs full-minutes distributions). Normal CDF systematically misprices the tails.
- **Rebounds, Assists, Blocks, Steals, Turnovers:** Negative binomial (count data, right-skewed). Fit `r` and `p` from historical game logs per player.
- **3PM:** Negative binomial with low mean, high overdispersion.
- **PRA, PR, PA, RA:** Compute via Phase 3c copula, *not* by summing component probabilities.

**Implementation:**
- New module `api/lib/probability.mjs` — exports `pOver({ stat, line, mu, sigma, distribution })`.
- Distribution selection table in `league-config.js` (or a new `prop-distributions.js`).
- `ground-truth.js` computes `groundTruth.probability` block with `p_over`, `mu_adjusted`, `sigma_used`, `distribution`.
- Framework prompt updates: Gemini's job becomes "given P = 0.74 and EV = +0.22 at 3× multiplier, is there any structural reason from the qualitative rules (5h, 4j, 5g) to override this number toward SKIP?" Tiers are derived from P, not assigned by prose rules.

**Verification:**
- Calibration plot per probability decile: do picks at P=0.70–0.80 hit ~75%? Acceptance criterion: observed hit rate within ±5pts of bucket midpoint across all deciles with n ≥ 20.
- Brier score on the held-out 20% of picks should be < 0.20 (random binary prediction is 0.25; perfect is 0).

### 3c — Gaussian Copula for Parlay Correlation

**Goal:** PRA OVER is not `P(pts > x) × P(reb > y) × P(ast > z)`. The components share a common cause (pace, foul trouble, minutes played). Treating them as independent overestimates parlay edge.

**Method:**

1. For each player, compute rank correlation matrix across (pts, reb, ast) over their last 30+ games. This is the **copula parameter**.
2. For a PRA OVER pick, transform each component's marginal P(over) into a standard normal quantile, then use the multivariate normal CDF with the player's correlation matrix to compute joint probability.
3. Surface `groundTruth.probability.pra_joint` separately from the product-of-marginals.

**Implementation:**
- New module `api/lib/copula.mjs` — exports `pJointOver({ marginals, correlationMatrix })`.
- New data file `data/player-correlations.json` — built offline by `scripts/fit-player-correlations.mjs` from full boxscore history. **This requires a new data fetch layer**: the current game logs in `balldontlie.js:184-207` have per-game pts/reb/ast, which IS enough — no new endpoint needed. But for accurate correlation estimates per player you need ≥ 30 games per player, so this runs on the offline batch.
- Refresh script run weekly via cron or manual `npm run refresh-correlations`.

**Verification:**
- Sanity: correlation between pts and reb for a high-volume guard should be small and positive; for a center it should be larger.
- Backtest: on held-out PRA picks, joint probability should outperform product-of-marginals on Brier score.

**Critical files (Phase 3c):**
- `api/lib/copula.mjs` (new)
- `data/player-correlations.json` (new, regenerated weekly)
- `scripts/fit-player-correlations.mjs` (new)
- `api/lib/ground-truth.js` (attach `probability.pra_joint`)
- `api/lib/framework.js` (instruct Gemini to use joint P for PRA-family props)

---

## Explicitly Not in This Roadmap

- **Kelly sizing.** Even with calibrated P, slip-level Kelly at PrizePicks is non-trivial (parlay structure, dependent bets, fractional-Kelly calibration). Stick to fixed-fraction bankroll per tier. If Kelly is ever revisited, it's a separate Phase 4 work item.
- **Replacing Gemini with pure regression for verdict synthesis.** The qualitative rules (5h named defender, 4j sole alpha, 5g UNDER mechanism identification) lose too much in translation. Gemini stays.
- **1H scaling per player (Section 10c).** Requires first-half splits that aren't currently fetched. Separate data-layer project; defer until 1H props become a primary use case.

---

## How to Resume This Plan in a Future Session

When the pick log accumulates enough decided entries, open Claude Code in this project and say:

> Read `PHASE_2_3_PLAN.md` and check whether the gating criteria for Phase 2 are met. If yes, implement Phase 1.5 (schema bump for raw feature capture) and then 2a (β-coefficient fit). The pick log is in browser localStorage — export it first via the UI and save to `data/pick-log-snapshot.json`.

The doc is self-contained: a future session does not need the conversation that produced it.

---

## Reference: What Phase 1 Already Built

- `api/lib/ground-truth.js` — `computeVariance()`, `normalizePosition()`, `deriveValues()` (lines 145–195)
- `api/lib/league-config.js` — `ft_floor_by_position`, `variance_threshold_ppg` per league
- `api/lib/framework.js` — Rule 5a Variance-Adjusted Buffer addendum; Rule 5i reads `groundTruth.derived.ft_floor_baseline`
- `api/analyze.js` — parallel L20 fetch for σ computation
- `src/App.jsx` — pick log (`PICK_LOG_KEY = "pickLog.v1"`), Wilson CI, tier-midpoint P, tentative EV, export/import

Commit: `e0b4d0e Add variance buffer, position-keyed FT floor, and pick log UI` on branch `Testing`.
