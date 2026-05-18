# Architecture & Best-Practices Audit

_As of 2026-05-18. Re-audit after major changes to `App.jsx`, the orchestrator, or CI._

## 1. Executive summary

The backend is production-grade: a thin orchestrator, pure data adapters, and a
side-effect-free framework renderer. The frontend, scripts tier, and ops tooling
have real gaps — most consequentially, **no PR CI gate**, **no automated tests**,
and **no production observability**. None of the gaps are crises; all are addressable
with focused work.

| Concern | State | Priority |
|---|---|---|
| Separation of Concerns | Mixed — backend ✓, frontend `App.jsx` ~930 lines | Medium |
| DRY | Scripts duplicate `normName`, `jsonFetch`, `sleep`, `NBA_HEADERS` | Medium |
| Loose Coupling | Good — adapter cascade, no circular deps | — |
| Input Validation | Partial — `propType` validated, `line`/`player` are not | High |
| Auth / Authorization | N/A — public stateless tool, correct posture | — |
| Encryption / Secrets | ✓ HTTPS automatic; `.env.local` gitignored & never committed | — |
| Logging & Monitoring | Bare `console.*`, no APM/Sentry | High |
| Testing | Smoke scripts only — no assertions, no test runner | High |
| Error Handling | Defensive cascades good; Gemini retry has no total timeout | Low–Medium |
| Env Config | ✓ — `.env.example` accurate, centralized | — |
| CI/CD | Only `refresh-data.yml` (cron); no PR build/lint/test gate | High |

## 2. Architecture (SoC, DRY, Coupling)

### Backend SoC — Good
- `api/analyze.js:1-159` is thin orchestration: parse request → cascade fetchers → build ground truth → call Gemini → return verdict.
- `api/lib/ground-truth.js` is pure composition (no fetches, no side effects).
- `api/lib/espn.js`, `nba-stats.js`, `balldontlie.js` are clean adapters with isolated error handling.
- `api/lib/framework.js` renders the v3.5 prompt template; it imports no fetchers.

### Frontend SoC — Problem
`src/App.jsx` is ~930 lines combining:
- 11 `useState` calls (form, result, loading, error, pick log, etc.).
- Business logic — Wilson 95% CI and tentative EV math at `src/App.jsx:278-293`.
- localStorage round-trip + dedup + import/export.
- View rendering of every panel.

The response shape from `/api/analyze` is consumed without an interface layer
(`src/App.jsx:195-227`), so backend schema changes break the UI silently.

**Recommendation:** Extract a `usePickLog()` hook that owns localStorage + Wilson
stats; add a Zod schema (or TS types) for the `/api/analyze` response.

### DRY — Real duplication in scripts
- `normName()` — identical in `scripts/refresh-playoff-players.mjs:53-60` and `scripts/refresh-wnba-players.mjs:51-59`.
- `jsonFetch()` and `sleep()` — also duplicated between those two files.
- `NBA_HEADERS` — defined in `api/lib/nba-http.js:27-43` **and** redefined in both refresh scripts (`refresh-playoff-players.mjs:33-42`, `refresh-wnba-players.mjs:38-47`).

**Recommendation:** Create `scripts/lib/common.mjs` exporting `normName/jsonFetch/sleep`;
import `NBA_HEADERS`/`WNBA_HEADERS` from a single source both `api/lib` and scripts can use.

### Loose Coupling — Good
- Identity cascade at `api/analyze.js:44-91` (stats.nba.com → balldontlie → ESPN): each
  fetcher returns `null` on failure with zero knowledge of siblings.
- No circular imports across `api/lib/`.
- Framework + ground-truth depend only on pure helpers.

Adding Zod schemas at the boundary of each external API (ESPN, stats.nba.com) would
catch upstream shape changes earlier, but it's a nice-to-have, not a fix.

## 3. Security

### Input validation — Gap
`api/analyze.js:178` extracts `line` from the request body but never type-checks it.
`player` has no length cap. Only `propType` has both regex and allowlist validation
(`api/analyze.js:189`).

**Recommendation:**
```js
if (typeof line !== 'number' || !isFinite(line) || line <= 0) return 400;
if (typeof player !== 'string' || player.length > 100) return 400;
```

### Prompt injection — Low impact
Player names land in a JSON `groundTruth` block, not in prompt prose. The prompt
explicitly instructs Gemini "Use ONLY values from the GROUND TRUTH block below"
(`api/analyze.js:285`). Injection surface is small, but length caps above are still
prudent.

### Stack-trace leakage — Low
`api/analyze.js:233-234` returns `{ error: error.message }` on the unhandled-error
path. Should be a generic message in production, with the raw message gated behind
`process.env.NODE_ENV !== 'production'`.

