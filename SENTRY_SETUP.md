# Sentry setup

Structured logging is wired (see `api/lib/logger.js`). Sentry forwarding is
deferred until you have a DSN. Steps to enable:

## 1. Create a Sentry project
- Go to https://sentry.io → New Project → platform **Node.js**.
- Copy the DSN (looks like `https://abc123@oNNNNN.ingest.us.sentry.io/PPPPP`).

## 2. Add the DSN to Vercel env vars
- Vercel dashboard → Project → Settings → Environment Variables.
- Add `SENTRY_DSN` for Production (and Preview if you want preview deploys to report).
- Server-side only — do NOT prefix with `VITE_`.

## 3. Mirror to `.env.local` for local dev
- Append `SENTRY_DSN=...` to `.env.local` so smoke scripts / `vercel dev` capture too.
- Also add `SENTRY_DSN=` to `.env.example` as an optional key.

## 4. Wire `@sentry/node` in `api/lib/logger.js`
Once the DSN exists, the wiring is small:

```js
// at top of api/lib/logger.js
import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({ dsn, tracesSampleRate: 0 });
}

// inside emit(), after the console.log:
if (level === "error" && dsn) {
  Sentry.captureMessage(code, {
    level: "error",
    extra: { ...fields, reqId },
  });
}
```

Then: `npm install @sentry/node` (single runtime dep, ~700KB).

## 5. Verify
- Trigger a known error path (e.g. malformed `/api/analyze` request, or pull
  the `BALLDONTLIE_API_KEY` to force the `balldontlie.missing_key` log).
- Confirm the event appears in Sentry within ~1 minute.
