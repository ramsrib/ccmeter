#!/usr/bin/env bun
/**
 * ccmeter — at-a-glance subscription usage for Claude (Code) and Codex.
 *
 *   Claude : live, authoritative read of the undocumented OAuth usage endpoint
 *            (GET api.anthropic.com/api/oauth/usage) using the Claude Code
 *            OAuth token from the Keychain / ~/.claude. Shows 5h + weekly
 *            utilization and, when enabled, extra-usage credit spend.
 *   Codex  : the most recent rate-limit snapshot Codex persists to its rollout
 *            logs (~/.codex/sessions/**.jsonl) — the same numbers the TUI
 *            `/status` shows. Free (no API call), but only as fresh as your
 *            last Codex turn.
 *
 * Flags:  --json   machine-readable output  |  --no-color  |  -h/--help
 */
import { parseArgs } from "node:util";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { loadClaudeCreds } from "./lib/creds";
import {
  bar,
  colorEnabled,
  fmtReset,
  humanAgo,
  makeStyle,
  money,
  pct,
  severity,
  severityColor,
  type Style,
} from "./lib/format";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
// The endpoint hard-429s (or 401s) without a claude-code User-Agent. The exact
// version isn't significant — only the shape — so a constant avoids spawning
// `claude --version` on every run. Bump if Anthropic ever tightens this.
const CLAUDE_UA = "claude-code/2.1.201";

interface UsageWindow {
  pct: number;
  resetsAt: string | number | null;
}

interface ClaudeUsage {
  ok: boolean;
  error?: string;
  plan?: string;
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  // Per-model / per-surface caps (e.g. Fable) that draw down a parent window
  // rather than a bucket of their own — `group` names the parent, and the
  // entry's `resets_at` is null because it resets with it. The `limits[]`
  // array is the source of truth `/usage` renders from; the legacy top-level
  // fields don't expose these.
  scoped?: { label: string; group: string; window: UsageWindow }[];
  credits?: { pct: number; used: number; limit: number; currency: string };
}

interface CodexUsage {
  ok: boolean;
  error?: string;
  plan?: string;
  capturedAt?: number; // epoch ms of the snapshot
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
}

// ---------------------------------------------------------------- Claude (live)

async function getClaudeUsage(): Promise<ClaudeUsage> {
  const creds = await loadClaudeCreds();
  if (!creds) return { ok: false, error: "not logged in — run: claude login" };

  let res: Response;
  try {
    res = await fetch(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${creds.token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": CLAUDE_UA,
        "Content-Type": "application/json",
      },
    });
  } catch (e) {
    return { ok: false, error: `request failed: ${(e as Error).message}`, plan: creds.subscriptionType };
  }

  if (res.status === 401)
    return { ok: false, error: "token expired — run: claude login", plan: creds.subscriptionType };
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, plan: creds.subscriptionType };

  const d = (await res.json()) as any;
  const out: ClaudeUsage = { ok: true, plan: creds.subscriptionType };
  if (d.five_hour)
    out.fiveHour = { pct: d.five_hour.utilization ?? 0, resetsAt: d.five_hour.resets_at ?? null };
  if (d.seven_day)
    out.weekly = { pct: d.seven_day.utilization ?? 0, resetsAt: d.seven_day.resets_at ?? null };

  // Model/surface-scoped caps (e.g. Fable) live only in `limits[]`.
  if (Array.isArray(d.limits)) {
    const scoped = d.limits
      .filter((l: any) => typeof l?.kind === "string" && l.kind.endsWith("_scoped"))
      .map((l: any) => {
        const model = l.scope?.model?.display_name;
        const surface = l.scope?.surface;
        const label = model ?? surface ?? "scoped";
        return {
          label,
          group: l.group ?? "weekly",
          window: { pct: l.percent ?? 0, resetsAt: l.resets_at ?? null },
        };
      });
    if (scoped.length) out.scoped = scoped;
  }

  const eu = d.extra_usage;
  if (eu?.is_enabled) {
    const div = 10 ** (eu.decimal_places ?? 2);
    out.credits = {
      pct: eu.utilization ?? 0,
      used: (eu.used_credits ?? 0) / div,
      limit: (eu.monthly_limit ?? 0) / div,
      currency: eu.currency ?? "USD",
    };
  }
  return out;
}

