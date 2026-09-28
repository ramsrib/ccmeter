// lib/history.ts — the readings ccmeter has taken, one JSON line per run.
//
// Claude Code logs tokens but never the subscription percentages, so without
// this there is no record of how the 5h and weekly windows moved. Every ccmeter
// run appends what it read, which `/pace` and pre-flight checks already do many
// times a day; ccburn lines those readings up against the transcripts.
//
//   $CCMETER_HISTORY, else $XDG_STATE_HOME/ccmeter/history.jsonl
//   (~/.local/state/ccmeter/history.jsonl). CCMETER_NO_HISTORY=1 turns it off.

import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface HistoryWindow {
  pct: number;
  resetsAt: string | number | null;
}

export interface HistoryEntry {
  at: number; // epoch ms of the reading
  claude?: {
    route?: { baseUrl: string; auth: string }; // absent: the Keychain login
    plan?: string;
    fiveHour?: HistoryWindow;
    weekly?: HistoryWindow;
    scoped?: { label: string; group: string; window: HistoryWindow }[];
  };
  codex?: {
    capturedAt?: number; // when Codex took the snapshot, not when we read it
    fiveHour?: HistoryWindow;
    weekly?: HistoryWindow;
  };
}

// Plenty for a month of readings every few minutes. Past it, drop what's older
// than KEEP_MS; a weekly window never needs more than the last one.
const MAX_BYTES = 8 * 1024 * 1024;
const KEEP_MS = 35 * 24 * 3600 * 1000;

export function historyPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CCMETER_HISTORY) return env.CCMETER_HISTORY;
  const state = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(state, "ccmeter", "history.jsonl");
}

/** Append one reading. Never throws: a meter that can't write history still meters. */
export async function appendHistory(entry: HistoryEntry): Promise<void> {
  if (process.env.CCMETER_NO_HISTORY === "1" || (!entry.claude && !entry.codex)) return;
  const path = historyPath();
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(entry) + "\n");
    if ((await stat(path)).size > MAX_BYTES) {
      const cutoff = Date.now() - KEEP_MS;
      const kept = (await readHistory(cutoff)).map((e) => JSON.stringify(e) + "\n").join("");
      await writeFile(path, kept);
    }
  } catch {
    // read-only home, full disk: skip
  }
}

/** Readings at or after `sinceMs`, oldest first. Empty when there is no history yet. */
export async function readHistory(sinceMs = 0): Promise<HistoryEntry[]> {
  let text: string;
  try {
    text = await readFile(historyPath(), "utf8");
  } catch {
    return [];
  }
  const out: HistoryEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as HistoryEntry;
      if (typeof e.at === "number" && e.at >= sinceMs) out.push(e);
    } catch {
      // a line cut short by a concurrent write
    }
  }
  return out.sort((a, b) => a.at - b.at);
}
