// lib/walk.ts — find *.jsonl transcripts without bun's Glob, so the tools run
// on stock node too. node:fs has `glob` only from v22, and we support older, so
// this is a plain recursive readdir walk over the two shapes we actually need.

import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Every `<dir>/*.jsonl` one level below `root` (the shape of
 * ~/.claude/projects/<slug>/<session>.jsonl). `match` filters by file name so
 * callers can look for one session without stat-ing every transcript.
 */
export async function jsonlOneLevel(root: string, match?: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  let dirs: string[];
  try {
    dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out; // root vanished or is unreadable
  }
  for (const dir of dirs) {
    try {
      for (const name of await readdir(join(root, dir))) {
        if (!name.endsWith(".jsonl")) continue;
        if (match && !match(name)) continue;
        out.push(join(root, dir, name));
      }
    } catch {
      // deleted mid-scan
    }
  }
  return out;
}

/** Every `*.jsonl` at any depth below `root` (~/.codex/sessions is date-nested). */
export async function jsonlRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) out.push(...(await jsonlRecursive(p)));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}
