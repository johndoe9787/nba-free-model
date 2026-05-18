// Structured JSON logger. Emits one line of JSON per event to stdout, which
// Vercel captures and makes searchable in the function logs UI.
//
// Reuses the per-request AsyncLocalStorage context so log lines from a single
// request can be correlated via reqId without threading the id through every
// call site.
//
// Code naming: <source>.<event_type>, snake_case — e.g. "balldontlie.http_error".
//
// Sentry hook: when SENTRY_DSN is wired (see SENTRY_SETUP.md), forward
// log.error() calls to Sentry.captureException() inside emit().

import { getReqId } from "./request-context.js";

function emit(level, code, fields = {}) {
  const reqId = getReqId();
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    code,
    ...(reqId ? { reqId } : {}),
    ...fields,
  }));
}

export const log = {
  info: (code, fields) => emit("info", code, fields),
  warn: (code, fields) => emit("warn", code, fields),
  error: (code, fields) => emit("error", code, fields),
};
