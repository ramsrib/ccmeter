#!/usr/bin/env bun
/**
 * ctxmeter — how much of the context window this session has consumed.
 *
 * Claude Code exposes no API for this, so we read the session transcript. The
 * newest main-thread assistant message's `usage` block IS the current context:
 * everything resent on the next request plus what it just wrote.
 *
 *   used = input + cache_creation + cache_read + output
 *
 * Taking the *newest* message (not the max) is what makes this survive
 * compaction — after a compact the prompt shrinks and `cache_read` drops with it.
 *
 * Window size is not recorded anywhere in the transcript: a 1M session logs its
 * model as plain "claude-opus-4-8", identical to a 200k one. We infer it from
 * the configured model's `[1m]` suffix, and self-correct if the observed usage
 * proves the window must be larger.
 *
 * Flags: --json | --limit N | --threshold N (exit 1 at/above N%) | --transcript P
 */
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Glob } from "bun";
import { bar, colorEnabled, humanAgo, makeStyle, pct, severityColor, type Style } from "./lib/format";

const SMALL_WINDOW = 200_000;
const LARGE_WINDOW = 1_000_000;

interface Ctx {
  ok: boolean;
  error?: string;
  used?: number;
  limit?: number;
  pct?: number;
  model?: string;
  transcript?: string;
  inferredLimit?: boolean; // limit was bumped because `used` exceeded it
  usedWithOutput?: number; // `used` plus the last reply, which the next request resends
  session?: string; // transcript basename = session id
  project?: string; // project dir the session belongs to
  resolvedBy?: "transcript" | "session" | "env" | "guess";
}

/** `-Users-sriram-Projects-mentes-ai-mentes-web` → `mentes-web`; `subagents` stays. */
function projectLabel(transcript: string): string {
  const dir = transcript.split("/").slice(-2, -1)[0] ?? "";
  if (!dir.startsWith("-")) return dir;
  return dir.split("-").filter(Boolean).pop() ?? dir;
}

function sessionId(transcript: string): string {
  return (transcript.split("/").pop() ?? "").replace(/\.jsonl$/, "");
}

/** The configured model carries the only `[1m]` marker we ever see. */
function configuredWindow(): number {
  for (const p of [
    join(homedir(), ".claude", "settings.json"),
    join(process.cwd(), ".claude", "settings.local.json"),
    join(process.cwd(), ".claude", "settings.json"),
  ]) {
    if (!existsSync(p)) continue;
    try {
      const model = JSON.parse(require("node:fs").readFileSync(p, "utf8")).model;
      if (typeof model === "string" && model.includes("[1m]")) return LARGE_WINDOW;
    } catch {
      // unreadable / malformed — fall through to the default
    }
  }
  return SMALL_WINDOW;
}

const PROJECTS = join(homedir(), ".claude", "projects");

async function transcriptForSession(id: string): Promise<string | null> {
  if (!existsSync(PROJECTS)) return null;
  for await (const p of new Glob(`*/${id}.jsonl`).scan({ cwd: PROJECTS, absolute: true })) return p;
  return null;
}

