#!/usr/bin/env bun
/**
 * ccburn — where the Claude and Codex subscription usage went.
 *
 * ccmeter says how much of each window is spent; this says on what. Both CLIs
 * already log everything needed, locally:
 *
 *   Claude : every transcript under ~/.claude/projects (subagents included)
 *            records each API message's model and token usage. There are no
 *            percentages there, so spend is priced at Anthropic's API rates —
 *            an estimate of the share, not the subscription's own accounting.
 *   Codex  : every rollout under ~/.codex/sessions records each turn's tokens
 *            next to the account-wide weekly percentage. Each rise in that
 *            percentage is split across the tokens spent since the previous
 *            reading, so Codex shares are in real weekly-window points.
 *
 * Sessions that run a GPT model through a gateway (claude-proxy --model
 * gpt-6-sol) log to Claude transcripts but spend Codex quota, so they're
 * counted under Codex.
 *
 * Flags:  --since 6h|2d|ISO  --by project|model|caller  --top N  --timeline
 *         --claude | --codex  --json  --no-color  -h/--help
 */
import { parseArgs } from "node:util";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { readHistory, type HistoryEntry } from "./lib/history.ts";
import { colorEnabled, makeStyle, type Style } from "./lib/format.ts";
import { jsonlRecursive } from "./lib/walk.ts";

const HOME = homedir();
const WEEK_MS = 7 * 24 * 3600 * 1000;

// ------------------------------------------------------------------ pricing

// USD per million tokens at Anthropic's API rates (as of 2026-09-25). Only the
// ratios matter here; they turn a mix of models and cache behaviour into one
// comparable number. First match wins, so longer prefixes come first.
interface Price {
  input: number;
  output: number;
  cacheRead: number;
}
const PRICES: [string, Price][] = [
  ["claude-fable-5-1", { input: 10, output: 50, cacheRead: 0.25 }],
  ["claude-mythos-5-1", { input: 10, output: 50, cacheRead: 0.25 }],
  ["claude-fable", { input: 10, output: 50, cacheRead: 1 }],
  ["claude-mythos", { input: 10, output: 50, cacheRead: 1 }],
  ["claude-opus-5-5", { input: 4, output: 20, cacheRead: 0.2 }],
  ["claude-opus", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-sonnet-5", { input: 2, output: 10, cacheRead: 0.2 }],
  ["claude-sonnet", { input: 3, output: 15, cacheRead: 0.3 }],
  ["claude-haiku", { input: 1, output: 5, cacheRead: 0.1 }],
];
const UNKNOWN_CLAUDE = PRICES.find(([p]) => p === "claude-opus-5-5")![1];

function claudePrice(model: string): Price {
  const bare = model.replace(/\[1m\]$/, "").replace(/^[a-z]+\//, ""); // "work/claude-…" prefixes
  return PRICES.find(([p]) => bare.startsWith(p))?.[1] ?? UNKNOWN_CLAUDE;
}

// Codex has no published per-token rates for its subscription models, and
// needs none: the weekly percentage is recorded, and these weights only decide
// how each rise is split between the turns that caused it. Cached input costs
// a tenth of fresh input and output about four times it, as on OpenAI's API.
const codexUnits = (fresh: number, cached: number, output: number) => fresh + 0.1 * cached + 4 * output;

// ------------------------------------------------------------------ records

type Provider = "claude" | "codex";

/** One API call's worth of spend. */
interface Spend {
  t: number; // epoch ms
  provider: Provider;
  session: string;
  caller: string; // main, subagent:<type>, codex exec, …
  model: string;
  cost: number; // claude: USD at API rates · codex: weighted tokens (see codexUnits)
  points: number; // codex: weekly-window points allocated to this call
  tokens: { input: number; cacheWrite: number; cacheRead: number; output: number };
}

interface SessionInfo {
  provider: Provider;
  project: string;
  caller: string;
  prompt: string;
}

/** A Codex weekly reading, straight from a rollout. */
interface Reading {
  t: number;
  pct: number;
  resetsAt: number | null; // epoch ms
}

// ------------------------------------------------------------------ helpers

/** "mentes-ai/mentes-runtime", with worktree and temp-dir noise folded away. */
function projectOf(cwd: string | undefined): string {
  if (!cwd) return "?";
  let p = cwd.replace(/\/\.(claude|codex)\/worktrees\/[^/]+.*$/, "").replace(/-wt-[0-9a-f]{3,}$/, "");
  if (/^\/(private\/)?(var\/folders|tmp)\//.test(p)) return "(temp dir)";
  if (p === "/") return "/";
  if (p.startsWith(join(HOME, "Projects") + "/")) return p.slice(join(HOME, "Projects").length + 1);
  if (p.startsWith(HOME)) return "~" + p.slice(HOME.length);
  return p;
}

/** The first thing a person (or a calling agent) asked, on one line. */
function promptText(content: unknown): string | null {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join(" ")
        : "";
  const t = text.replace(/\s+/g, " ").trim();
  // Harness-injected turns: reminders, command wrappers, AGENTS.md, environment blocks.
  if (!t || t.startsWith("<") || t.startsWith("# AGENTS.md") || t.startsWith("Caveat:")) return null;
  return t.slice(0, 160);
}

function parseSince(s: string, now = Date.now()): number {
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([mhdw])$/);
  if (m) return now - Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3, w: WEEK_MS }[m[2] as "m" | "h" | "d" | "w"];
  const t = Date.parse(s);
  if (Number.isFinite(t)) return t;
  throw new Error(`--since: expected 6h, 2d, 1w or a date, got "${s}"`);
}

async function filesSince(root: string, sinceMs: number): Promise<string[]> {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const p of await jsonlRecursive(root)) {
    try {
      if (statSync(p).mtimeMs >= sinceMs) out.push(p);
    } catch {
      // deleted mid-scan
    }
  }
  return out;
}

