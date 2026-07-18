# ccmeter

Two small meters for people who live in **Claude Code** and **Codex**:

- **`ccmeter`** — how much of your *subscription* is left (5h window, weekly, credit spend).
- **`ctxmeter`** — how full the *current session's context window* is, and thus how close
  it is to an auto-compact.

Different budgets, same question: *do I have room to start this?*

**`ccmeter`** — what's left of the subscription, per window:

```
$ ccmeter
Claude max  · live
  5h         13%  █░░░░░░░░░  resets in 1h 27m · 12:50 PM
  weekly     47%  █████░░░░░  resets in 3d 2h · 02:00 PM
  └ Fable    71%  ███████░░░  resets in 3d 2h · 02:00 PM · draws from weekly

Codex pro  · snapshot 4m ago
  weekly      9%  █░░░░░░░░░  resets in 6d 9h · 08:25 PM
```

**`ctxmeter`** — how full this session's context window is:

```
$ ctxmeter
  9b6977e9 dotfiles          23%  ██░░░░░░░░  232k / 1000k · just now
```

## Install

```sh
brew install ramsrib/tap/ccmeter
```

Or from source:

```sh
git clone https://github.com/ramsrib/ccmeter.git
cd ccmeter && ./setup.sh          # symlinks both tools into ~/.local/bin
```

Set `BIN_DIR=/somewhere/else ./setup.sh` to link them elsewhere.

Runs on **node ≥ 22.18** or **[bun](https://bun.sh)**, preferring bun when both
are present (13ms startup vs 39ms). There is no build step and no dependencies —
the tools are TypeScript executed directly, by bun natively or by node's type
stripping. That means the source must stay erasable-only: no `enum`, no
`namespace`, no constructor parameter properties, or node will refuse to run it.

## ccmeter — subscription usage

```sh
ccmeter              # colored summary
ccmeter --json       # machine-readable (scripts, pre-flight quota checks)
ccmeter --no-color
```

- **Claude** — a live, authoritative read of the undocumented OAuth usage
  endpoint (`GET api.anthropic.com/api/oauth/usage`) using the Claude Code token
  from the macOS Keychain (falling back to `~/.claude/.credentials.json`). Shows
  the 5h and weekly utilization plus extra-usage credit spend when enabled.
- **Codex** — has no queryable usage API, so ccmeter reads the most recent
  rate-limit snapshot Codex writes to its rollout logs
  (`~/.codex/sessions/**.jsonl`) — the same numbers the TUI `/status` shows.
  Free (no API call), but only as fresh as your last Codex turn.

Exit status is non-zero only if *both* providers fail, which makes it safe to
use as a gate in scripts.

## ctxmeter — context-window usage

```sh
ctxmeter                  # this session:  42%  ████░░░░░░  420k / 1000k
ctxmeter --all            # every session active in the last 24h
ctxmeter --all --since 1  # ...in the last hour (the live agents)
ctxmeter --session ID     # one specific session
ctxmeter --threshold 80   # exit 1 at/above 80% — for hooks and guards
ctxmeter --json
```

**Which session?** Inside a session it reads `$CLAUDE_CODE_SESSION_ID`; a hook
passes `--transcript`. Both are exact. From a plain terminal neither exists, so
it falls back to the newest transcript for the current directory (walking up to
the repo root) — and *labels the row with the session it picked*, because with
several agents running that fallback is a guess. `--all` is the honest view:

```
  9b6977e9 dotfiles          23%  ██░░░░░░░░  232k / 1000k · just now
  70c8a3b7 runtime           77%  ████████░░  773k / 1000k · 3h ago
  188 session(s) idle >24h omitted (--since N)
```

Claude Code exposes no API for this, so `ctxmeter` reads the session transcript
and takes the newest main-thread assistant message's `usage` block:

    used = input_tokens + cache_creation_input_tokens + cache_read_input_tokens

Input-only, matching the `context_window.used_percentage` that Claude Code's own
statusLine reports, so `ctxmeter` agrees with `/context`. Reading the *newest*
message rather than the largest is what makes it survive compaction — after a
compact the prompt shrinks and `cache_read` drops with it.

The window size appears nowhere in the transcript (a 1M session logs its model
as plain `claude-opus-4-8`), so it is inferred from the configured model's
`[1m]` suffix and self-corrects when observed usage exceeds it. Override with
`--limit` or `CTXMETER_LIMIT`.

Exit status: `0` normal, `1` at/above `--threshold`, `2` usage indeterminate —
so a guard that cannot read usage fails closed rather than reading as idle.

## Layout

```
bin/ccmeter        sh shim: exec bun (preferred) or node against src/
bin/ctxmeter
src/
  lib/creds.ts     locate Claude / Codex credentials (keychain, ~/.claude, ~/.codex)
  lib/format.ts    color, utilization bars, percent / reset-time / money formatting
  lib/walk.ts      recursive *.jsonl search (no bun Glob, so node works too)
  ccmeter.ts       subscription usage
  ctxmeter.ts      context-window usage
setup.sh           symlinks both shims into $BIN_DIR (default ~/.local/bin)
```

## Caveats

Both tools read undocumented surfaces — an unversioned OAuth endpoint, and
on-disk transcript/rollout formats. Anthropic and OpenAI can change either
without notice, and a change will show up here as wrong numbers or a clean
failure, not a deprecation warning. Treat the output as a good estimate, not a
billing record.

## License

MIT
