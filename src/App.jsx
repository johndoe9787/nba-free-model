import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import nbaPlayersData from "../data/players.json";
import wnbaPlayersData from "../data/players-wnba.json";
import { tierImpliedP, tentativeEv, DEFAULT_MULTIPLIER } from "./lib/picklog-stats.js";
import { usePickLog } from "./hooks/usePickLog.js";

const PLAYERS_BY_LEAGUE = {
  nba: Object.keys(nbaPlayersData).sort(),
  wnba: Object.keys(wnbaPlayersData).sort(),
};

const STATS = [
  "Points", "Rebounds", "Assists", "PRA", "PR", "PA", "RA",
  "3-Pointers Made", "3-Pointers Attempted",
  "FG Made", "FG Attempted",
  "Free Throws Made", "Free Throws Attempted",
  "Blocks", "Steals", "Turnovers",
];
const DIRECTIONS = ["Over", "Under"];
const LEAGUES = [
  { id: "nba", label: "NBA" },
  { id: "wnba", label: "WNBA" },
];

const TIER_CONFIG = {
  S: { color: "#FFD700", bg: "#2a2200", label: "S-TIER", glow: "0 0 20px #FFD70066" },
  A: { color: "#00FF88", bg: "#002218", label: "A-TIER", glow: "0 0 20px #00FF8866" },
  B: { color: "#4488FF", bg: "#001133", label: "B-TIER", glow: "0 0 20px #4488FF66" },
  SKIP: { color: "#FF4444", bg: "#220000", label: "SKIP", glow: "0 0 20px #FF444466" },
};

const VERDICT_CONFIG = {
  OVER: { color: "#00FF88", symbol: "▲" },
  UNDER: { color: "#FF6644", symbol: "▼" },
  SKIP: { color: "#888888", symbol: "✕" },
};

const selectStyle = {
  background: "#0a1420",
  color: "#c8d8e8",
  border: "1px solid #1e3040",
  padding: "10px 12px",
  fontFamily: "'Courier New', monospace",
  fontSize: 12,
  flex: 1,
  minWidth: 180,
  appearance: "none",
  cursor: "pointer",
  outline: "none",
};

