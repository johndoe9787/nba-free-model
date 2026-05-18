# Sentry setup

The `@sentry/node` SDK is installed and wired in `api/lib/logger.js`. When
`SENTRY_DSN` is present, `log.error()` calls forward to Sentry automatically.
When absent, the SDK is not initialized and logger calls are pure stdout
emissions. Three steps remain (all configuration, no code).

## 1. Create a Sentry project
- https://sentry.io → New Project → platform **Node.js**.
- Copy the DSN — looks like `https://abc123@oNNNNN.ingest.us.sentry.io/PPPPP`.

## 2. Add `SENTRY_DSN` to Vercel
- Vercel dashboard → this project → Settings → Environment Variables.
- Add `SENTRY_DSN=<your-dsn>` for **Production** (and **Preview** if you want
  preview deploys to report too).
- Server-side only — do **not** prefix with `VITE_`.

## 3. Mirror to `.env.local` for local dev
- Append `SENTRY_DSN=<your-dsn>` to `.env.local` so `vercel dev` and smoke
  scripts also report. `.env.example` already lists the key as optional.

## 4. Verify
- Trigger a known error path (e.g. malformed `/api/analyze` request, or unset
  `BALLDONTLIE_API_KEY` to force the `balldontlie.missing_key` log).
- Event should appear in Sentry within ~1 minute, tagged with `environment`
  (production / preview / development) and `release` (the deploy's commit SHA).

## What gets captured
- Every `log.error(code, fields)` call → Sentry event with `code` as the
  message, `level: error`, and `fields + reqId` as extras.
- `log.info` and `log.warn` go to stdout only — Sentry is reserved for errors
  to keep quota under control.
- `tracesSampleRate: 0` — no performance tracing. Enable later in `logger.js`
  if you want it.
