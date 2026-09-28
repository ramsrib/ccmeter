#!/usr/bin/env bun
/**
 * ccmeter — at-a-glance subscription usage for Claude (Code) and Codex.
 *
 *   Claude : live, authoritative read of the undocumented OAuth usage endpoint
 *            (GET api.anthropic.com/api/oauth/usage) using the Claude Code
 *            OAuth token from the Keychain / ~/.claude. Shows 5h + weekly
 *            utilization and, when enabled, extra-usage credit spend.
 *            When ANTHROPIC_BASE_URL routes Claude Code through a gateway, it
 *            meters that route instead (see getGatewayUsage).
 *   Codex  : the most recent rate-limit snapshot Codex persists to its rollout
 *            logs (~/.codex/sessions/**.jsonl) — the same numbers the TUI
 *            `/status` shows. Free (no API call), but only as fresh as your
 *            last Codex turn.
 *
 * Flags:  --json   machine-readable output  |  --direct  |  --no-color  |  -h/--help
 */
import { parseArgs } from "node:util";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { claudeRouteFromEnv, loadClaudeCreds, routeAuth, type ClaudeRoute } from "./lib/creds.ts";
import { appendHistory } from "./lib/history.ts";
import { jsonlRecursive } from "./lib/walk.ts";
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
} from "./lib/format.ts";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
// The endpoint hard-429s (or 401s) without a claude-code User-Agent. The exact
// version isn't significant — only the shape — so a constant avoids spawning
// `claude --version` on every run. Bump if Anthropic ever tightens this.
const CLAUDE_UA = "claude-code/2.1.201";
// Model for the gateway quota probe: the cheapest one every Claude account
// serves. The reply is one token and is thrown away.
const PROBE_MODEL = process.env.CCMETER_PROBE_MODEL || "claude-haiku-4-5-20251001";
const PROBE_TIMEOUT_MS = 15_000;
// Not "run --direct": that meters the Keychain login, which may not be the
// account this session spends.
const DIRECT_HINT = "--direct meters the claude.ai login instead, which may be a different account";

interface UsageWindow {
  pct: number;
  resetsAt: string | number | null;
}

interface ClaudeUsage {
  ok: boolean;
  error?: string;
  plan?: string;
  // Present when the numbers came from ANTHROPIC_* rather than the Keychain login.
  route?: { baseUrl: string; auth: string };
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  // Per-model / per-surface caps (e.g. Fable) that draw down a parent window
  // rather than a bucket of their own — `group` names the parent, and the
  // entry's `resets_at` is null because it resets with it. The `limits[]`
  // array is the source of truth `/usage` renders from; the legacy top-level
  // fields don't expose these.
  scoped?: { label: string; group: string; window: UsageWindow }[];
  // used/limit/currency come only from the usage endpoint; a gateway probe's
  // headers carry the utilization alone.
  credits?: { pct: number; used?: number; limit?: number; currency?: string };
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

/**
 * Meter the route Claude Code in this environment actually uses. With no
 * ANTHROPIC_* overrides (or with --direct) that's the Keychain login. Otherwise
 * it's whatever the env names, which is the account an agent in a gateway-routed
 * session is spending, not necessarily the one `claude login` holds.
 */
async function getClaudeUsage(direct: boolean): Promise<ClaudeUsage> {
  const route = direct ? null : claudeRouteFromEnv();
  if (route && "error" in route) return { ok: false, error: route.error };

  if (route && !route.isDefaultBase) {
    let loginToken: string | undefined;
    if (!route.authToken && !route.apiKey && !route.oauthToken) {
      // A gateway in front of the login: Claude Code forwards the OAuth token.
      const creds = await loadClaudeCreds();
      if (!creds) return { ok: false, error: "not logged in — run: claude login" };
      loginToken = creds.token;
    }
    return getGatewayUsage(route, loginToken);
  }
  // Anthropic only takes a Bearer credential that is an OAuth token, so one
  // in ANTHROPIC_AUTH_TOKEN is a subscription just as CLAUDE_CODE_OAUTH_TOKEN is.
  const oauthToken = route?.authToken ?? route?.oauthToken;
  if (route && oauthToken)
    // A `claude setup-token` token is inference-only, and the usage endpoint
    // wants the user:profile scope on top. The probe needs only inference.
    return getOAuthUsage(oauthToken, undefined, route, () => getGatewayUsage(route));
  if (route)
    // An API key straight to Anthropic: pay-as-you-go, there are no windows.
    return {
      ok: false,
      error: `ANTHROPIC_API_KEY is set: API billing, no subscription windows (${DIRECT_HINT})`,
      route: { baseUrl: route.baseUrl, auth: routeAuth(route) },
    };

  const creds = await loadClaudeCreds();
  if (!creds) return { ok: false, error: "not logged in — run: claude login" };
  return getOAuthUsage(creds.token, creds.subscriptionType);
}

async function getOAuthUsage(
  token: string,
  plan: string | undefined,
  route?: ClaudeRoute,
  onUnauthorized?: () => Promise<ClaudeUsage>,
): Promise<ClaudeUsage> {
  let res: Response;
  try {
    res = await fetch(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": CLAUDE_UA,
        "Content-Type": "application/json",
      },
    });
  } catch (e) {
    return { ok: false, error: `request failed: ${(e as Error).message}`, plan: plan };
  }

  if (onUnauthorized && (res.status === 401 || res.status === 403)) return onUnauthorized();
  if (res.status === 401)
    return { ok: false, error: "token expired — run: claude login", plan: plan };
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, plan: plan };

  const d = (await res.json()) as any;
  const out: ClaudeUsage = { ok: true, plan: plan };
  if (route) out.route = { baseUrl: route.baseUrl, auth: routeAuth(route) };
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