// -------------------------------------------------------- Codex (cached snapshot)

/** Depth-first search for a `rate_limits` object anywhere in a rollout record. */
function findRateLimits(o: any): any {
  if (o && typeof o === "object") {
    if (o.rate_limits && typeof o.rate_limits === "object") return o.rate_limits;
    for (const v of Object.values(o)) {
      const r = findRateLimits(v);
      if (r) return r;
    }
  }
  return null;
}

async function getCodexUsage(): Promise<CodexUsage> {
  const base = join(homedir(), ".codex", "sessions");
  if (!existsSync(base)) return { ok: false, error: "no Codex sessions — run codex once" };

  // Newest rollout files first; the latest snapshot lives in the freshest one.
  const files: { path: string; mtime: number }[] = [];
  for await (const p of new Glob("**/*.jsonl").scan({ cwd: base, absolute: true })) {
    try {
      files.push({ path: p, mtime: statSync(p).mtimeMs });
    } catch {
      // deleted mid-scan
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  for (const { path, mtime } of files.slice(0, 25)) {
    let text: string;
    try {
      text = await Bun.file(path).text();
    } catch {
      continue;
    }
    let last: any = null;
    for (const line of text.split("\n")) {
      if (!line.includes('"rate_limits"')) continue;
      try {
        const rl = findRateLimits(JSON.parse(line));
        if (rl) last = rl; // keep the last (most recent turn in this file)
      } catch {
        // partial / non-JSON line
      }
    }
    if (last) {
      const win = (w: any): UsageWindow | undefined =>
        w ? { pct: w.used_percent ?? 0, resetsAt: w.resets_at ? w.resets_at * 1000 : null } : undefined;

      // Bucket by window_minutes, NOT by position. `primary`/`secondary` are just
      // slots, and Codex changes what it puts in them. On 2026-07-12 ~11:20 local,
      // OpenAI *temporarily* dropped the 5h limit for Plus/Pro/Business (and reset
      // usage); the server stopped sending that window mid-session — no client
      // update involved. So the shape went from primary=300m + secondary=10080m to
      // a lone primary=10080m with secondary=null.
      //
      // Read positionally, that rendered the WEEKLY figure in the 5h row — a 5-hour
      // window "resetting in 6d", which is the tell — and left weekly blank.
      // Classifying by each window's own duration is correct for both shapes, and
      // means the 5h row simply reappears by itself when OpenAI restores the cap.
      let fiveHour: UsageWindow | undefined;
      let weekly: UsageWindow | undefined;
      for (const w of [last.primary, last.secondary]) {
        if (!w) continue;
        const mins = w.window_minutes ?? 0;
        if (mins <= 24 * 60) fiveHour = win(w);
        else weekly = win(w);
      }

      return { ok: true, plan: last.plan_type, capturedAt: mtime, fiveHour, weekly };
    }
  }
  return { ok: false, error: "no rate-limit snapshot yet — run codex once" };
}

// ---------------------------------------------------------------------- rendering

// Wide enough for "credits" and for a tree-prefixed model name ("└ Sonnet");
// a label that overflows pushes its bar out of alignment with the rows above.
const LABEL_W = 9;

function windowRow(style: Style, label: string, w: UsageWindow | undefined, extraNote?: string): string {
  const lbl = style.gray(label.padEnd(LABEL_W));
  if (!w) return `  ${lbl} ${style.dim("—")}`;
  const col = severityColor(style, w.pct);
  const notes: string[] = [];
  if (severity(w.pct) === "crit" && w.pct >= 100) notes.push("at limit");
  const reset = fmtReset(w.resetsAt);
  if (reset) notes.push(reset);
  if (extraNote) notes.push(extraNote);
  return `  ${lbl} ${col(pct(w.pct).padStart(4))}  ${col(bar(w.pct))}  ${style.dim(notes.join(" · "))}`;
}

/**
 * A parent window plus any caps that draw from it, drawn as a tree. Scoped caps
 * share the parent's window, so they carry no reset of their own — the glyph and
 * the note both say so, since a bare indented row still reads as a sibling.
 */
function groupRows(
  style: Style,
  label: string,
  group: string,
  parent: UsageWindow | undefined,
  scoped: { label: string; group: string; window: UsageWindow }[] | undefined,
): string[] {
  const rows = [windowRow(style, label, parent)];
  const kids = (scoped ?? []).filter((s) => s.group === group);
  kids.forEach((s, i) => {
    const glyph = i === kids.length - 1 ? "└" : "├";
    rows.push(windowRow(style, `${glyph} ${s.label}`, s.window, `draws from ${label}`));
  });
  return rows;
}

function providerHeader(style: Style, name: string, plan: string | undefined, right: string): string {
  const tag = plan ? ` ${style.cyan(plan)}` : "";
  const suffix = right ? `  ${style.dim(`· ${right}`)}` : "";
  return `${style.bold(name)}${tag}${suffix}`;
}

function renderClaude(style: Style, u: ClaudeUsage): string[] {
  if (!u.ok)
    return [providerHeader(style, "Claude", u.plan, ""), `  ${style.red(u.error ?? "unavailable")}`];
  const lines = [providerHeader(style, "Claude", u.plan, "live")];
  // `group` is the API's name for the parent window; the label is what we print.
  const rendered = new Set(["session", "weekly"]);
  lines.push(...groupRows(style, "5h", "session", u.fiveHour, u.scoped));
  lines.push(...groupRows(style, "weekly", "weekly", u.weekly, u.scoped));
  // A cap scoped to a window we don't render would otherwise vanish silently.
  for (const s of u.scoped ?? [])
    if (!rendered.has(s.group)) lines.push(windowRow(style, s.label, s.window, `draws from ${s.group}`));
  if (u.credits)
    lines.push(
      windowRow(
        style,
        "credits",
        { pct: u.credits.pct, resetsAt: null },
        `${money(u.credits.used, u.credits.currency)} / ${money(u.credits.limit, u.credits.currency)}`,
      ),
    );
  return lines;
}

function renderCodex(style: Style, u: CodexUsage): string[] {
  if (!u.ok)
    return [providerHeader(style, "Codex", u.plan, ""), `  ${style.red(u.error ?? "unavailable")}`];
  const age = u.capturedAt ? `snapshot ${humanAgo(Date.now() - u.capturedAt)}` : "";
  const lines = [providerHeader(style, "Codex", u.plan, age)];
  // Only draw the windows Codex actually reports. While the 5h cap is suspended
  // (see getCodexUsage), a permanent "5h —" row is noise that reads like a bug in
  // ccmeter rather than an absence upstream. It returns on its own when OpenAI
  // restores the cap.
  if (u.fiveHour) lines.push(windowRow(style, "5h", u.fiveHour));
  if (u.weekly) lines.push(windowRow(style, "weekly", u.weekly));
  if (!u.fiveHour && !u.weekly)
    lines.push(`  ${style.dim("no windows reported — run codex once")}`);
  return lines;
}

const HELP = `ccmeter — subscription usage for Claude and Codex

usage: ccmeter [--json] [--no-color]

  --json       machine-readable JSON (for scripts / pre-flight quota checks)
  --no-color   disable ANSI color
  -h, --help   show this help

Claude numbers are a live read of the OAuth usage endpoint.
Codex numbers are the latest snapshot from ~/.codex rollout logs
(as fresh as your last Codex turn).`;

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      json: { type: "boolean", default: false },
      "no-color": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const [claude, codex] = await Promise.all([getClaudeUsage(), getCodexUsage()]);

  if (values.json) {
    console.log(JSON.stringify({ claude, codex, generatedAt: new Date().toISOString() }, null, 2));
    process.exit(claude.ok || codex.ok ? 0 : 1);
  }

  const enabled = values["no-color"] ? false : colorEnabled();
  const style = makeStyle(enabled);
  const out = [...renderClaude(style, claude), "", ...renderCodex(style, codex)];
  console.log(out.join("\n"));
  process.exit(claude.ok || codex.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`ccmeter: ${(e as Error).message}`);
  process.exit(1);
});