/** Every transcript, newest first. Used by --all and by the cwd fallback. */
async function allTranscripts(): Promise<{ path: string; mtime: number }[]> {
  if (!existsSync(PROJECTS)) return [];
  const { statSync } = require("node:fs");
  const out: { path: string; mtime: number }[] = [];
  for await (const p of new Glob("*/*.jsonl").scan({ cwd: PROJECTS, absolute: true })) {
    try {
      out.push({ path: p, mtime: statSync(p).mtimeMs });
    } catch {
      // deleted mid-scan
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Inside a session `CLAUDE_CODE_SESSION_ID` names it exactly; hooks pass
 * `--transcript`. From a bare terminal neither exists, so we guess the newest
 * transcript for this cwd — with many agents running that is a coin flip, so the
 * caller reports `resolvedBy: "guess"` and prints which session it landed on.
 */
async function findTranscript(): Promise<{ path: string; how: Ctx["resolvedBy"] } | null> {
  const id = process.env.CLAUDE_CODE_SESSION_ID;
  if (id) {
    const p = await transcriptForSession(id);
    if (p) return { path: p, how: "env" };
  }

  // Claude Code slugifies the session's cwd (usually a repo root) by replacing
  // every non-alphanumeric run with "-". We may be in a subdirectory of it, so
  // walk up until a project dir matches.
  const transcripts = await allTranscripts();
  const home = homedir();
  for (let dir = process.cwd(); dir.startsWith(home); dir = dirname(dir)) {
    const prefix = join(PROJECTS, dir.replace(/[^a-zA-Z0-9]/g, "-")) + "/";
    const newest = transcripts.find((t) => t.path.startsWith(prefix));
    if (newest) return { path: newest.path, how: "guess" };
    if (dir === home) break; // dirname(home) escapes the loop guard on some paths
  }
  return null;
}

/**
 * The record we want is the last one, and transcripts run to megabytes — this
 * runs on every tool call, so read a tail slice first and only fall back to the
 * whole file if the tail happens to hold no usable message. Slicing mid-record
 * is safe: the leading partial line fails JSON.parse and is skipped.
 */
const TAIL_BYTES = 512 * 1024;

async function readContext(transcript: string, limitOverride?: number): Promise<Ctx> {
  const file = Bun.file(transcript);
  let ctx: Ctx;
  try {
    const size = file.size;
    const tail = size <= TAIL_BYTES ? await file.text() : await file.slice(size - TAIL_BYTES, size).text();
    ctx = scan(tail, transcript, limitOverride);
    if (!ctx.ok && size > TAIL_BYTES) ctx = scan(await file.text(), transcript, limitOverride);
  } catch (e) {
    return { ok: false, error: `unreadable transcript: ${(e as Error).message}` };
  }
  return ctx;
}

function scan(text: string, transcript: string, limitOverride?: number): Ctx {
  // Walk backwards: the newest usable assistant message is the live context.
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"usage"')) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // partial line (transcript is appended to live)
    }
    if (rec.type !== "assistant" || rec.isSidechain) continue; // subagents have their own windows
    const u = rec.message?.usage;
    const model = rec.message?.model;
    if (!u || model === "<synthetic>") continue; // synthetic turns carry no real usage

    // Input-only, matching the `context_window.used_percentage` that Claude Code's
    // own statusLine reports — so this agrees with /context rather than quietly
    // reading a few percent higher. The last reply is reported separately: it is
    // not in the window yet, but the next request resends it.
    const used =
      (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const usedWithOutput = used + (u.output_tokens ?? 0);

    // A window we thought was 200k but that holds >200k was always the big one.
    let limit = limitOverride ?? configuredWindow();
    const inferredLimit = !limitOverride && usedWithOutput > limit;
    if (inferredLimit) limit = LARGE_WINDOW;

    return {
      ok: true,
      used,
      limit,
      pct: (used / limit) * 100,
      model,
      transcript,
      inferredLimit,
      usedWithOutput,
      session: sessionId(transcript),
      project: projectLabel(transcript),
    };
  }
  return {
    ok: false,
    error: "no assistant message with usage yet",
    transcript,
    session: sessionId(transcript),
    project: projectLabel(transcript),
  };
}

const HELP = `ctxmeter — context-window usage for a Claude Code session

usage: ctxmeter [--all] [--session ID] [--transcript PATH] [--json]
                [--limit N] [--threshold N] [--no-color]

  --all          sessions active in the last 24h, newest first (several agents)
  --since N      with --all: look back N hours instead of 24
  --session ID   a specific session id
  --transcript P a specific transcript file (what hooks pass)
  --json         machine-readable JSON
  --limit N      context window size in tokens (default: inferred from settings model)
  --threshold N  exit 1 when usage is at/above N% (for hooks and guards)
  --no-color     disable ANSI color
  -h, --help     show this help

Run inside a session (reads $CLAUDE_CODE_SESSION_ID) or from a hook (--transcript).
From a plain terminal neither exists, so it falls back to the newest transcript for
the current directory and labels the row with the session it picked. With several
agents running, prefer --all or --session.

Exit: 0 normal, 1 at/above --threshold, 2 usage could not be determined.`;

function renderRow(style: Style, ctx: Ctx, opts: { showSession: boolean; ageMs?: number }): string {
  const col = severityColor(style, ctx.pct!);
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  const label = opts.showSession
    ? style.gray(`${ctx.session!.slice(0, 8)} ${(ctx.project ?? "").slice(0, 16).padEnd(16)}`)
    : style.gray("context".padEnd(9));
  const notes = [`${k(ctx.used!)} / ${k(ctx.limit!)}`];
  if (opts.ageMs !== undefined) notes.push(humanAgo(opts.ageMs));
  if (ctx.inferredLimit) notes.push("limit inferred from usage");
  return `  ${label} ${col(pct(ctx.pct!).padStart(4))}  ${col(bar(ctx.pct!))}  ${style.dim(notes.join(" · "))}`;
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      json: { type: "boolean", default: false },
      "no-color": { type: "boolean", default: false },
      limit: { type: "string" },
      threshold: { type: "string" },
      transcript: { type: "string" },
      session: { type: "string" },
      all: { type: "boolean", default: false },
      since: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const limitOverride = values.limit
    ? Number(values.limit)
    : process.env.CTXMETER_LIMIT
      ? Number(process.env.CTXMETER_LIMIT)
      : undefined;
  if (limitOverride !== undefined && (!Number.isFinite(limitOverride) || limitOverride <= 0)) {
    console.error("ctxmeter: --limit must be a positive number");
    process.exit(2);
  }

  const style = makeStyle(values["no-color"] ? false : colorEnabled());
  const now = Date.now();

  if (values.all) {
    const idleMs = (values.since ? Number(values.since) : 24) * 3600_000;
    if (!Number.isFinite(idleMs) || idleMs <= 0) {
      console.error("ctxmeter: --since must be a positive number of hours");
      process.exit(2);
    }
    const rows = await allTranscripts();
    const fresh = rows.filter((r) => now - r.mtime <= idleMs);
    const results: Ctx[] = [];
    for (const { path, mtime } of fresh) {
      const c = await readContext(path, limitOverride);
      if (!c.ok) continue;
      results.push({ ...c, resolvedBy: "transcript" });
      if (!values.json) console.log(renderRow(style, c, { showSession: true, ageMs: now - mtime }));
    }
    if (values.json) console.log(JSON.stringify(results, null, 2));
    else {
      const omitted = rows.length - fresh.length;
      // Never let a filtered list read as "this is everything".
      if (omitted) console.log(style.dim(`  ${omitted} session(s) idle >${idleMs / 3600_000}h omitted (--since N)`));
      if (!results.length) console.error("ctxmeter: no sessions with usage in that window");
    }
    if (!results.length) process.exit(2);
    return;
  }

  let transcript: string | null = values.transcript ?? null;
  let how: Ctx["resolvedBy"] = values.transcript ? "transcript" : undefined;
  if (!transcript && values.session) {
    transcript = await transcriptForSession(values.session);
    how = "session";
    if (!transcript) {
      console.error(`ctxmeter: no transcript for session ${values.session}`);
      process.exit(2);
    }
  }
  if (!transcript) {
    const found = await findTranscript();
    if (found) ({ path: transcript, how } = found);
  }

  const ctx: Ctx = transcript
    ? { ...(await readContext(transcript, limitOverride)), resolvedBy: how }
    : { ok: false, error: "no transcript found (run inside a session, or pass --session/--transcript)" };

  if (values.json) {
    console.log(JSON.stringify(ctx, null, 2));
  } else if (!ctx.ok) {
    console.error(`ctxmeter: ${ctx.error}`);
  } else {
    // A guessed session must never look authoritative — name it.
    console.log(renderRow(style, ctx, { showSession: ctx.resolvedBy === "guess" }));
    if (ctx.resolvedBy === "guess")
      console.log(style.dim(`  (guessed from cwd; several agents may be running — try --all)`));
  }

  // Usage we could not determine must never read as "plenty of room".
  if (!ctx.ok) process.exit(2);
  const threshold = values.threshold ? Number(values.threshold) : undefined;
  if (threshold !== undefined && Number.isFinite(threshold) && ctx.pct! >= threshold) process.exit(1);
}

main().catch((e) => {
  console.error(`ctxmeter: ${(e as Error).message}`);
  process.exit(2);
});