// ------------------------------------------------------------ Claude (gateway)

// The unified windows, keyed by the name they carry in response headers. This is
// the table Claude Code parses the same headers with; 7d_oi is the one its UI
// calls the Fable limit, which draws from the weekly window.
const UNIFIED_WINDOWS = ["5h", "7d", "7d_oi", "overage"] as const;

function unifiedWindow(h: Headers, key: string): UsageWindow | undefined {
  const num = (v: string | null) => (v === null || v === "" ? undefined : Number(v));
  const util = num(h.get(`anthropic-ratelimit-unified-${key}-utilization`));
  if (util === undefined || !Number.isFinite(util)) return undefined;
  const reset = num(h.get(`anthropic-ratelimit-unified-${key}-reset`)); // epoch s
  return {
    pct: util * 100, // a 0-1 fraction here, a percent from /usage; display rounds
    resetsAt: reset !== undefined && Number.isFinite(reset) ? reset * 1000 : null,
  };
}

/**
 * Behind a gateway there's no usage endpoint to read (the proxy answers
 * /v1/messages, not /api/oauth/usage), and Claude Code itself stops tracking
 * limits once auth is a third-party token. What does still flow is the
 * subscription's own accounting: Anthropic attaches anthropic-ratelimit-unified-*
 * headers to every subscription response, 429s included. So send the probe
 * Claude Code sends for its quota check (a one-token "quota" message) through
 * the same route and read the headers off the reply.
 *
 * That meters whichever account the gateway picks for the probe. A gateway that
 * pins one account per session could pick a different one for this request than
 * for the agent asking. Headers only arrive if the gateway forwards upstream
 * response headers at all.
 */
