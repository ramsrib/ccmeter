// lib/creds.ts — locate local AI-tool credentials. Shared across dotfiles CLI
// tools so the "where does the token live" logic is written once.
//
//   Claude Code : macOS Keychain ("Claude Code-credentials"), else
//                 ~/.claude/.credentials.json  (Linux keeps it in the file).
//   Codex       : ~/.codex/auth.json           (access token + JWT id_token).

import { $ } from "bun";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_CREDS_FILE = join(homedir(), ".claude", ".credentials.json");
const CODEX_AUTH_FILE = join(homedir(), ".codex", "auth.json");

export interface ClaudeCreds {
  token: string;
  expiresAt?: number; // epoch ms
  subscriptionType?: string;
  source: "keychain" | "file";
}

/**
 * The Claude Code OAuth access token. Prefers the Keychain (the CLI refreshes
 * it in place there, so it's the freshest copy) and falls back to the on-disk
 * credentials file. Returns null if neither yields a token.
 */
/**
 * Every generic-password item whose service is the Claude Code credentials
 * service or a suffixed variant of it ("Claude Code-credentials-3f232086").
 *
 * The service name alone does NOT identify the live entry: Claude Code leaves
 * token-less stubs behind (an `acct=unknown` item, and one per service variant)
 * whose `accessToken` is the empty string. `find-generic-password -s <svc>`
 * returns only the *first* match, so looking up by service can hand back a stub
 * and make a perfectly good login look like a logged-out one. Enumerate instead,
 * then fetch each candidate by (service, account) and keep the ones with tokens.
 */
async function claudeKeychainItems(): Promise<{ service: string; account: string }[]> {
  const res = await $`security dump-keychain`.quiet().nothrow();
  if (res.exitCode !== 0) return [];

  const items: { service: string; account: string }[] = [];
  // dump-keychain prints one attribute block per item, each starting with `keychain: "…"`.
  for (const block of res.stdout.toString().split(/^keychain: /m)) {
    const service = block.match(/"svce"<blob>="([^"]*)"/)?.[1];
    if (!service?.startsWith(CLAUDE_KEYCHAIN_SERVICE)) continue;
    items.push({ service, account: block.match(/"acct"<blob>="([^"]*)"/)?.[1] ?? "" });
  }
  return items;
}

export async function loadClaudeCreds(): Promise<ClaudeCreds | null> {
  // 1. macOS Keychain — freshest. `security` is absent on Linux → falls through.
  try {
    const items = await claudeKeychainItems();
    // No enumeration (non-macOS, or dump-keychain refused)? Still try the plain
    // service lookup, which is correct whenever there's only one item.
    if (items.length === 0) items.push({ service: CLAUDE_KEYCHAIN_SERVICE, account: "" });

    const found: ClaudeCreds[] = [];
    for (const { service, account } of items) {
      const res = account
        ? await $`security find-generic-password -s ${service} -a ${account} -w`.quiet().nothrow()
        : await $`security find-generic-password -s ${service} -w`.quiet().nothrow();
      if (res.exitCode !== 0) continue;
      try {
        const oauth = JSON.parse(res.stdout.toString()).claudeAiOauth;
        if (!oauth?.accessToken) continue; // stub entry — empty token
        found.push({
          token: oauth.accessToken,
          expiresAt: oauth.expiresAt,
          subscriptionType: oauth.subscriptionType,
          source: "keychain",
        });
      } catch {
        // malformed item — ignore, another may be good.
      }
    }

    // Several real tokens shouldn't happen, but if it does the freshest wins.
    if (found.length > 0) {
      return found.sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0))[0]!;
    }
  } catch {
    // no `security` binary / malformed entry — try the file.
  }

  // 2. ~/.claude/.credentials.json (the canonical store on Linux).
  try {
    const f = Bun.file(CLAUDE_CREDS_FILE);
    if (await f.exists()) {
      const oauth = (await f.json()).claudeAiOauth;
      if (oauth?.accessToken) {
        return {
          token: oauth.accessToken,
          expiresAt: oauth.expiresAt,
          subscriptionType: oauth.subscriptionType,
          source: "file",
        };
      }
    }
  } catch {
    // unreadable / malformed
  }

  return null;
}

export interface CodexCreds {
  accessToken: string;
  accountId?: string;
  planType?: string;
}

/** Decode a JWT payload (no verification — we only read our own claims). */
function decodeJwt(token: string): any {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Codex credentials from ~/.codex/auth.json, enriched with account id and plan
 * type pulled from the id_token's OpenAI auth claim. Null if not logged in.
 */
export async function loadCodexCreds(): Promise<CodexCreds | null> {
  try {
    const f = Bun.file(CODEX_AUTH_FILE);
    if (!(await f.exists())) return null;
    const auth = await f.json();
    const accessToken = auth?.tokens?.access_token;
    if (!accessToken) return null;
    const claims = auth?.tokens?.id_token ? decodeJwt(auth.tokens.id_token) : null;
    const oa = claims?.["https://api.openai.com/auth"];
    return {
      accessToken,
      accountId: oa?.chatgpt_account_id,
      planType: oa?.chatgpt_plan_type,
    };
  } catch {
    return null;
  }
}
