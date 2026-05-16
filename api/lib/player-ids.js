// Source of truth: data/players.json + data/players-wnba.json — each is
// { name: { nba, espn } } where the "nba" field holds the stats.nba.com
// player_id for that league (LeagueID=00 for NBA, LeagueID=10 for WNBA).
//
// Server reads both files once at module init via fs.readFileSync (Vercel
// bundles referenced files into the function package); the Vite client
// imports the same JSON natively. Both sides stay in lock-step without
// code duplication.
//
// Regenerate via:
//   node scripts/refresh-playoff-players.mjs       (NBA)
//   node scripts/refresh-wnba-players.mjs          (WNBA)
// Players omitted resolve to null and the orchestrator returns SKIP with a
// clear flag.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NBA_PATH = path.resolve(HERE, "../../data/players.json");
const WNBA_PATH = path.resolve(HERE, "../../data/players-wnba.json");

export const PLAYER_INFO = JSON.parse(fs.readFileSync(NBA_PATH, "utf8"));
export const PLAYER_INFO_WNBA = JSON.parse(fs.readFileSync(WNBA_PATH, "utf8"));

const REGISTRIES = {
  nba: PLAYER_INFO,
  wnba: PLAYER_INFO_WNBA,
};

function registry(league) {
  return REGISTRIES[String(league || "nba").toLowerCase()] ?? PLAYER_INFO;
}

export function resolvePlayerId(name, { league = "nba" } = {}) {
  return registry(league)[name]?.nba ?? null;
}

export function resolveEspnId(name, { league = "nba" } = {}) {
  return registry(league)[name]?.espn ?? null;
}

// Legacy export retained for build-espn-ids.mjs and any other consumers
// that just want { name: nba_id } for the NBA registry.
export const PLAYER_IDS = Object.fromEntries(
  Object.entries(PLAYER_INFO).map(([k, v]) => [k, v.nba])
);
