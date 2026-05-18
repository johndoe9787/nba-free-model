# nba-model-free

React + Vite frontend + Vercel Functions backend that generates NBA/WNBA PrizePicks
prop verdicts using the v3.5 framework via Google Gemini.

## Architecture
- Frontend: `src/App.jsx` (React 19, Vite). Pick log persisted in localStorage key `pickLog.v1`.
- Backend: `api/analyze.js` orchestrator → `api/lib/*` modules → Gemini.
- No Python. Pure JS/Node.
- Deployed: https://nba-free-model.vercel.app/

## Daily workflow
- Dev server: `vercel dev` (frontend + functions) or `npm run dev` (frontend only).
- End-to-end test: `node scripts/smoke-gemini.mjs "Player" "Prop" line [--league wnba]`.
  When tailing, use `| tail -n 40` — verdict block + raw JSON + grounded-vs-output
  check all land in those last lines.
- Ground-truth only (no Gemini): `node scripts/smoke-orchestrator.mjs ...`.
- Defender lookup (Rule 5h): `node scripts/smoke-defender.mjs`.
- Data refresh: `npm run refresh-team-defense`, `refresh-players`, `sync-wnba-roster`,
  `refresh-wnba-team-defense`. Scheduled Mon/Thu 11:00 UTC via
  `.github/workflows/refresh-data.yml`.

## Data sources (actual cascade)
- Identity: stats.nba.com → balldontlie → ESPN (`api/lib/nba-stats.js`, `balldontlie.js`, `espn.js`)
- Stats / gamelog: stats.nba.com → ESPN gamelog
- Schedule + win prob: ESPN scoreboard + BPI
- Weighted L5: `api/lib/weighted-l5.js` (recency + opponent weighted, outlier-aware)
- Pull Basketball-Reference splits before issuing any UNDER (workflow rule, not automated).

## Framework
- Current version: v3.5. Rules are implemented in `api/lib/framework.js` — read that for
  exact text. Do not re-document rules here; they drift.
- Phase 1 (shipped): per-player variance σ, position-keyed FT floor, pick log UI,
  tentative EV widget.
- Phase 1.5 (shipped): raw feature capture in pick log for future regression fitting.
- Phase 2/3 (gated): see `PHASE_2_3_PLAN.md` — coefficient fitting + Kalman baseline,
  not active until pick log has ≥100 decided entries.

## Instructions
- Use the v3.5 framework as the analysis framework.
- Apply all rules in `api/lib/framework.js` (Sections 4–6), the OVER and UNDER pre-pick
  checklists (Section 7) silently before output.
- Run the S-tier gate (Section 2) before assigning S. Any condition fails → A-tier max.
- Apply the mandatory road deduction (Rule 5a) before any line comparison on road games.
- For every UNDER: identify the named mechanism (minutes compression / role compression /
  matchup ceiling) silently before tiering. No mechanism → Skip.
- Do not list rules, historical data, player stats, or matchup probabilities in output.

## Play-In Tournament
The Play-In is NOT a playoff series. v3.3-era playoff rules (Game Number Modifier,
series-score modifier on 5f, named-defender 5h) do NOT apply. Treat as high-stakes regular
season. Post-injury return gate (Section 6) applies in full — unrestricted-minutes
confirmation required, else A-tier max.

## Hard gates (cannot be bypassed)
- Post-injury return: first 5 games back = A-tier max (Section 6)
- Assist win-probability gate: team win prob 40–75% (Rule 5c)
- Multi-star compression: 3rd/4th scorer w/ 3+ teammates ≥15 PPG, favored ≥10 = A-tier max (Rule 4k)
- UNDER mechanism gate: no named mechanism → no UNDER, regardless of suppressor activity (5g)

## Tiebreaker
- Suppressor > boost when in conflict.
- Suppressor priority (high → low): Section 6 → 4k → 4i → 5f → 5c.
- Boosts (4j sole alpha) apply only after all suppressors clean.
- For UNDERs: 4j active = UNDER invalid on that player.

## Output format
Table only. S → A → B, sorted by confidence % desc within tier. OVER and UNDER share one
table. Max 10 picks total — do not pad. Conditional picks flagged with ⚠️ and one-line
confirmation note below.

| Rank | Player | Prop | Line | Tier | Confidence % | Brief Justification (2–3 sentences) |

## Gemini prompt design
- Pass BOTH the primitive and the pre-formatted human string for any computed value
  (game numbers, series records, percentages). Don't let the LLM assemble user-facing
  strings — that's where off-by-one labels and unit mistakes appear.
- Prompts say "copy {field} verbatim", not "format {field} as ...".

## Communication conventions
- Default 2–3 sentences. Tables only for 3+ option comparisons.
- End of turn: one sentence (what changed) + one sentence (what's next).
- Don't reprint file contents — reference `path:line`.
- File reads: target the function/range when file >100 lines.
