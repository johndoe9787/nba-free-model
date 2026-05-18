// Pick log state + persistence. Owns localStorage round-trip, dedup on import,
// outcome edits, and Wilson-CI summary. The verdict→entry mapping stays in
// App.jsx because it depends on the in-flight analysis context (player, line,
// multiplier, etc.); this hook just exposes appendEntry as a no-questions add.
//
// Pick log entry shape (v1) — additive only; legacy entries may lack 1.5 fields:
//   { ts: ISO8601, league, player, prop_type, line, direction: "OVER"|"UNDER"|"SKIP",
//     tier, verdict, confidence, flags_summary: string,
//     season_avg, l5_avg, win_prob, opponent,
//     tentative_p, multiplier, tentative_ev,
//     outcome: null | "W" | "L" | "Push" | "Void",
//     // Phase 1.5 raw features — required for Phase 2 β-coefficient fits.
//     is_road, is_back_to_back, is_post_injury, def_rank, position,
//     home_split_ppg, road_split_ppg,
//     weighted_l5_avg, outlier_present, variance_ppg_stddev, series_game_number }

import { useState, useEffect, useCallback, useMemo } from "react";
import { wilsonStats } from "../lib/picklog-stats.js";

const PICK_LOG_KEY = "pickLog.v1";

function loadPickLog() {
  try {
    const raw = localStorage.getItem(PICK_LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePickLog(entries) {
  localStorage.setItem(PICK_LOG_KEY, JSON.stringify(entries));
}

function dedupeKey(entry) {
  return `${entry.ts}|${entry.player}|${entry.prop_type}|${entry.line}`;
}

export function usePickLog() {
  const [pickLog, setPickLog] = useState(loadPickLog);

  useEffect(() => {
    savePickLog(pickLog);
  }, [pickLog]);

  const appendEntry = useCallback((entry) => {
    setPickLog((prev) => [entry, ...prev]);
  }, []);

  const setOutcome = useCallback((ts, outcome) => {
    setPickLog((prev) => prev.map((p) => (p.ts === ts ? { ...p, outcome } : p)));
  }, []);

  const deleteEntry = useCallback((ts) => {
    setPickLog((prev) => prev.filter((p) => p.ts !== ts));
  }, []);

  const clearLog = useCallback(() => {
    if (confirm(`Delete all ${pickLog.length} pick log entries? This cannot be undone.`)) {
      setPickLog([]);
    }
  }, [pickLog.length]);

  const exportLog = useCallback(() => {
    const blob = new Blob([JSON.stringify(pickLog, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pick-log-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [pickLog]);

  const importLog = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!Array.isArray(parsed)) throw new Error("not an array");
        setPickLog((prev) => {
          const seen = new Set(prev.map(dedupeKey));
          const additions = parsed.filter((p) => p && p.ts && !seen.has(dedupeKey(p)));
          return [...additions, ...prev];
        });
      } catch (err) {
        alert(`Import failed: ${err.message}`);
      }
    };
    reader.readAsText(file);
    e.target.value = ""; // allow re-importing the same file
  }, []);

  const logStats = useMemo(() => wilsonStats(pickLog), [pickLog]);

  return {
    pickLog,
    logStats,
    appendEntry,
    setOutcome,
    deleteEntry,
    clearLog,
    exportLog,
    importLog,
  };
}
