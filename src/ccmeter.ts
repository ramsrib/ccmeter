#!/usr/bin/env bun
/**
 * ccmeter — at-a-glance subscription usage for Claude (Code), Codex and Gemini.
 *
 *   Claude : live, authoritative read of the undocumented OAuth usage endpoint
 *            (GET api.anthropic.com/api/oauth/usage) using the Claude Code
 *            OAuth token from the Keychain / ~/.claude. Shows 5h + weekly
 *            utilization and, when enabled, extra-usage credit spend.
 *            When ANTHROPIC_BASE_URL routes Claude Code through a gateway, it
 *            meters that route instead (see getGatewayUsage).
 *   Codex  : live, account/rateLimits/read (the numbers the TUI `/status`
 *            shows, fetched from OpenAI now): from the managed app-server daemon
 *            when one is running (its socket, no process to start), else from a
 *            short-lived `codex app-server`. When both fail (codex missing or too
 *            old, logged out, offline), the most recent rate-limit snapshot
 *            Codex persisted to its rollout logs (~/.codex/sessions/**.jsonl),
 *            which is only as fresh as the last Codex turn on this machine.
 *   Gemini : live, from the endpoint the Antigravity CLI (agy) reads its own
 *            quota from (POST daily-cloudcode-pa.googleapis.com/v1internal:
 *            retrieveUserQuotaSummary) with agy's token from the Keychain or
 *            token file. When that can't be used (token absent or about to
 *            expire, a refused call), agy runs `agy -p /usage` in print mode,
 *            with no agent turn or quota spent. agy takes ~3 s to start, so
 *            that path shows the last reading at once and refreshes it in the
 *            background (see getGemini), also renewing agy's token.
 *            agy starts a browser sign-in when it can't read its login, so it
 *            runs behind a guard that stops it instead. Left out entirely where
 *            neither agy nor its token exists.
 *
 * Flags:  --claude | --codex | --gemini  |  --json  |  --check  |  --direct  |  --no-color  |  -h/--help
 */
import { VERSION } from "./lib/version.ts";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claudeRouteFromEnv, loadAgyToken, loadClaudeCreds, routeAuth, type ClaudeRoute } from "./lib/creds.ts";
import { appendHistory } from "./lib/history.ts";
import { jsonlRecursive, readJsonl } from "./lib/walk.ts";
import {
  bar,
  codexPlanLabel,
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
  capturedAt?: number; // epoch ms of the snapshot (or of the live read)
  live?: boolean; // read from OpenAI just now, not a rollout-log snapshot
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
}

interface GeminiGroup {
  name: string; // "Gemini Models", "Claude and GPT models": each has its own pair of windows
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
}