async function getGatewayUsage(route: ClaudeRoute, loginToken?: string): Promise<ClaudeUsage> {
  const routeInfo = { baseUrl: route.baseUrl, auth: routeAuth(route) };
  const host = new URL(route.baseUrl).host;
  const auth: Record<string, string> = {};
  if (route.authToken) auth.Authorization = `Bearer ${route.authToken}`;
  if (route.apiKey) auth["x-api-key"] = route.apiKey;
  if (!route.authToken && !route.apiKey) {
    auth.Authorization = `Bearer ${route.oauthToken ?? loginToken}`;
    auth["anthropic-beta"] = "oauth-2025-04-20";
  }

  let res: Response;
  try {
    res = await fetch(`${route.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        ...auth,
        "anthropic-version": "2023-06-01",
        "User-Agent": CLAUDE_UA,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: PROBE_MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "quota" }],
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, error: `${host}: request failed: ${(e as Error).message}`, route: routeInfo };
  }
  const h = res.headers;
  const [fiveHour, weekly, fable, overage] = UNIFIED_WINDOWS.map((k) => unifiedWindow(h, k));
  if (!fiveHour && !weekly) {
    // Written to be pasted into an agent as-is: what was sent, what came back,
    // and the causes that fit it. A refusal's body says why (unknown model, bad
    // key), so keep the start of it; the fetch timeout still bounds the read.
    let body = "";
    if (!res.ok) body = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 300);
    else res.body?.cancel().catch(() => {});
    const why = res.ok
      ? `POST /v1/messages (model ${PROBE_MODEL}) returned HTTP ${res.status} without anthropic-ratelimit-unified-* headers. ` +
        "Either the gateway strips upstream response headers, or it isn't serving this model from a Claude subscription"
      : `POST /v1/messages (model ${PROBE_MODEL}) returned HTTP ${res.status} without anthropic-ratelimit-unified-* headers` +
        (body ? `: ${body}` : "");
    return { ok: false, error: `${host}: ${why} (${DIRECT_HINT})`, route: routeInfo };
  }
  // The headers are all we came for; a body that errors on the way out is no reason to lose them.
  res.body?.cancel().catch(() => {});

  const out: ClaudeUsage = { ok: true, fiveHour, weekly, route: routeInfo };
  if (fable) out.scoped = [{ label: "Fable", group: "weekly", window: { ...fable, resetsAt: null } }];
  if (overage && !h.get("anthropic-ratelimit-unified-overage-disabled-reason"))
    out.credits = { pct: overage.pct };
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
  for (const p of await jsonlRecursive(base)) {
    try {
      files.push({ path: p, mtime: statSync(p).mtimeMs });
    } catch {
      // deleted mid-scan
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  // The newest snapshot, by the snapshot's own timestamp. File mtime only
  // bounds the search: rollouts get touched long after their last turn (a
  // resumed session, the tab-title archiver moving its neighbours out), and
  // trusting mtime once showed a two-day-old reading as "snapshot just now".
  // A snapshot can't be newer than the file holding it, so once the files
  // left are older than the best snapshot found, none of them can beat it.
  let best: { rl: any; at: number } | null = null;
  for (const { path, mtime } of files.slice(0, 200)) {
    if (best && mtime < best.at) break;
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.includes('"rate_limits"')) continue;
      try {
        const rec = JSON.parse(line);
        const rl = findRateLimits(rec);
        // Model-scoped limits (limit_id "codex_bengalfox", the Spark cap) ride
        // in the same field; only the account-wide one is the plan's budget.
        if (!rl || (rl.limit_id && rl.limit_id !== "codex")) continue;
        const at = Date.parse(rec.timestamp);
        if (Number.isFinite(at) && (!best || at > best.at)) best = { rl, at };
      } catch {
        // partial / non-JSON line
      }
    }
  }
  if (best) {
    const last = best.rl;
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

    return { ok: true, plan: last.plan_type, capturedAt: best.at, fiveHour, weekly };
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

const isAnthropic = (baseUrl: string) => new URL(baseUrl).host === "api.anthropic.com";

function providerHeader(style: Style, name: string, plan: string | undefined, right: string): string {
  const tag = plan ? ` ${style.cyan(plan)}` : "";
  const suffix = right ? `  ${style.dim(`· ${right}`)}` : "";
  return `${style.bold(name)}${tag}${suffix}`;
}

function renderClaude(style: Style, u: ClaudeUsage): string[] {
  if (!u.ok)
    return [providerHeader(style, "Claude", u.plan, ""), `  ${style.red(u.error ?? "unavailable")}`];
  const lines = [providerHeader(style, "Claude", u.plan, u.route && !isAnthropic(u.route.baseUrl) ? `via ${new URL(u.route.baseUrl).host}` : "live")];
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
        u.credits.used !== undefined && u.credits.limit !== undefined
          ? `${money(u.credits.used, u.credits.currency ?? "USD")} / ${money(u.credits.limit, u.credits.currency ?? "USD")}`
          : undefined,
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

usage: ccmeter [--json] [--direct] [--no-color]

  --json       machine-readable JSON (for scripts / pre-flight quota checks)
  --direct     meter your claude.ai login, ignoring ANTHROPIC_* overrides
  --no-color   disable ANSI color
  -h, --help   show this help

Claude numbers are a live read of the OAuth usage endpoint. When
ANTHROPIC_BASE_URL routes Claude Code through a gateway, they come from
the rate-limit headers on a one-token probe sent through that gateway
(CCMETER_PROBE_MODEL picks the model).

Each run appends its readings to ~/.local/state/ccmeter/history.jsonl
(CCMETER_HISTORY moves it, CCMETER_NO_HISTORY=1 turns it off); ccburn
reads it to show how the windows moved.
Codex numbers are the latest snapshot from ~/.codex rollout logs
(as fresh as your last Codex turn).`;

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      json: { type: "boolean", default: false },
      direct: { type: "boolean", default: false },
      "no-color": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const [claude, codex] = await Promise.all([getClaudeUsage(values.direct), getCodexUsage()]);
  await appendHistory({
    at: Date.now(),
    claude: claude.ok
      ? { route: claude.route, plan: claude.plan, fiveHour: claude.fiveHour, weekly: claude.weekly, scoped: claude.scoped }
      : undefined,
    codex: codex.ok ? { capturedAt: codex.capturedAt, fiveHour: codex.fiveHour, weekly: codex.weekly } : undefined,
  });

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
