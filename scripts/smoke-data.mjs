// Exercise api/lib/* end-to-end from the command line.
// Run: node scripts/smoke-data.mjs ["Player Name"] [--league wnba]
// Default player: LeBron James (NBA) or A'ja Wilson (WNBA).

import { resolvePlayerId } from "../api/lib/player-ids.js";
import {
  currentSeasonForLeague,
  getSeasonAverages,
  getLastNGames,
  getHomeAwaySplits,
  getCommonPlayerInfo,
} from "../api/lib/nba-stats.js";
import {
  getTodaysGames,
  findGameForTeamAbbr,
  homeAwayForTeam,
  opponentFor,
  getWinProbability,
  getTeamInjuries,
} from "../api/lib/espn.js";
import { getLeagueConfig } from "../api/lib/league-config.js";

function parseArgs(argv) {
  const out = { league: "nba", positional: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--league") {
      out.league = String(argv[++i] ?? "nba").toLowerCase();
    } else {
      out.positional.push(argv[i]);
    }
  }
  return out;
}

const parsed = parseArgs(process.argv.slice(2));
const league = parsed.league;
const player = parsed.positional[0] || (league === "wnba" ? "A'ja Wilson" : "LeBron James");

const leagueCfg = getLeagueConfig(league);
const leagueId = leagueCfg.stats_league_id;

const header = (s) => console.log("\n=== " + s + " ===");
const dump = (label, val) =>
  console.log(label + ":", JSON.stringify(val, null, 2));

console.log("League:", leagueCfg.display_name, `(LeagueID=${leagueId})`);
console.log("Player:", player);
console.log("Season:", currentSeasonForLeague(leagueId));

const id = resolvePlayerId(player, { league });
console.log("Resolved PlayerID:", id);

if (!id) {
  console.log("No ID configured. Stopping.");
  process.exit(0);
}

header("Season averages");
dump("season", await getSeasonAverages(id, { leagueId }));

header("Last 5 games");
dump("l5", await getLastNGames(id, 5, { leagueId }));

header("Home/Away splits");
dump("splits", await getHomeAwaySplits(id, { leagueId }));

header("Common player info");
const info = await getCommonPlayerInfo(id, { leagueId });
dump("info", info);

header("Today's games (ESPN)");
const games = await getTodaysGames(undefined, { league });
console.log("count:", games?.length ?? "null");
if (games) {
  for (const g of games) {
    console.log(
      `  ${g.away.abbr} @ ${g.home.abbr} [${g.state}] event=${g.game_id}`
    );
  }
}

if (info?.team_abbr && games) {
  header(`Game for ${info.team_abbr}`);
  const game = findGameForTeamAbbr(games, info.team_abbr, { league });
  dump("game", game);
  if (game) {
    console.log("home/away:", homeAwayForTeam(game, info.team_abbr, { league }));
    const opp = opponentFor(game, info.team_abbr, { league });
    console.log("opponent:", opp);

    header("Win probability");
    dump("win_prob", await getWinProbability(game.game_id, game.competition_id, { league }));

    if (opp) {
      header(`Injuries: ${opp.name}`);
      dump("opponent_injuries", await getTeamInjuries(opp.team_id, { league }));
    }
  } else {
    console.log("No game scheduled for this team today.");
  }
}