interface GeminiUsage {
  ok: boolean;
  absent?: boolean; // agy not installed: not an error, the section is left out
  error?: string;
  groups?: GeminiGroup[];
  capturedAt?: number; // epoch ms of the read
  live?: boolean; // read during this run, not the cached reading
  via?: "api" | "agy"; // the quota endpoint directly, or agy -p /usage
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
  // CLAUDE_CODE_OAUTH_TOKEN is a `claude setup-token` token: inference-only, while
  // the usage endpoint wants user:profile on top. Asking anyway is refused (403),
  // and a token that keeps getting refused is throttled there with growing backoff
  // (429, retry-after 80s, then 3600s; seen on a remote host 2026-10-20), which
  // also ends the fallback. So go straight to the probe, which needs only inference.
  if (route?.oauthToken && !route.authToken) return getGatewayUsage(route);
  // Anthropic only takes a Bearer credential that is an OAuth token, so one in
  // ANTHROPIC_AUTH_TOKEN is a subscription too, possibly with the full scope.
  const oauthToken = route?.authToken;
  if (route && oauthToken)
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

// ------------------------------------------------------------------ Codex (live)

// Generous for a cold start; a warm `codex app-server` answers in under a second.
const CODEX_LIVE_TIMEOUT_MS = 10_000;

/** Sort Codex windows into 5h / weekly by their own duration (see the snapshot reader). */
function bucketCodexWindows(windows: ({ mins: number; window: UsageWindow } | null)[]) {
  let fiveHour: UsageWindow | undefined;
  let weekly: UsageWindow | undefined;
  for (const w of windows) {
    if (!w) continue;
    if (w.mins <= 24 * 60) fiveHour = w.window;
    else weekly = w.window;
  }
  return { fiveHour, weekly };
}

/**
 * The account/rateLimits/read result as usage, or null when it is off-shape (the
 * caller then falls back rather than showing a wrong number as live).
 */
function codexRateLimits(result: any): CodexUsage | null {
  // The account-wide budget is limit id "codex"; model-scoped caps ride alongside,
  // and the top-level rateLimits counts only when it is that same budget.
  let rl = result?.rateLimitsByLimitId?.codex;
  const top = result?.rateLimits;
  if (!rl && top && (top.limitId == null || top.limitId === "codex")) rl = top;
  const valid = (w: any) =>
    w == null || (typeof w === "object" && typeof w.usedPercent === "number" && typeof w.windowDurationMins === "number");
  if (!rl || typeof rl !== "object" || !valid(rl.primary) || !valid(rl.secondary) || (!rl.primary && !rl.secondary))
    return null;
  const win = (w: any) =>
    w
      ? {
          mins: w.windowDurationMins,
          window: { pct: w.usedPercent, resetsAt: typeof w.resetsAt === "number" ? w.resetsAt * 1000 : null },
        }
      : null;
  const { fiveHour, weekly } = bucketCodexWindows([win(rl.primary), win(rl.secondary)]);
  return { ok: true, live: true, plan: rl.planType ?? undefined, capturedAt: Date.now(), fiveHour, weekly };
}

const CODEX_DAEMON_SOCKET = join(homedir(), ".codex", "app-server-control", "app-server-control.sock");
// A running daemon answers initialize in ~1 ms; the read itself is OpenAI's round trip.
const CODEX_DAEMON_TIMEOUT_MS = 5_000;

/**
 * Ask the managed app-server daemon (`codex app-server daemon start|bootstrap`),
 * when one is running: the same JSON-RPC as a spawned app-server, carried in
 * WebSocket text frames over its unix socket (an HTTP/1.1 upgrade on GET /).
 * Saves starting a process per run. A minimal client, enough for two requests:
 * masked text frames out; unmasked, unfragmented text frames in, others ignored.
 * Resolves null on anything unexpected so the caller can spawn one instead.
 */
function getCodexDaemon(): Promise<CodexUsage | null> {
  return new Promise((resolve) => {
    if (!existsSync(CODEX_DAEMON_SOCKET)) return resolve(null);
    let settled = false;
    let upgraded = false;
    let buf = Buffer.alloc(0);
    const sock = createConnection({ path: CODEX_DAEMON_SOCKET });
    const finish = (u: CodexUsage | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(u);
    };
    const timer = setTimeout(() => finish(null), CODEX_DAEMON_TIMEOUT_MS);
    sock.on("error", () => finish(null));
    sock.on("close", () => finish(null));
    const send = (m: object) => {
      const data = Buffer.from(JSON.stringify(m));
      let head: Buffer;
      if (data.length < 126) head = Buffer.from([0x81, 0x80 | data.length]);
      else if (data.length < 65536) {
        head = Buffer.alloc(4);
        head[0] = 0x81;
        head[1] = 0x80 | 126;
        head.writeUInt16BE(data.length, 2);
      } else return finish(null);
      const mask = randomBytes(4);
      const body = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i++) body[i] = data[i] ^ mask[i % 4];
      sock.write(Buffer.concat([head, mask, body]));
    };
    const onMessage = (m: any) => {
      if (!m || typeof m !== "object") return;
      if (m.id === 1) {
        if (!m.result) return finish(null);
        send({ method: "initialized" });
        send({ id: 2, method: "account/rateLimits/read", params: {} });
      } else if (m.id === 2) {
        finish(codexRateLimits(m.result));
      }
    };
    sock.on("connect", () => {
      sock.write(
        "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        if (!/^HTTP\/1\.1 101 /.test(buf.subarray(0, end).toString("latin1"))) return finish(null);
        upgraded = true;
        buf = buf.subarray(end + 4);
        send({ id: 1, method: "initialize", params: { clientInfo: { name: "ccmeter", version: VERSION } } });
      }
      for (;;) {
        if (buf.length < 2) return;
        const fin = (buf[0] & 0x80) !== 0;
        const op = buf[0] & 0x0f;
        if (buf[1] & 0x80) return finish(null); // a server never masks
        let n = buf[1] & 0x7f;
        let off = 2;
        if (n === 126) {
          if (buf.length < 4) return;
          n = buf.readUInt16BE(2);
          off = 4;
        } else if (n === 127) {
          if (buf.length < 10) return;
          n = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (buf.length < off + n) return;
        const payload = buf.subarray(off, off + n);
        buf = buf.subarray(off + n);
        if (op === 0x8) return finish(null); // close
        if (op !== 0x1) continue; // ping, pong, binary: not ours to answer here
        if (!fin) return finish(null); // fragmented: not worth handling, spawn instead
        try {
          onMessage(JSON.parse(payload.toString("utf8")));
        } catch {
          // a notification we can't parse is not our reply
        }
      }
    });
  });
}

/**
 * Ask Codex itself, live: start `codex app-server` (its JSON-RPC mode for other
 * programs, newline-delimited over stdio), send initialize + account/rateLimits/read,
 * and close it. Nothing has to be running already. Resolves null on any failure,
 * so the caller can fall back to the rollout-log snapshot.
 */
function getCodexLive(): Promise<CodexUsage | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("codex", ["app-server"], { cwd: tmpdir(), stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return resolve(null);
    }
    let settled = false;
    // codex app-server exits on its own when stdin closes, so a killed ccmeter
    // can't strand it; this covers a normal exit while the read is pending.
    const killChild = () => child.kill();
    process.once("exit", killChild);
    const finish = (u: CodexUsage | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener("exit", killChild);
      child.kill();
      resolve(u);
    };
    const timer = setTimeout(() => finish(null), CODEX_LIVE_TIMEOUT_MS);
    child.on("error", () => finish(null)); // codex not installed
    child.on("exit", () => finish(null));
    // A child that dies before reading its input surfaces as EPIPE here, not as a throw.
    child.stdin?.on("error", () => finish(null));
    const send = (m: object) => {
      try {
        child.stdin?.write(JSON.stringify(m) + "\n");
      } catch {
        finish(null);
      }
    };

    let buf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (!m || typeof m !== "object") continue;
        if (m.id === 1) {
          if (!m.result) return finish(null);
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read", params: {} });
        } else if (m.id === 2) {
          // Anything off-shape falls back to the snapshot rather than showing as live.
          finish(codexRateLimits(m.result));
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "ccmeter", version: VERSION } } });
  });
}

