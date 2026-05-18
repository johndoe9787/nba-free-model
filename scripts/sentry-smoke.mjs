// One-shot Sentry verification. Fires a single log.error event and flushes.
// Run: node --env-file=.env.local scripts/sentry-smoke.mjs
// Confirm: the event appears in your Sentry inbox within ~1 minute.

import * as Sentry from "@sentry/node";
import { log } from "../api/lib/logger.js";

if (!process.env.SENTRY_DSN) {
  console.error("SENTRY_DSN is not set. Add it to .env.local first.");
  process.exit(1);
}

log.error("sentry.smoke_test", {
  source: "local-cli",
  timestamp: new Date().toISOString(),
});

await Sentry.flush(3000);
console.log("Smoke event flushed. Check your Sentry inbox.");
