// Sync data/players-wnba.json with ESPN's active WNBA team rosters.
//   1. Fetches ESPN team list + per-team rosters.
//   2. Adds any name on an ESPN roster that's missing from the seed (null IDs).
//   3. Removes any seed name not present on any ESPN active roster.
//   4. Chains into scripts/refresh-wnba-players.mjs to hydrate nba/espn IDs.
//
// Usage: node scripts/audit-wnba-roster.mjs

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { normName } from "./lib/common.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEED_PATH = path.join(ROOT, "data/players-wnba.json");
const REFRESH_SCRIPT = path.join(ROOT, "scripts/refresh-wnba-players.mjs");

const TEAMS_URL =
  "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/teams?limit=50";
const rosterUrl = (teamId) =>
  `https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/teams/${teamId}/roster`;

async function jget(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

async function main() {
  console.log("=== sync-wnba-roster ===");

  console.log("\n[1/4] fetching ESPN team list…");
  const teamsData = await jget(TEAMS_URL);
  const teams =
    teamsData?.sports?.[0]?.leagues?.[0]?.teams?.map((t) => t.team) ?? [];
  console.log(`  ${teams.length} teams`);

  console.log("\n[2/4] fetching per-team rosters…");
  const espnRoster = [];
  for (const t of teams) {
    const data = await jget(rosterUrl(t.id));
    const athletes = data?.athletes ?? [];
    for (const a of athletes) {
      espnRoster.push({
        name: a.fullName ?? a.displayName,
        team: t.abbreviation,
      });
    }
    console.log(`  ${t.abbreviation.padEnd(4)} ${athletes.length} players`);
  }
  console.log(`  ${espnRoster.length} active athletes total`);

  console.log("\n[3/4] reconciling seed with ESPN rosters…");
  const seed = JSON.parse(await fs.readFile(SEED_PATH, "utf8"));
  const seedNames = Object.keys(seed);
  const seedNorm = new Map(seedNames.map((n) => [normName(n), n]));

  // Dedup ESPN roster by normalized name (first occurrence wins).
  const espnByNorm = new Map();
  for (const p of espnRoster) {
    const key = normName(p.name);
    if (!espnByNorm.has(key)) espnByNorm.set(key, p);
  }

  const additions = [...espnByNorm.values()].filter(
    (p) => !seedNorm.has(normName(p.name))
  );
  const removals = seedNames.filter((n) => !espnByNorm.has(normName(n)));

  const merged = { ...seed };
  for (const n of removals) delete merged[n];
  for (const p of additions) merged[p.name] = { nba: null, espn: null };

  const sorted = Object.fromEntries(
    Object.entries(merged).sort(([a], [b]) => a.localeCompare(b))
  );
  await fs.writeFile(SEED_PATH, JSON.stringify(sorted, null, 2) + "\n");

  console.log(`  + added   ${additions.length}`);
  for (const p of additions) console.log(`      ${p.name.padEnd(28)} (${p.team})`);
  console.log(`  - removed ${removals.length}`);
  for (const n of removals) console.log(`      ${n}`);
  console.log(`  seed: ${seedNames.length} → ${Object.keys(sorted).length}`);

  if (additions.length === 0 && removals.length === 0) {
    console.log("\nNo changes — seed already in sync with ESPN. Skipping refresh.");
    return;
  }

  console.log("\n[4/4] running refresh-wnba-players to hydrate IDs…");
  const result = spawnSync(process.execPath, [REFRESH_SCRIPT], {
    stdio: "inherit",
    cwd: ROOT,
  });
  process.exit(result.status ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