async function getCodexUsage(): Promise<CodexUsage> {
  if (process.env.CCMETER_CODEX_DAEMON !== "0") {
    const d = await getCodexDaemon();
    if (d) return d;
  }
  return (await getCodexLive()) ?? getCodexSnapshot();
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

async function getCodexSnapshot(): Promise<CodexUsage> {
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
  for (const { path, mtime } of files) {
    if (best && mtime < best.at) break;
    let text: string;
    try {
      text = await readJsonl(path);
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
    const { fiveHour, weekly } = bucketCodexWindows(
      [last.primary, last.secondary].map((w) => (w ? { mins: w.window_minutes ?? 0, window: win(w)! } : null)),
    );

    return { ok: true, plan: last.plan_type, capturedAt: best.at, fiveHour, weekly };
  }
  return { ok: false, error: "no rate-limit snapshot yet — run codex once" };
}

// ----------------------------------------------------------------- Gemini (live)

// `agy -p /usage` answers from the CLI's own quota read; a cold start is a few seconds.
const GEMINI_TIMEOUT_MS = 20_000;

/**
 * A login guard for agy. Logged out, or with its login unreadable (the Keychain
 * is locked over ssh), `agy -p /usage` starts a Google sign-in: it runs `open`
 * (`xdg-open` on Linux) on an accounts.google.com URL that returns to
 * antigravity.google, which pops a browser tab, and then waits about a minute
 * for a sign-in nobody will do. agy finds the opener through PATH, so stubs
 * placed first catch that one URL, mark the run and stop agy, their parent.
 * Anything else goes on to the real command.
 */
function loginGuard(): { dir: string; marker: string } {
  const dir = mkdtempSync(join(tmpdir(), "ccmeter-agy-"));
  const marker = join(dir, "login-required");
  for (const opener of ["open", "xdg-open"]) {
    const stub = join(dir, opener);
    writeFileSync(
      stub,
      `#!/bin/sh
case "$*" in
  *accounts.google.com*antigravity*) : > ${JSON.stringify(marker)}; kill "$PPID" 2>/dev/null; exit 0 ;;
esac
PATH=\${PATH#${JSON.stringify(dir)}:}
exec "$(basename "$0")" "$@"
`,
    );
    chmodSync(stub, 0o755);
  }
  return { dir, marker };
}

/**
 * One quota bucket as a used-percent window. agy's /usage JSON spells it
 * {window, remaining_fraction, reset_time}; the endpoint {window,
 * remainingFraction, resetTime}.
 */
function geminiWindow(b: any): UsageWindow | undefined {
  const remaining = b?.remaining_fraction ?? b?.remainingFraction;
  if (typeof remaining !== "number") return undefined;
  const r = b.reset_time ?? b.resetTime;
  const reset = typeof r === "string" ? Date.parse(r) : NaN;
  // An untouched bucket has no reset: agy reports the epoch, the endpoint omits it.
  return { pct: Math.max(0, (1 - remaining) * 100), resetsAt: Number.isFinite(reset) && reset > 0 ? reset : null };
}

/** Quota groups (each a 5h and a weekly bucket) from either source. */
function geminiGroups(raw: unknown): GeminiGroup[] {
  const groups: GeminiGroup[] = [];
  for (const g of Array.isArray(raw) ? raw : []) {
    const buckets = Array.isArray(g?.buckets) ? g.buckets : [];
    const by = (w: string) => geminiWindow(buckets.find((b: any) => b?.window === w));
    const group = { name: String(g?.name ?? g?.displayName ?? "?"), fiveHour: by("5h"), weekly: by("weekly") };
    if (group.fiveHour || group.weekly) groups.push(group);
  }
  return groups;
}

const GEMINI_QUOTA_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
// The endpoint serves a consumer (Google AI plan) login's quota only to a caller
// whose User-Agent starts with agy's product token; anything else is treated as
// an enterprise client and refused (403 SUBSCRIPTION_REQUIRED). The version and
// the comment aren't checked (tested 2026-11-24: antigravity/cli/0.0.1 works,
// "ccmeter (auth_method=consumer)" doesn't), so this names ccmeter in the comment.
const GEMINI_UA = "antigravity/cli/1.5.16 (ccmeter; auth_method=consumer)";
const GEMINI_DIRECT_TIMEOUT_MS = 8_000;
// agy refreshes its access token about hourly; one this close to expiry is left to it.
const GEMINI_TOKEN_SLACK_MS = 60_000;

/** The direct read, or null for the caller to fall back to agy. */
async function getGeminiDirect(): Promise<GeminiUsage | null> {
  if (process.env.CCMETER_GEMINI_DIRECT === "0") return null; // force the agy path (tests)
  const t = await loadAgyToken();
  if (!t || (t.expiresAt !== undefined && t.expiresAt - Date.now() < GEMINI_TOKEN_SLACK_MS)) return null;
  try {
    const r = await fetch(GEMINI_QUOTA_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${t.accessToken}`, "Content-Type": "application/json", "User-Agent": GEMINI_UA },
      body: "{}",
      signal: AbortSignal.timeout(GEMINI_DIRECT_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    const groups = geminiGroups(((await r.json()) as any)?.groups);
    return groups.length ? { ok: true, groups, capturedAt: Date.now(), via: "api" } : null;
  } catch {
    return null;
  }
}

function getGeminiUsage(): Promise<GeminiUsage> {
  return new Promise((resolve) => {
    const guard = loginGuard();
    let out = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const finish = (u: GeminiUsage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.kill();
      if (existsSync(guard.marker)) u = { ok: false, error: "agy is not logged in (or can't read its login here): run agy once to sign in" };
      rmSync(guard.dir, { recursive: true, force: true });
      resolve(u);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "agy did not answer /usage in time" }), GEMINI_TIMEOUT_MS);
    try {
      child = spawn("agy", ["--output-format", "json", "-p=/usage"], {
        cwd: tmpdir(),
        env: { ...process.env, PATH: `${guard.dir}:${process.env.PATH ?? ""}` },
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return finish({ ok: false, absent: true });
    }
    child.on("error", (e: NodeJS.ErrnoException) =>
      finish(e.code === "ENOENT" ? { ok: false, absent: true } : { ok: false, error: e.message }),
    );
    child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("exit", () => {
      let d: any;
      try {
        d = JSON.parse(out);
      } catch {
        return finish({ ok: false, error: "agy /usage gave no JSON" });
      }
      if (d?.status !== "SUCCESS")
        return finish({ ok: false, error: `agy /usage: ${String(d?.error || d?.status || "failed").split("\n")[0]}` });
      const groups = geminiGroups(d.command?.data?.groups);
      finish(groups.length ? { ok: true, groups, capturedAt: Date.now(), via: "agy" } : { ok: false, error: "agy /usage listed no quota windows" });
    });
  });
}

// ------------------------------------------------- Gemini (direct, else agy behind a cache)

// Without the direct read, agy needs ~3 s to answer, against well under a second
// for everything else, so a run shows the last reading at once and leaves a
// detached `ccmeter --refresh-gemini` to fetch the next one. A run reads before printing only when
// there is no reading yet or it is too old to stand in for the current numbers.
const GEMINI_FRESH_MS = 60_000; // newer than this: shown as is, no refresh started
const GEMINI_STALE_MS = 30 * 60_000; // older than this: read before printing
const GEMINI_LOCK_MS = 60_000; // one background refresh at a time

function geminiCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const state = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(state, "ccmeter", "gemini.json");
}

function readGeminiCache(): GeminiUsage | null {
  try {
    const u = JSON.parse(readFileSync(geminiCachePath(), "utf8"));
    return u && typeof u === "object" && typeof u.capturedAt === "number" ? (u as GeminiUsage) : null;
  } catch {
    return null;
  }
}

function writeGeminiCache(u: GeminiUsage): void {
  try {
    const path = geminiCachePath();
    mkdirSync(dirname(path), { recursive: true });
    const { live: _live, ...keep } = u;
    writeFileSync(`${path}.tmp`, JSON.stringify(keep));
    renameSync(`${path}.tmp`, path);
  } catch {
    // a meter that can't cache still meters
  }
}

/** Read agy now and keep the result (errors too, so a logged-out agy isn't retried every run). */
async function refreshGemini(): Promise<GeminiUsage> {
  const u = await getGeminiUsage();
  if (u.absent) return u;
  const stamped = { ...u, capturedAt: u.capturedAt ?? Date.now() };
  writeGeminiCache(stamped);
  return stamped;
}

/** Start a detached refresh unless one started within GEMINI_LOCK_MS. */
function refreshGeminiBehind(): void {
  const lock = `${geminiCachePath()}.refresh`;
  try {
    if (Date.now() - statSync(lock).mtimeMs < GEMINI_LOCK_MS) return;
  } catch {
    // no lock: go ahead
  }
  try {
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, String(process.pid));
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "--refresh-gemini"], {
      detached: true,
      stdio: "ignore",
      cwd: tmpdir(),
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // the cached reading still shows
  }
}

async function getGemini(): Promise<GeminiUsage> {
  // Direct first: as fast as the Claude read. The reading is kept, so a later
  // run that has to fall back to agy still has a recent one to show at once.
  const direct = await getGeminiDirect();
  if (direct) {
    writeGeminiCache(direct);
    return { ...direct, live: true };
  }
  const cached = readGeminiCache();
  const age = cached ? Date.now() - cached.capturedAt! : Infinity;
  if (!cached || age >= GEMINI_STALE_MS) return { ...(await refreshGemini()), live: true };
  if (age >= GEMINI_FRESH_MS) refreshGeminiBehind();
  return { ...cached, live: false };
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
    return [providerHeader(style, "Codex", codexPlanLabel(u.plan), ""), `  ${style.red(u.error ?? "unavailable")}`];
  const age = u.live ? "live" : u.capturedAt ? `snapshot ${humanAgo(Date.now() - u.capturedAt)}` : "";
  const lines = [providerHeader(style, "Codex", codexPlanLabel(u.plan), age)];
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

/**
 * The Gemini group first, as "5h" / "weekly". Any other group (Antigravity also
 * serves Claude and GPT models from a separate pool) shows only once it has
 * been used, labelled by its name.
 */
function renderGemini(style: Style, u: GeminiUsage): string[] {
  const age = u.live || !u.capturedAt ? "live" : `read ${humanAgo(Date.now() - u.capturedAt)}`;
  // An error carries an age only when it is a cached reading of one.
  if (!u.ok) return [providerHeader(style, "Gemini", undefined, !u.live && u.capturedAt ? age : ""), `  ${style.red(u.error ?? "unavailable")}`];
  const lines = [providerHeader(style, "Gemini", undefined, age)];
  for (const g of u.groups ?? []) {
    const main = /^gemini/i.test(g.name);
    const used = (g.fiveHour?.pct ?? 0) > 0 || (g.weekly?.pct ?? 0) > 0;
    if (!main && !used) continue;
    if (!main) lines.push(`  ${style.dim(g.name)}`);
    if (g.fiveHour) lines.push(windowRow(style, main ? "5h" : "└ 5h", g.fiveHour));
    if (g.weekly) lines.push(windowRow(style, main ? "weekly" : "└ weekly", g.weekly));
  }
  return lines;
}

const HELP = `ccmeter — subscription usage for Claude, Codex and Gemini

usage: ccmeter [--claude] [--codex] [--gemini] [--json | --check [--at N]]
               [--direct] [--no-color]

  --claude, --codex, --gemini
               only these providers (any combination; default: all). The
               others aren't read, so a run waits on fewer servers

  --json       machine-readable JSON (for scripts / pre-flight quota checks)
  --check      one line and an exit code: 0 every window under --at (default 85),
               2 at least one at or over it (Claude 5h, weekly, scoped caps such as
               Fable; Codex 5h, weekly; Gemini's windows), 3 a provider could not be
               read (Gemini counts only where agy is installed); only the
               picked providers count
  --direct     meter your claude.ai login, ignoring ANTHROPIC_* overrides
  --no-color   disable ANSI color
  -h, --help   show this help
  -V, --version  print the version

Claude numbers are a live read of the OAuth usage endpoint. When
ANTHROPIC_BASE_URL routes Claude Code through a gateway, they come from
the rate-limit headers on a one-token probe sent through that gateway
(CCMETER_PROBE_MODEL picks the model).

Each run appends its readings to ~/.local/state/ccmeter/history.jsonl
(CCMETER_HISTORY moves it, CCMETER_NO_HISTORY=1 turns it off); ccburn
reads it to show how the windows moved.
Codex numbers are a live read of account/rateLimits/read, from the running
app-server daemon's socket when there is one, else from a short-lived
\`codex app-server\`. If that fails, they are the latest snapshot
from ~/.codex rollout logs (as fresh as your last Codex turn).
Gemini numbers are a live read of the quota endpoint the Antigravity CLI
(agy) uses, with agy's token from the Keychain or token file. When that token
is missing or about to expire, or the call is refused, they come from
\`agy -p /usage\` itself (no quota spent), which takes a few seconds: the last
reading shows at once ("read 2m ago") and a background refresh fetches the
next, also renewing agy's token. A run waits only when there is no reading or it is
over 30 minutes old. The section is left out where agy isn't installed. If agy
can't read its login, ccmeter stops its sign-in attempt rather than let it
open a browser, and reports Gemini as unreadable.`;

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      json: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      at: { type: "string", default: "85" },
      direct: { type: "boolean", default: false },
      claude: { type: "boolean", default: false },
      codex: { type: "boolean", default: false },
      gemini: { type: "boolean", default: false },
      "no-color": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "V", default: false },
      "refresh-gemini": { type: "boolean", default: false }, // internal: the background refresh
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values.version) {
    console.log(`ccmeter ${VERSION}`);
    return;
  }
  if (values["refresh-gemini"]) {
    await refreshGemini();
    rmSync(`${geminiCachePath()}.refresh`, { force: true });
    return;
  }

  // --claude / --codex / --gemini pick providers (any combination); none means all.
  // An unpicked provider isn't read at all, so its server isn't waited on.
  const picked = (["claude", "codex", "gemini"] as const).filter((p) => values[p]);
  const want = (p: (typeof picked)[number]) => picked.length === 0 || picked.includes(p);
  const [claude, codex, gemini0] = await Promise.all([
    want("claude") ? getClaudeUsage(values.direct) : null,
    want("codex") ? getCodexUsage() : null,
    want("gemini") ? getGemini() : null,
  ]);
  // Asked for by name, a missing agy is an answer, not a section to leave out.
  const gemini: GeminiUsage | null =
    gemini0?.absent && values.gemini ? { ok: false, error: "agy (the Antigravity CLI) is not installed here" } : gemini0;
  await appendHistory({
    at: Date.now(),
    claude: claude?.ok
      ? {
          route: claude.route,
          plan: claude.plan,
          fiveHour: claude.fiveHour,
          weekly: claude.weekly,
          scoped: claude.scoped,
          credits: claude.credits,
        }
      : undefined,
    codex: codex?.ok ? { capturedAt: codex.capturedAt, fiveHour: codex.fiveHour, weekly: codex.weekly } : undefined,
    gemini: gemini?.ok ? { capturedAt: gemini.capturedAt, groups: gemini.groups } : undefined,
  });
  const anyRead = [claude, codex, gemini].some((u) => u?.ok);

  if (values.check) {
    // Pacing rule: an unreadable meter is treated as tight, never as zero usage.
    const at = Number(values.at);
    if (!Number.isFinite(at)) throw new Error(`--at wants a number, got ${values.at}`);
    const tight: string[] = [];
    const see = (name: string, w?: UsageWindow) => {
      if (w && w.pct >= at) tight.push(`${name} ${Math.floor(w.pct)}%`);
    };
    if (claude?.ok) {
      see("claude 5h", claude.fiveHour);
      see("claude weekly", claude.weekly);
      for (const s of claude.scoped ?? []) see(`claude ${s.label}`, s.window);
    }
    if (codex?.ok) {
      see("codex 5h", codex.fiveHour);
      see("codex weekly", codex.weekly);
    }
    for (const g of gemini?.groups ?? []) {
      const name = /^gemini/i.test(g.name) ? "gemini" : `gemini ${g.name}`;
      see(`${name} 5h`, g.fiveHour);
      see(`${name} weekly`, g.weekly);
    }
    const unreadable = [
      claude && !claude.ok && "claude",
      codex && !codex.ok && "codex",
      gemini && !gemini.ok && !gemini.absent && "gemini",
    ].filter(Boolean);
    if (unreadable.length) {
      console.log(`unreadable: ${unreadable.join(", ")}${tight.length ? `; tight: ${tight.join(", ")}` : ""}`);
      process.exit(3);
    }
    console.log(tight.length ? `tight (>= ${at}%): ${tight.join(", ")}` : `ok (all under ${at}%)`);
    process.exit(tight.length ? 2 : 0);
  }

  if (values.json) {
    const out = {
      ...(claude ? { claude } : {}),
      ...(codex ? { codex } : {}),
      ...(gemini && !gemini.absent ? { gemini } : {}),
      generatedAt: new Date().toISOString(),
    };
    console.log(JSON.stringify(out, null, 2));
    process.exit(anyRead ? 0 : 1);
  }

  const enabled = values["no-color"] ? false : colorEnabled();
  const style = makeStyle(enabled);
  const blocks: string[][] = [];
  if (claude) blocks.push(renderClaude(style, claude));
  if (codex) blocks.push(renderCodex(style, codex));
  if (gemini && !gemini.absent) blocks.push(renderGemini(style, gemini));
  console.log(blocks.map((b) => b.join("\n")).join("\n\n"));
  process.exit(anyRead ? 0 : 1);
}

main().catch((e) => {
  console.error(`ccmeter: ${(e as Error).message}`);
  process.exit(1);
});