### Rate limiting — Acceptable
`api/lib/rate-limit.js` is per-instance in-memory (10 req/60s/IP). The author notes
the limitation in a comment; an attacker spreading across instances defeats it.
Acceptable for a free public tool; migrate to Upstash Redis only if abuse appears.

### Secrets — Clean
- `.gitignore:27` excludes `.env*.local`.
- `git ls-files` confirms no `.env.local` is tracked.
- `git log --all -- .env.local` returns no history — it has never been committed.
- No `VITE_*` env vars reference API keys (would publish to the client bundle).
- `api/analyze.js:221-224` checks `GOOGLE_API_KEY` at request time; no hardcoded secrets in source.

### Encryption — Default
HTTPS/TLS is automatic on Vercel. There is no database to encrypt at rest. No
sensitive PII is stored client-side (`pickLog.v1` localStorage contains only
analysis inputs and outcomes).

## 4. Reliability

### Logging — Missing infrastructure
- Bare `console.error/warn` throughout (e.g., `api/lib/nba-http.js:83-92`, `api/lib/espn.js:34-39`).
- `logPrefix()` at `api/lib/request-context.js:13-16` prepends `[reqId]` via AsyncLocalStorage — that's the entire structured-logging story.
- No Sentry, Datadog, or other APM. Production failures are visible only in raw Vercel function logs.

**Recommendation:** Add pino (or similar) emitting JSON to stdout; add Sentry for
errors. Reuse existing `logPrefix()` infrastructure by wiring it into a typed
`errorLog(code, context)` helper.

### Testing — None automated
- No vitest/jest config; `package.json` has `lint` but no `test` script.
- The 7 `scripts/smoke-*.mjs` files print JSON to stdout — no assertions, eyeball verification only.
- `.github/workflows/refresh-data.yml` uses `continue-on-error: true` on every refresh step, silently swallowing failures.

**Recommendation:** Convert at least `smoke-orchestrator.mjs` to a `node:test` or
vitest file with real assertions (e.g., required `groundTruth` fields are non-null
on non-SKIP results). Wire into PR CI.

### Error handling — Mostly sound
- SKIP cascade is structured with labeled reasons: `player_not_configured`, `schedule_unavailable`, `no_upcoming_game`, etc.
- Gemini retry at `api/analyze.js:333-350` does 3 primary attempts + 1 flash-lite fallback, but **no total-timeout guard** — worst case ~4.5s of retries before responding.
- Outer `try/catch` (`api/analyze.js:233-234`) swallows stack traces without logging request context.

**Recommendation:** Wrap the Gemini retry loop in an `AbortController` with an ~8s
budget. Log the outer catch with `reqId`, `player`, `propType`, `line` before
returning the generic 500.

## 5. Scalability / Deployment

### Env config — Solid
- `.env.example` lists `GOOGLE_API_KEY` and `BALLDONTLIE_API_KEY` with clear scope notes ("Required. Server-side only").
- Per-request env checks at `api/analyze.js:221-224`.
- Centralized league constants in `api/lib/league-config.js`.

No action.

### CI/CD — Gap
Only `.github/workflows/refresh-data.yml` exists (cron Mon/Thu 11:00 UTC, manual
dispatch). No PR validation workflow. `eslint` is installed but never invoked by CI.
Vercel auto-deploys `main` with no gating.

**Recommendation:** Add `.github/workflows/ci.yml` on `pull_request` to `main` with:
- `npm ci`
- `npm run build`
- `npm run lint`
- Non-Gemini smoke: `node scripts/smoke-orchestrator.mjs "Nikola Jokic" "Points OVER" 25.5`
  (after it's been converted to assert on key ground-truth fields).

Require these checks to pass before merge.

## 6. Prioritized recommendations

### High priority — real risk to prod or developer productivity
1. Add PR CI workflow (`.github/workflows/ci.yml`) with build + lint + smoke-orchestrator assertion.
2. Add input validation: numeric `line`, length caps on `player` and `propType`.
3. Add structured logging + Sentry (or equivalent) for production observability.
4. Convert at least one smoke script to assertion-based with `node:test` or vitest.

### Medium priority — quality of life
5. Extract `scripts/lib/common.mjs` for `normName / jsonFetch / sleep / NBA_HEADERS`.
6. Split `App.jsx` — extract `usePickLog()` hook and an API response schema (Zod or TS types).
7. Add `AbortController` with total budget on Gemini retry.
8. Return generic 500 message in prod; gate verbose errors behind `NODE_ENV`.

### No action needed
9. Loose coupling, env config, secrets handling, HTTPS, auth posture.
