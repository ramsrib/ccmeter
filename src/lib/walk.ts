// lib/walk.ts — find/read *.jsonl and *.jsonl.zst without bun's Glob, so the tools run
// on stock node too. node:fs has `glob` only from v22, and we support older, so
// this is a plain recursive readdir walk over the two shapes we actually need.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as zlib from "node:zlib";

/**
 * Read a plain or zstd-compressed transcript; callers handle unreadable files.
 * zstd arrived in node 22.15 and bun 1.2.x, so it is looked up per call: an
 * older runtime still reads plain files and only skips the compressed ones.
 */
export async function readJsonl(path: string): Promise<string> {
  const data = await readFile(path);
  if (!path.endsWith(".zst")) return data.toString("utf8");
  const zstd = (zlib as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
  if (!zstd) throw new Error("this runtime has no zstd; compressed rollouts are skipped");
  return zstd(data).toString("utf8");
}

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

/** Every `*.jsonl` or `*.jsonl.zst` below `root` (~/.codex/sessions is date-nested). */
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
    else if (e.name.endsWith(".jsonl") || e.name.endsWith(".jsonl.zst")) out.push(p);
  }
  return out;
}