export default function App() {
  const [league, setLeague] = useState("nba");
  const [player, setPlayer] = useState("");
  const [stat, setStat] = useState("");
  const [direction, setDirection] = useState("");
  const [line, setLine] = useState("");
  const propType = stat && direction ? `${stat} ${direction.toUpperCase()}` : "";
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [playerQuery, setPlayerQuery] = useState("");
  const [playerOpen, setPlayerOpen] = useState(false);
  const [playerHighlight, setPlayerHighlight] = useState(0);
  const [multiplier, setMultiplier] = useState(DEFAULT_MULTIPLIER);
  const {
    pickLog,
    logStats,
    appendEntry,
    setOutcome,
    deleteEntry,
    clearLog,
    exportLog,
    importLog,
  } = usePickLog();
  const [logOpen, setLogOpen] = useState(false);
  const importInputRef = useRef(null);
  const lastLoggedKey = useRef(null);

  const sortedPlayers = PLAYERS_BY_LEAGUE[league];

  const filteredPlayers = useMemo(() => {
    const q = playerQuery.trim().toLowerCase();
    if (!q) return sortedPlayers;
    return sortedPlayers.filter((p) => p.toLowerCase().includes(q));
  }, [playerQuery, sortedPlayers]);

  const switchLeague = (next) => {
    if (next === league) return;
    setLeague(next);
    setPlayer("");
    setPlayerQuery("");
    setPlayerOpen(false);
    setPlayerHighlight(0);
    setResult(null);
    setError(null);
  };

  const selectPlayer = (name) => {
    setPlayer(name);
    setPlayerQuery(name);
    setPlayerOpen(false);
    setPlayerHighlight(0);
  };

  const handlePlayerKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setPlayerOpen(true);
      setPlayerHighlight((h) => Math.min(h + 1, filteredPlayers.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setPlayerHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      if (playerOpen && filteredPlayers[playerHighlight]) {
        e.preventDefault();
        selectPlayer(filteredPlayers[playerHighlight]);
      }
    } else if (e.key === "Escape") {
      setPlayerOpen(false);
      setPlayerQuery(player);
    }
  };

  const analyze = useCallback(async () => {
    if (!player || !propType || !line) {
      setError("Fill in all fields.");
      return;
    }
    setError(null);
    setResult(null);
    setLoading(true);

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player, propType, line: Number(line), league }),
      });

      const data = await response.json();

      if (data.error) throw new Error(data.error);
      if (!response.ok) throw new Error(data.error || "Request failed");

      setResult(data);
    } catch (e) {
      setError(`Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [player, propType, line, league]);

  // Append the most recent verdict to the pick log exactly once. Re-runs of
  // the same analysis (same player/prop/line) skip; new analyses append.
  useEffect(() => {
    if (!result || !result.tier) return;
    const ts = new Date().toISOString();
    const gt = result.ground_truth ?? {};
    const entry = {
      ts,
      league,
      player,
      prop_type: propType,
      line: Number(line),
      direction: result.verdict,
      tier: result.tier,
      verdict: result.verdict,
      confidence: result.confidence,
      flags_summary: (result.flags ?? []).join(" | "),
      season_avg: result.data_used?.season_avg ?? null,
      l5_avg: result.data_used?.l5_avg ?? null,
      win_prob: result.data_used?.win_prob ?? null,
      opponent: result.data_used?.opponent ?? null,
      tentative_p: tierImpliedP(result.tier),
      multiplier,
      tentative_ev: tentativeEv(tierImpliedP(result.tier), multiplier),
      outcome: null,
      // Phase 1.5 raw features captured from groundTruth for Phase 2 fits.
      is_road: gt.home_away === "away",
      is_back_to_back: null, // TODO: needs previous-game lookup in api/lib data layer
      is_post_injury: gt.player_recent?.is_listed_injured ?? null,
      def_rank: gt.opponent_defense?.def_rank ?? null,
      position: gt.derived?.player_position ?? null,
      home_split_ppg: gt.splits?.home?.ppg ?? null,
      road_split_ppg: gt.splits?.road?.ppg ?? null,
      weighted_l5_avg: gt.l5?.weighted?.averages?.ppg ?? null,
      outlier_present: gt.l5?.weighted?.outlier_present ?? null,
      variance_ppg_stddev: gt.variance?.ppg_stddev ?? null,
      series_game_number: gt.series?.next_game_number ?? null,
    };
    const key = `${player}|${propType}|${line}|${result.tier}|${result.verdict}|${result.confidence}`;
    if (lastLoggedKey.current === key) return;
    lastLoggedKey.current = key;
    appendEntry(entry);
    // multiplier intentionally excluded: changing it after a verdict should not
    // re-log; the user can edit the multiplier on the entry directly later.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const resultP = result ? tierImpliedP(result.tier) : null;
  const resultEv = tentativeEv(resultP, multiplier);

  const tierCfg = result ? TIER_CONFIG[result.tier] || TIER_CONFIG.SKIP : null;
  const verdictCfg = result ? VERDICT_CONFIG[result.verdict] || VERDICT_CONFIG.SKIP : null;
  // SKIPs that came from data unavailability (orchestrator-level early exit OR
  // missing-required-fields) have data_used: null. Gemini-level "I analyzed
  // this and reject it" SKIPs include data_used and render in the standard panel.
  const isUnable = result?.tier === "SKIP" && !result?.data_used;
  const missingFlags = (result?.flags ?? []).filter((f) => /missing:/i.test(f));
  const otherFlags = (result?.flags ?? []).filter((f) => !/missing:/i.test(f));
  const winProbDisplay = (() => {
    const wp = result?.data_used?.win_prob;
    if (wp == null) return "—";
    return (wp <= 1 ? Math.round(wp * 100) : Math.round(wp)) + "%";
  })();

  return (
    <div style={{
      minHeight: "100vh",
      background: "#080c0f",
      fontFamily: "'Courier New', monospace",
      color: "#c8d8e8",
      padding: "24px 16px",
    }}>
      <div style={{ maxWidth: 680, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ marginBottom: 24, borderBottom: "1px solid #1e3040", paddingBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, letterSpacing: 4, color: "#4488aa", marginBottom: 4 }}>
                {league.toUpperCase()} PRIZEPICKS
              </div>
              <div style={{ fontSize: 22, fontWeight: "bold", color: "#ffffff", letterSpacing: 1 }}>
                MODEL v3.4
              </div>
              <div style={{ fontSize: 11, color: "#446688", marginTop: 4 }}>
                {league === "wnba"
                  ? "WNBA MODE · 40-MIN SCALE · LIVE DATA · ALL RULES APPLIED"
                  : "PLAYOFF CALIBRATED · LIVE DATA · ALL RULES APPLIED"}
              </div>
            </div>
            <div role="tablist" aria-label="League" style={{ display: "flex", gap: 4 }}>
              {LEAGUES.map((l) => {
                const active = l.id === league;
                return (
                  <button
                    key={l.id}
                    role="tab"
                    aria-selected={active}
                    onClick={() => switchLeague(l.id)}
                    style={{
                      background: active ? "#0066cc" : "#0a1420",
                      color: active ? "#ffffff" : "#7799bb",
                      border: "1px solid " + (active ? "#0088ff" : "#1e3040"),
                      padding: "6px 14px",
                      fontFamily: "'Courier New', monospace",
                      fontSize: 11,
                      fontWeight: "bold",
                      letterSpacing: 2,
                      cursor: "pointer",
                      transition: "all 0.15s",
                    }}
                  >
                    {l.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Inputs */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div style={{ position: "relative", flex: 1, minWidth: 180 }}>
              <input
                type="text"
                value={playerQuery}
                onChange={(e) => {
                  setPlayerQuery(e.target.value);
                  setPlayerOpen(true);
                  setPlayerHighlight(0);
                }}
                onFocus={(e) => {
                  setPlayerOpen(true);
                  e.target.select();
                }}
                onBlur={() => {
                  setPlayerOpen(false);
                  if (player && playerQuery !== player) setPlayerQuery(player);
                }}
                onKeyDown={handlePlayerKeyDown}
                placeholder="— SEARCH PLAYER —"
                role="combobox"
                aria-expanded={playerOpen}
                aria-controls="player-listbox"
                aria-activedescendant={
                  playerOpen && filteredPlayers[playerHighlight]
                    ? `player-opt-${playerHighlight}`
                    : undefined
                }
                style={{ ...selectStyle, flex: undefined, minWidth: undefined, width: "100%", boxSizing: "border-box" }}
              />
              {playerOpen && (
                <ul
                  id="player-listbox"
                  role="listbox"
                  style={{
                    position: "absolute",
                    top: "calc(100% + 2px)",
                    left: 0,
                    right: 0,
                    maxHeight: 280,
                    overflowY: "auto",
                    background: "#0a1420",
                    border: "1px solid #1e3040",
                    margin: 0,
                    padding: 0,
                    listStyle: "none",
                    zIndex: 10,
                  }}
                >
                  {filteredPlayers.length === 0 ? (
                    <li style={{ padding: "10px 12px", fontSize: 12, color: "#446688" }}>
                      no matches
                    </li>
                  ) : (
                    filteredPlayers.map((p, i) => (
                      <li
                        key={p}
                        id={`player-opt-${i}`}
                        role="option"
                        aria-selected={i === playerHighlight}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          selectPlayer(p);
                        }}
                        onMouseEnter={() => setPlayerHighlight(i)}
                        style={{
                          padding: "8px 12px",
                          fontSize: 12,
                          cursor: "pointer",
                          background: i === playerHighlight ? "#0066cc" : "transparent",
                          color: i === playerHighlight ? "#ffffff" : "#c8d8e8",
                        }}
                      >
                        {p}
                      </li>
                    ))
                  )}
                </ul>
              )}
            </div>

            <select
              value={stat}
              onChange={(e) => setStat(e.target.value)}
              style={selectStyle}
            >
              <option value="">— SELECT PROP —</option>
              {STATS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>

            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value)}
              style={selectStyle}
            >
              <option value="">— OVER / UNDER —</option>
              {DIRECTIONS.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </div>

          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <input
              type="number"
              step="0.5"
              placeholder="LINE (e.g. 26.5)"
              value={line}
              onChange={(e) => setLine(e.target.value)}
              style={{
                ...selectStyle,
                width: 160,
                flex: "none",
              }}
            />

            <button
              onClick={analyze}
              disabled={loading}
              style={{
                background: loading ? "#1a2a3a" : "#0066cc",
                color: loading ? "#446688" : "#ffffff",
                border: "1px solid " + (loading ? "#1e3040" : "#0088ff"),
                padding: "10px 28px",
                fontFamily: "'Courier New', monospace",
                fontSize: 12,
                fontWeight: "bold",
                letterSpacing: 2,
                cursor: loading ? "not-allowed" : "pointer",
                transition: "all 0.15s",
              }}
            >
              {loading ? "FETCHING DATA..." : "ANALYZE"}
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div style={{
            background: "#220000",
            border: "1px solid #440000",
            padding: "10px 14px",
            fontSize: 12,
            color: "#ff6666",
            marginBottom: 16,
          }}>
            {error}
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div style={{
            border: "1px solid #1e3040",
            padding: 24,
            textAlign: "center",
          }}>
            <div style={{ color: "#4488aa", fontSize: 11, letterSpacing: 3, marginBottom: 8 }}>
              RUNNING MODEL
            </div>
            <div style={{ color: "#446688", fontSize: 11 }}>
              Fetching live stats · injury report · win probability · matchup data
            </div>
            <div style={{ color: "#446688", fontSize: 11, marginTop: 4 }}>
              Applying all framework rules silently...
            </div>
          </div>
        )}

        {/* UNABLE panel — orchestrator early-skip or missing-required-fields */}
        {result && isUnable && (
          <div style={{
            border: "1px solid #FFA50044",
            background: "#2a1a00",
            boxShadow: "0 0 20px #FFA50033",
          }}>
            <div style={{
              background: "#FFA50018",
              borderBottom: "1px solid #FFA50044",
              padding: "14px 20px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: "bold", color: "#FFA500", letterSpacing: 2 }}>
                  UNABLE TO ANALYZE
                </div>
                <div style={{ fontSize: 11, color: "#cc8833", letterSpacing: 2, marginTop: 2 }}>
                  DATA UNAVAILABLE
                </div>
              </div>
            </div>

            <div style={{
              padding: "10px 20px",
              borderBottom: "1px solid #1e3040",
              fontSize: 12,
              color: "#7799bb",
              letterSpacing: 1,
            }}>
              {player} · {propType} {line}
            </div>

            <div style={{ padding: "16px 20px", borderBottom: missingFlags.length > 0 ? "1px solid #1e3040" : undefined }}>
              <div style={{ fontSize: 10, color: "#446688", letterSpacing: 2, marginBottom: 8 }}>
                REASON
              </div>
              <div style={{ fontSize: 13, color: "#c8d8e8", lineHeight: 1.6 }}>
                {result.justification}
              </div>
            </div>

            {missingFlags.length > 0 && (
              <div style={{ padding: "12px 20px" }}>
                <div style={{ fontSize: 10, color: "#446688", letterSpacing: 2, marginBottom: 8 }}>
                  MISSING DATA
                </div>
                {missingFlags.map((f, i) => (
                  <div key={i} style={{ fontSize: 12, color: "#FFA500", marginBottom: 4 }}>
                    • {f.replace(/^⚠️\s*missing:\s*/i, "")}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Standard tier panel — verdict + tier card */}
        {result && !isUnable && tierCfg && verdictCfg && (
          <div style={{
            border: `1px solid ${tierCfg.color}44`,
            background: tierCfg.bg,
            boxShadow: tierCfg.glow,
          }}>
            {/* Verdict bar */}
            <div style={{
              background: tierCfg.color + "18",
              borderBottom: `1px solid ${tierCfg.color}44`,
              padding: "14px 20px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <span style={{
                  fontSize: 28,
                  fontWeight: "bold",
                  color: verdictCfg.color,
                  lineHeight: 1,
                }}>
                  {verdictCfg.symbol}
                </span>
                <div>
                  <div style={{ fontSize: 18, fontWeight: "bold", color: verdictCfg.color, letterSpacing: 2 }}>
                    {result.verdict}
                  </div>
                  <div style={{ fontSize: 11, color: tierCfg.color, letterSpacing: 2, marginTop: 2 }}>
                    {tierCfg.label}
                  </div>
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 32, fontWeight: "bold", color: tierCfg.color, lineHeight: 1 }}>
                  {result.confidence}%
                </div>
                <div style={{ fontSize: 10, color: "#446688", letterSpacing: 1 }}>CONFIDENCE</div>
              </div>
            </div>

            {/* Prop label */}
            <div style={{
              padding: "10px 20px",
              borderBottom: "1px solid #1e3040",
              fontSize: 12,
              color: "#7799bb",
              letterSpacing: 1,
            }}>
              {player} · {propType} {line}
            </div>

            {/* Justification */}
            <div style={{ padding: "16px 20px", borderBottom: "1px solid #1e3040" }}>
              <div style={{ fontSize: 10, color: "#446688", letterSpacing: 2, marginBottom: 8 }}>
                ANALYSIS
              </div>
              <div style={{ fontSize: 13, color: "#c8d8e8", lineHeight: 1.6 }}>
                {result.justification}
              </div>
            </div>

            {/* Flags (excluding missing-data flags, which only appear in the UNABLE panel) */}
            {otherFlags.length > 0 && (
              <div style={{ padding: "12px 20px", borderBottom: "1px solid #1e3040" }}>
                <div style={{ fontSize: 10, color: "#446688", letterSpacing: 2, marginBottom: 8 }}>
                  ACTIVE FLAGS
                </div>
                {otherFlags.map((f, i) => (
                  <div key={i} style={{ fontSize: 12, color: "#ffaa44", marginBottom: 4 }}>
                    {f}
                  </div>
                ))}
              </div>
            )}

            {/* Tier-implied P + tentative EV (uncalibrated; for navigation only) */}
            {resultP != null && (
              <div style={{ padding: "12px 20px", borderBottom: "1px solid #1e3040" }}>
                <div style={{ fontSize: 10, color: "#446688", letterSpacing: 2, marginBottom: 8 }}>
                  TIER-IMPLIED EV (UNCALIBRATED)
                </div>
                <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ background: "#0a1420", border: "1px solid #1e3040", padding: "8px 10px" }}>
                    <div style={{ fontSize: 9, color: "#446688", letterSpacing: 1, marginBottom: 3 }}>TIER-IMPLIED P</div>
                    <div style={{ fontSize: 12, color: "#8ab0cc" }}>{Math.round(resultP * 100)}%</div>
                  </div>
                  <div style={{ background: "#0a1420", border: "1px solid #1e3040", padding: "8px 10px" }}>
                    <div style={{ fontSize: 9, color: "#446688", letterSpacing: 1, marginBottom: 3 }}>SLIP MULTIPLIER</div>
                    <input
                      type="number"
                      step="0.1"
                      min="1"
                      value={multiplier}
                      onChange={(e) => setMultiplier(Number(e.target.value) || 0)}
                      style={{
                        background: "transparent",
                        color: "#8ab0cc",
                        border: "none",
                        outline: "none",
                        fontFamily: "'Courier New', monospace",
                        fontSize: 12,
                        width: 50,
                        padding: 0,
                      }}
                    />
                  </div>
                  <div style={{
                    background: "#0a1420",
                    border: `1px solid ${resultEv != null && resultEv < 0 ? "#FF444466" : "#1e3040"}`,
                    padding: "8px 10px",
                  }}>
                    <div style={{ fontSize: 9, color: "#446688", letterSpacing: 1, marginBottom: 3 }}>EV PER UNIT</div>
                    <div style={{ fontSize: 12, color: resultEv != null && resultEv < 0 ? "#FF6644" : "#00FF88" }}>
                      {resultEv != null ? (resultEv >= 0 ? "+" : "") + resultEv.toFixed(3) : "—"}
                    </div>
                  </div>
                  {resultEv != null && resultEv < 0 && (
                    <div style={{ fontSize: 11, color: "#FF6644" }}>
                      ⚠️ tier-implied EV negative at {multiplier}× — slip needs higher multiplier or tier needs higher P to clear
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 10, color: "#446688", marginTop: 8, lineHeight: 1.5 }}>
                  Tier midpoints used: S=86%, A=75%, B=65%, SKIP=50%. Not calibrated — informational until pick log accumulates outcomes.
                </div>
              </div>
            )}

            {/* Data used */}
            {result.data_used && (
              <div style={{ padding: "12px 20px" }}>
                <div style={{ fontSize: 10, color: "#446688", letterSpacing: 2, marginBottom: 8 }}>
                  DATA SNAPSHOT
                </div>
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: 8,
                }}>
                  {[
                    ["SEASON AVG", result.data_used.season_avg],
                    ["L5 AVG", result.data_used.l5_avg],
                    ["WIN PROB", winProbDisplay === "—" ? null : winProbDisplay],
                    ["LOCATION", result.data_used.home_away?.toUpperCase() || null],
                    ["OPP", result.data_used.opponent],
                    ["CONTEXT", result.data_used.game_context],
                  ].map(([label, val]) => val && (
                    <div key={label} style={{
                      background: "#0a1420",
                      border: "1px solid #1e3040",
                      padding: "8px 10px",
                    }}>
                      <div style={{ fontSize: 9, color: "#446688", letterSpacing: 1, marginBottom: 3 }}>
                        {label}
                      </div>
                      <div style={{ fontSize: 12, color: "#8ab0cc" }}>
                        {String(val)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Pick log — local-only, exportable */}
        <div style={{ marginTop: 24, border: "1px solid #1e3040" }}>
          <button
            onClick={() => setLogOpen((v) => !v)}
            style={{
              width: "100%",
              background: "#0a1420",
              color: "#7799bb",
              border: "none",
              padding: "10px 14px",
              fontFamily: "'Courier New', monospace",
              fontSize: 11,
              letterSpacing: 2,
              cursor: "pointer",
              textAlign: "left",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
            aria-expanded={logOpen}
          >
            <span>PICK LOG ({pickLog.length})</span>
            <span style={{ fontSize: 14 }}>{logOpen ? "▾" : "▸"}</span>
          </button>
          {logOpen && (
            <div style={{ borderTop: "1px solid #1e3040" }}>
              <div style={{
                padding: "10px 14px",
                fontSize: 11,
                color: "#446688",
                lineHeight: 1.6,
                borderBottom: "1px solid #1e3040",
                display: "flex",
                flexWrap: "wrap",
                gap: 12,
                alignItems: "center",
              }}>
                {logStats.n > 0 ? (
                  <span>
                    decided: {logStats.n}/{logStats.total} ·
                    {" "}observed hit rate: <span style={{ color: "#8ab0cc" }}>{(logStats.hitRate * 100).toFixed(1)}%</span>
                    {" "}· 95% CI: [{(logStats.ci[0] * 100).toFixed(0)}%, {(logStats.ci[1] * 100).toFixed(0)}%]
                  </span>
                ) : (
                  <span>no decided outcomes yet — mark picks W/L to compute hit rate</span>
                )}
                <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <button
                    onClick={exportLog}
                    disabled={pickLog.length === 0}
                    style={smallBtn(pickLog.length === 0)}
                  >EXPORT</button>
                  <button
                    onClick={() => importInputRef.current?.click()}
                    style={smallBtn(false)}
                  >IMPORT</button>
                  <input
                    ref={importInputRef}
                    type="file"
                    accept="application/json,.json"
                    onChange={importLog}
                    style={{ display: "none" }}
                  />
                  <button
                    onClick={clearLog}
                    disabled={pickLog.length === 0}
                    style={smallBtn(pickLog.length === 0, "#FF444466")}
                  >CLEAR</button>
                </span>
              </div>
              {pickLog.length === 0 ? (
                <div style={{ padding: "14px", fontSize: 11, color: "#446688", textAlign: "center" }}>
                  log is empty — run an analysis to start tracking
                </div>
              ) : (
                <div style={{ maxHeight: 360, overflowY: "auto" }}>
                  {pickLog.map((p) => (
                    <div key={p.ts} style={{
                      padding: "8px 14px",
                      borderTop: "1px solid #0e1a26",
                      fontSize: 11,
                      display: "grid",
                      gridTemplateColumns: "1fr auto",
                      gap: 8,
                      alignItems: "center",
                    }}>
                      <div>
                        <div style={{ color: "#8ab0cc" }}>
                          <span style={{ color: outcomeColor(p.outcome) }}>{outcomeSymbol(p.outcome)}</span>
                          {" "}{p.player} · {p.prop_type} {p.line} · <span style={{ color: tierColor(p.tier) }}>{p.tier}</span> {p.confidence}%
                        </div>
                        <div style={{ color: "#446688", fontSize: 10, marginTop: 2 }}>
                          {p.ts.slice(0, 16).replace("T", " ")} · {p.league?.toUpperCase()} · vs {p.opponent ?? "—"} · EV {p.tentative_ev != null ? (p.tentative_ev >= 0 ? "+" : "") + p.tentative_ev.toFixed(2) : "—"} @ {p.multiplier}×
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 4 }}>
                        {["W", "L", "Push", "Void"].map((o) => (
                          <button
                            key={o}
                            onClick={() => setOutcome(p.ts, p.outcome === o ? null : o)}
                            style={outcomeBtn(p.outcome === o, o)}
                          >{o[0]}</button>
                        ))}
                        <button onClick={() => deleteEntry(p.ts)} style={smallBtn(false, "#FF444466")}>×</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

function smallBtn(disabled, borderColor) {
  return {
    background: disabled ? "#0a1420" : "#102030",
    color: disabled ? "#334455" : "#7799bb",
    border: `1px solid ${borderColor ?? "#1e3040"}`,
    padding: "4px 8px",
    fontFamily: "'Courier New', monospace",
    fontSize: 10,
    letterSpacing: 1,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}
function outcomeColor(o) {
  if (o === "W") return "#00FF88";
  if (o === "L") return "#FF6644";
  if (o === "Push") return "#FFAA44";
  if (o === "Void") return "#888888";
  return "#446688";
}
function outcomeSymbol(o) {
  if (o === "W") return "✓";
  if (o === "L") return "✗";
  if (o === "Push") return "=";
  if (o === "Void") return "∅";
  return "·";
}
function outcomeBtn(active, label) {
  return {
    background: active ? outcomeColor(label) + "33" : "#0a1420",
    color: active ? outcomeColor(label) : "#446688",
    border: `1px solid ${active ? outcomeColor(label) + "88" : "#1e3040"}`,
    padding: "3px 7px",
    fontFamily: "'Courier New', monospace",
    fontSize: 10,
    fontWeight: "bold",
    cursor: "pointer",
    minWidth: 22,
  };
}
function tierColor(t) {
  if (t === "S") return "#FFD700";
  if (t === "A") return "#00FF88";
  if (t === "B") return "#4488FF";
  return "#FF4444";
}