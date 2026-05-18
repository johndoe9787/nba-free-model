// Structured JSON logger with optional Sentry forwarding.
//
// Emits one line of JSON per event to stdout (Vercel captures it in the
// function logs UI). When SENTRY_DSN is set, log.error() also forwards to
// Sentry.captureMessage so errors surface in the Sentry dashboard.
//
// Reuses the per-request AsyncLocalStorage reqId so log lines from a single
// request can be correlated without threading the id through every call site.
//
// Code naming: <source>.<event_type>, snake_case — e.g. "balldontlie.http_error".

import * as Sentry from "@sentry/node";
import { getReqId } from "./request-context.js";

const sentryDsn = process.env.SENTRY_DSN;
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV,
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: 0,
  });
}

function emit(level, code, fields = {}) {
  const reqId = getReqId();
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    code,
    ...(reqId ? { reqId } : {}),
    ...fields,
  }));

  if (level === "error" && sentryDsn) {
    Sentry.captureMessage(code, {
      level: "error",
      extra: { ...fields, ...(reqId ? { reqId } : {}) },
    });
  }
}

export const log = {
  info: (code, fields) => emit("info", code, fields),
  warn: (code, fields) => emit("warn", code, fields),
  error: (code, fields) => emit("error", code, fields),
};