// ------------------------------------------------------------------ Claude

async function collectClaude(sinceMs: number, sessions: Map<string, SessionInfo>): Promise<Spend[]> {
  const out: Spend[] = [];
  const seen = new Set<string>(); // a message is logged once per content block
  for (const path of await filesSince(join(HOME, ".claude", "projects"), sinceMs)) {
    const sub = basename(dirname(path)) === "subagents";
    let caller = "main";
    if (sub) {
      try {
        const meta = JSON.parse(await readFile(path.replace(/\.jsonl$/, ".meta.json"), "utf8"));
        caller = `subagent:${meta.agentType ?? "?"}`;
      } catch {
        caller = "subagent";
      }
    }
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    let promptSeen = sub; // a subagent's prompt is its caller's business
    for (const line of text.split("\n")) {
      const isUsage = line.includes('"usage"');
      if (!isUsage && (promptSeen || !line.includes('"type":"user"'))) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const session: string | undefined = rec.sessionId;
      if (!session) continue;
      // Subagents share their parent's session id; the parent's transcript
      // names the session, whichever file happens to be read first.
      let info = sessions.get(session);
      if (!info || (!sub && info.caller !== "main")) {
        info = { provider: "claude", project: projectOf(rec.cwd), caller, prompt: info?.prompt ?? "" };
        sessions.set(session, info);
      }

      if (!promptSeen && rec.type === "user" && !rec.isSidechain) {
        const p = promptText(rec.message?.content);
        if (p) {
          info.prompt = p;
          promptSeen = true;
        }
        continue;
      }

      const msg = rec.message;
      const u = msg?.usage;
      if (rec.type !== "assistant" || !u || !msg.model || msg.model === "<synthetic>") continue;
      const t = Date.parse(rec.timestamp);
      if (!(t >= sinceMs)) continue;
      // One message is logged once per content block, all with the same usage.
      // A per-line uuid would bill each block again, so fall back to the usage itself.
      const id = msg.id ?? `${rec.timestamp}|${msg.model}|${JSON.stringify(u)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      // Older Claude Code wrote subagent turns inline; they're subagent spend
      // wherever they're found, not whichever file the walk reached first.
      const spendCaller = rec.isSidechain && !sub ? "subagent" : caller;

      const input = u.input_tokens ?? 0;
      const cacheRead = u.cache_read_input_tokens ?? 0;
      const cacheWrite = u.cache_creation_input_tokens ?? 0;
      const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      const output = u.output_tokens ?? 0;
      const tokens = { input, cacheWrite, cacheRead, output };
      const model: string = msg.model;

      if (!model.includes("claude")) {
        // A GPT model behind a gateway spends Codex quota and is recorded only
        // here. Anything else (Gemini, a local model) is neither provider's.
        if (!/^(?:[a-z]+\/)?(gpt|o\d|codex)/i.test(model)) continue;
        out.push({
          t,
          provider: "codex",
          session: `claude:${session}`,
          caller: "claude code (gateway)",
          model,
          cost: codexUnits(input + cacheWrite, cacheRead, output),
          points: 0,
          tokens,
        });
        if (!sessions.has(`claude:${session}`))
          sessions.set(`claude:${session}`, { ...info, provider: "codex", caller: "claude code (gateway)" });
        continue;
      }
      const pr = claudePrice(model);
      const cost =
        (input * pr.input +
          (cacheWrite - write1h) * pr.input * 1.25 +
          write1h * pr.input * 2 +
          cacheRead * pr.cacheRead +
          output * pr.output) /
        1e6;
      out.push({ t, provider: "claude", session, caller: spendCaller, model: model.replace(/\[1m\]$/, ""), cost, points: 0, tokens });
    }
  }
  return out;
}

// ------------------------------------------------------------------ Codex

/** Rate-limit readings and per-turn spend from the Codex rollouts. */
async function collectCodex(
  sinceMs: number,
  sessions: Map<string, SessionInfo>,
): Promise<{ spends: Spend[]; readings: Reading[] }> {
  const spends: Spend[] = [];
  const readings: Reading[] = [];
  for (const path of await filesSince(join(HOME, ".codex", "sessions"), sinceMs)) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const session = basename(path, ".jsonl");
    const first = spends.length;
    const info: SessionInfo = { provider: "codex", project: "?", caller: "?", prompt: "" };
    let model = "?";
    let prev: { fresh: number; cached: number; output: number } | null = null;
    for (const line of text.split("\n")) {
      const head = line.slice(0, 160);
      const kind = head.includes('"session_meta"')
        ? "meta"
        : head.includes('"turn_context"')
          ? "turn"
          : line.includes('"token_count"')
            ? "count"
            : !info.prompt && (line.includes('"user_message"') || line.includes('"role":"user"'))
              ? "prompt"
              : null;
      if (!kind) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const p = rec.payload ?? {};
      if (kind === "meta") {
        info.project = projectOf(p.cwd);
        // Reviews run in throwaway worktrees under $TMPDIR; the repo is still on record.
        const repo = String(p.git?.repository_url ?? "").match(/([^/:]+?)(\.git)?$/)?.[1];
        if (info.project === "(temp dir)" && repo) info.project = `repo:${repo}`;
        info.caller = String(p.originator ?? p.source ?? "?").replace(/_/g, " ");
      } else if (kind === "turn") {
        if (p.model) model = p.model;
      } else if (kind === "prompt") {
        info.prompt = promptText(p.message ?? p.content) ?? "";
      } else {
        const t = Date.parse(rec.timestamp);
        const tot = p.info?.total_token_usage;
        if (tot) {
          const cur = {
            fresh: Math.max(0, (tot.input_tokens ?? 0) - (tot.cached_input_tokens ?? 0)),
            cached: tot.cached_input_tokens ?? 0,
            output: tot.output_tokens ?? 0,
          };
          // Differences of the running totals, not last_token_usage: Codex
          // re-emits a token_count with an unchanged total (46 of 4140 events
          // in one sample), and last_token_usage would bill those turns twice.
          // A total that falls means the counter restarted; count it afresh.
          const restarted = prev !== null && cur.fresh + cur.cached + cur.output < prev.fresh + prev.cached + prev.output;
          const d =
            prev && !restarted
              ? {
                  fresh: Math.max(0, cur.fresh - prev.fresh),
                  cached: Math.max(0, cur.cached - prev.cached),
                  output: Math.max(0, cur.output - prev.output),
                }
              : cur;
          prev = cur;
          if (t >= sinceMs && (d.fresh || d.cached || d.output))
            spends.push({
              t,
              provider: "codex",
              session,
              caller: "",
              model,
              cost: codexUnits(d.fresh, d.cached, d.output),
              points: 0,
              tokens: { input: d.fresh, cacheWrite: 0, cacheRead: d.cached, output: d.output },
            });
        }
        const rl = p.rate_limits;
        if (rl && (!rl.limit_id || rl.limit_id === "codex") && Number.isFinite(t))
          for (const w of [rl.primary, rl.secondary])
            if (w && (w.window_minutes ?? 0) > 24 * 60 && typeof w.used_percent === "number")
              readings.push({ t, pct: w.used_percent, resetsAt: w.resets_at ? w.resets_at * 1000 : null });
      }
    }
    sessions.set(session, info);
    // session_meta names the caller; turns logged before it was read get it too.
    for (let k = first; k < spends.length; k++) spends[k]!.caller = info.caller;
  }
  readings.sort((a, b) => a.t - b.t);
  return { spends, readings };
}

/** Fold "repo:mentes-web" into "mentes-ai/mentes-web" when that project shows up elsewhere. */
function resolveRepoProjects(sessions: Map<string, SessionInfo>): void {
  const byName = new Map<string, string>();
  for (const { project } of sessions.values())
    if (!project.startsWith("repo:")) byName.set(project.split("/").at(-1)!, project);
  for (const info of sessions.values())
    if (info.project.startsWith("repo:")) {
      const name = info.project.slice(5);
      info.project = byName.get(name) ?? name;
    }
}

/**
 * Split each rise in the weekly percentage across the spend that caused it, in
 * proportion to weighted tokens. Spend before the first reading has no baseline
 * to measure against and stays unallocated.
 *
 * Codex reports whole points, so a reading one point up covers everything since
 * the last rise, not just since the last reading. Splitting it over the latest
 * interval alone pinned rises on whatever ran just before the tick: the
 * tab-title namer, which fires every few minutes, took 15 points that way.
 *
 * Concurrent sessions also report slightly out of order (74, 73, 74), so the
 * baseline only moves up; counting each wobble back up as new usage attributed
 * more points than the window rose. A new window is recognised by its reset
 * time moving, not by the percentage dropping.
 */
function allocatePoints(spends: Spend[], readings: Reading[]): void {
  const sorted = [...spends].sort((a, b) => a.t - b.t);
  let i = 0;
  let high: number | null = null;
  let window: number | null = null;
  let pending: Spend[] = [];
  for (const r of readings) {
    while (i < sorted.length && sorted[i]!.t <= r.t) pending.push(sorted[i++]!);
    const newWindow = window !== null && r.resetsAt !== null && Math.abs(r.resetsAt - window) > 3600e3;
    if (r.resetsAt !== null) window = r.resetsAt;
    if (high === null || newWindow) {
      // Nothing to measure the first reading against; after a reset the
      // points so far belong to spend we can't separate from the old window's.
      high = r.pct;
      pending = [];
      continue;
    }
    const rise = r.pct - high;
    if (rise <= 0) continue;
    high = r.pct;
    const units = pending.reduce((s, x) => s + x.cost, 0);
    if (units > 0) for (const x of pending) x.points += (rise * x.cost) / units;
    pending = [];
  }
}

// ------------------------------------------------------------------ report

interface Row {
  key: string;
  cost: number;
  points: number;
  calls: number;
  sessions: Set<string>;
}

interface Report {
  provider: Provider;
  since: number;
  sinceWhy: string;
  total: { cost: number; points: number; calls: number };
  range?: { from: number; to: number }; // codex weekly % across the window
  groups: { key: string; share: number; cost: number; points: number; calls: number; sessions: number }[];
  sessions: {
    id: string;
    from: number;
    to: number;
    model: string;
    project: string;
    caller: string;
    prompt: string;
    cost: number;
    points: number;
  }[];
  hours: { hour: number; cost: number; points: number; readings?: string }[];
}

function build(
  provider: Provider,
  spends: Spend[],
  sessions: Map<string, SessionInfo>,
  since: number,
  sinceWhy: string,
  by: string,
  top: number,
  readings: Reading[],
  history: HistoryEntry[],
): Report {
  const metric = (x: { cost: number; points: number }) => (provider === "codex" ? x.points : x.cost);
  const total = { cost: 0, points: 0, calls: spends.length };
  const groups = new Map<string, Row>();
  const perSession = new Map<
    string,
    { from: number; to: number; cost: number; points: number; sub: number; models: Map<string, number> }
  >();
  const hours = new Map<number, { cost: number; points: number }>();

  for (const s of spends) {
    total.cost += s.cost;
    total.points += s.points;
    const info = sessions.get(s.session);
    const key = by === "model" ? s.model : by === "caller" ? s.caller : (info?.project ?? "?");
    const g = groups.get(key) ?? { key, cost: 0, points: 0, calls: 0, sessions: new Set<string>() };
    g.cost += s.cost;
    g.points += s.points;
    g.calls++;
    g.sessions.add(s.session);
    groups.set(key, g);

    const ps = perSession.get(s.session) ?? { from: s.t, to: s.t, cost: 0, points: 0, sub: 0, models: new Map() };
    if (s.caller.startsWith("subagent")) ps.sub += metric(s);
    ps.from = Math.min(ps.from, s.t);
    ps.to = Math.max(ps.to, s.t);
    ps.cost += s.cost;
    ps.points += s.points;
    ps.models.set(s.model, (ps.models.get(s.model) ?? 0) + s.cost);
    perSession.set(s.session, ps);

    const h = Math.floor(s.t / 3600e3) * 3600e3;
    const hb = hours.get(h) ?? { cost: 0, points: 0 };
    hb.cost += s.cost;
    hb.points += s.points;
    hours.set(h, hb);
  }

  const denom = metric(total) || 1;
  const report: Report = {
    provider,
    since,
    sinceWhy,
    total,
    groups: [...groups.values()]
      .sort((a, b) => metric(b) - metric(a))
      .slice(0, top)
      .map((g) => ({
        key: g.key,
        share: (metric(g) / denom) * 100,
        cost: g.cost,
        points: g.points,
        calls: g.calls,
        sessions: g.sessions.size,
      })),
    sessions: [...perSession.entries()]
      .sort((a, b) => metric(b[1]) - metric(a[1]))
      .slice(0, top)
      .map(([id, ps]) => {
        const info = sessions.get(id);
        return {
          id,
          from: ps.from,
          to: ps.to,
          model: [...ps.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "?",
          project: info?.project ?? "?",
          // A Claude session's own spend and its subagents' add up to one row.
          caller:
            provider === "claude"
              ? ps.sub > 0
                ? `main + subagents ${Math.round((ps.sub / (metric(ps) || 1)) * 100)}%`
                : (info?.caller ?? "?")
              : (info?.caller ?? "?"),
          prompt: info?.prompt ?? "",
          cost: ps.cost,
          points: ps.points,
        };
      }),
    hours: [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([hour, v]) => ({ hour, ...v })),
  };

  // What the meters themselves read in each hour: Codex's own snapshots, and
  // for Claude whatever ccmeter logged.
  const span = (vals: number[]) => {
    const lo = Math.round(Math.min(...vals));
    const hi = Math.round(Math.max(...vals));
    return lo === hi ? `${lo}%` : `${lo}→${hi}%`;
  };
  for (const h of report.hours) {
    const inHour = (t: number) => t >= Math.max(h.hour, since) && t < h.hour + 3600e3;
    if (provider === "codex") {
      const v = readings.filter((r) => inHour(r.t)).map((r) => r.pct);
      if (v.length) h.readings = `read weekly ${span(v)}`;
    } else {
      const es = history.filter((e) => e.claude && inHour(e.at));
      const five = es.map((e) => e.claude!.fiveHour?.pct).filter((x): x is number => x != null);
      const week = es.map((e) => e.claude!.weekly?.pct).filter((x): x is number => x != null);
      const parts = [five.length && `5h ${span(five)}`, week.length && `weekly ${span(week)}`].filter(Boolean);
      if (parts.length) h.readings = `read ${parts.join(" · ")}`;
    }
  }
  if (provider === "codex") {
    const inWin = readings.filter((r) => r.t >= since);
    if (inWin.length) report.range = { from: inWin[0]!.pct, to: inWin[inWin.length - 1]!.pct };
  }
  return report;
}

// ------------------------------------------------------------------ rendering

const clock = (t: number) =>
  new Date(t).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const until = (from: number, to: number) =>
  new Date(from).toDateString() === new Date(to).toDateString() ? hhmm(to) : clock(to);
const usd = (n: number) => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);
const pts = (n: number) => `+${n >= 10 ? n.toFixed(0) : n.toFixed(1)}%`;
const fit = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + "…" : s.padEnd(w));

function render(style: Style, r: Report, by: string, timeline: boolean): string[] {
  const codex = r.provider === "codex";
  const amount = (x: { cost: number; points: number }) => (codex ? pts(x.points) : usd(x.cost));
  const headline = codex
    ? r.range
      ? `weekly ${Math.round(r.range.from)}→${Math.round(r.range.to)}%, ${pts(r.total.points)} attributed`
      : "no weekly readings in this window"
    : `${usd(r.total.cost)} at API rates`;
  const lines = [
    `${style.bold(codex ? "Codex" : "Claude")}  ${style.dim(`· since ${clock(r.since)} (${r.sinceWhy}) · ${headline} · ${r.total.calls} calls`)}`,
  ];
  if (!r.total.calls) return [...lines, `  ${style.dim("nothing spent in this window")}`];

  lines.push(`  ${style.gray(`by ${by}`)}`);
  for (const g of r.groups)
    lines.push(
      `    ${g.share.toFixed(0).padStart(3)}%  ${amount(g).padStart(6)}  ${fit(g.key, 42)} ${style.dim(`${g.sessions} session${g.sessions === 1 ? "" : "s"}`)}`,
    );

  lines.push(`  ${style.gray("top sessions")}`);
  for (const s of r.sessions) {
    lines.push(
      `    ${amount(s).padStart(6)}  ${clock(s.from)}–${until(s.from, s.to)}  ${fit(s.model.replace(/^claude-/, ""), 12)} ${fit(s.project, 30)} ${style.dim(s.caller)}`,
    );
    if (s.prompt) lines.push(`            ${style.dim(`"${s.prompt.slice(0, 110)}${s.prompt.length > 110 ? "…" : ""}"`)}`);
  }

  const metric = (h: { cost: number; points: number }) => (codex ? h.points : h.cost);
  const hours = timeline ? r.hours : [...r.hours].sort((a, b) => metric(b) - metric(a)).slice(0, 5);
  lines.push(`  ${style.gray(timeline ? "by hour" : "steepest hours")}`);
  for (const h of hours)
    lines.push(`    ${clock(h.hour)}  ${amount(h).padStart(6)}  ${style.dim(h.readings ?? "")}`);
  return lines;
}

// ------------------------------------------------------------------ main

const HELP = `ccburn — where the Claude and Codex subscription usage went

usage: ccburn [--since 6h|2d|1w|DATE] [--by project|model|caller] [--top N]
              [--timeline] [--claude | --codex] [--json] [--no-color]

  --since      window start (default: the start of each provider's current
               weekly window, else the last 7 days)
  --by         how to group the first table (default: project)
  --top N      rows per table (default: 8)
  --timeline   every hour, instead of the five steepest
  --claude, --codex   one provider only
  --json       machine-readable

Claude spend is priced at Anthropic's API rates from local transcripts: an
estimate of the share, not the subscription's own accounting. Codex spend is in
weekly-window points, from the percentages Codex records next to each turn.
Only this machine's logs are read.`;

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      since: { type: "string" },
      by: { type: "string", default: "project" },
      top: { type: "string", default: "8" },
      timeline: { type: "boolean", default: false },
      claude: { type: "boolean", default: false },
      codex: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "no-color": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  if (values.help) return console.log(HELP);
  if (!["project", "model", "caller"].includes(values.by!)) throw new Error(`--by: expected project, model or caller`);
  const top = Math.max(1, Number(values.top) || 8);
  const want = (p: Provider) => (!values.claude && !values.codex) || values[p];

  const now = Date.now();
  const explicit = values.since ? parseSince(values.since, now) : null;
  // Read a little more than a week so the window start can be found first.
  const scanFrom = explicit ?? now - WEEK_MS - 86400e3;
  const sessions = new Map<string, SessionInfo>();
  const [claudeAll, codexData, history] = await Promise.all([
    collectClaude(scanFrom, sessions),
    want("codex") ? collectCodex(scanFrom, sessions) : Promise.resolve({ spends: [], readings: [] }),
    readHistory(scanFrom),
  ]);

  resolveRepoProjects(sessions);

  // Each provider's weekly window, from its latest reset time.
  // A reset time already past means the newest reading predates the reset:
  // the current window began at that reset (or a whole week after it).
  const windowStart = (resetsAt: number | string | null | undefined) => {
    let t = typeof resetsAt === "string" ? Date.parse(resetsAt) : resetsAt;
    if (!t || !Number.isFinite(t)) return null;
    while (t <= now) t += WEEK_MS;
    return t - WEEK_MS;
  };
  const codexReset = windowStart(codexData.readings.at(-1)?.resetsAt);
  const claudeReset = windowStart([...history].reverse().find((e) => e.claude?.weekly)?.claude?.weekly?.resetsAt);
  const since = (reset: number | null): [number, string] =>
    explicit !== null ? [explicit, `--since ${values.since}`] : reset ? [reset, "weekly window"] : [now - WEEK_MS, "last 7 days"];

  const reports: Report[] = [];
  if (want("claude")) {
    const [from, why] = since(claudeReset);
    const spends = claudeAll.filter((s) => s.provider === "claude" && s.t >= from);
    reports.push(build("claude", spends, sessions, from, why, values.by!, top, [], history));
  }
  if (want("codex")) {
    const [from, why] = since(codexReset);
    const spends = [...codexData.spends, ...claudeAll.filter((s) => s.provider === "codex")].filter((s) => s.t >= from);
    allocatePoints(spends, codexData.readings.filter((r) => r.t >= from));
    reports.push(build("codex", spends, sessions, from, why, values.by!, top, codexData.readings, history));
  }

  if (values.json) {
    const out: Record<string, Report> = {};
    for (const r of reports) out[r.provider] = r;
    return console.log(JSON.stringify({ ...out, generatedAt: new Date(now).toISOString() }, null, 2));
  }
  const style = makeStyle(values["no-color"] ? false : colorEnabled());
  console.log(reports.map((r) => render(style, r, values.by!, values.timeline!).join("\n")).join("\n\n"));
}

main().catch((e) => {
  console.error(`ccburn: ${(e as Error).message}`);
  process.exit(1);
});
