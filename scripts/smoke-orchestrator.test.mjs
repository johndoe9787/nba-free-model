// Assertion-based smoke for gatherGroundTruth.
// Run: npm test
// Eyeball-mode CLI is still available at scripts/smoke-orchestrator.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { gatherGroundTruth } from "../api/analyze.js";

test("unknown player returns SKIP with player_not_configured", async () => {
  const result = await gatherGroundTruth({
    player: "Zzqx Definitely Not A Real Player",
    propType: "Points OVER",
    line: "10.5",
  });
  assert.equal(result.skipReason, "player_not_configured");
  assert.equal(typeof result.message, "string");
  assert.ok(result.message.length > 0);
});

test("known player returns valid SKIP or full ground-truth shape", { timeout: 30_000 }, async () => {
  const result = await gatherGroundTruth({
    player: "Nikola Jokic",
    propType: "PRA OVER",
    line: "40.5",
  });

  if (result.skipReason) {
    assert.equal(typeof result.skipReason, "string");
    assert.equal(typeof result.message, "string");
    return;
  }

  assert.equal(typeof result.groundTruth, "object");
  assert.notEqual(result.groundTruth, null);
  assert.ok(Array.isArray(result.missing));
  assert.equal(typeof result.trace, "object");
  assert.equal(typeof result.leagueCfg, "object");
});
