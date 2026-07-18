#!/usr/bin/env bash
# ccmeter installer. Generic + idempotent; bakes in no personal paths.
#
# Both tools are plain TypeScript run by bun via their `#!/usr/bin/env bun`
# shebang — no build step, no node_modules needed at runtime. Installing is
# just "make them executable and put them on $PATH", which is all this does.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
TOOLS=(ccmeter ctxmeter)

if command -v bun >/dev/null 2>&1; then
  echo "  ✓ bun $(bun --version) (preferred runtime)"
elif command -v node >/dev/null 2>&1; then
  echo "  ✓ node $(node --version) — bun not found, will use node"
else
  echo "  ! neither bun nor node on PATH — nothing will run" >&2
fi

mkdir -p "$BIN_DIR"
for name in "${TOOLS[@]}"; do
  src="$REPO_DIR/bin/$name"
  chmod +x "$src"
  ln -sf "$src" "$BIN_DIR/$name"
  echo "  ↻ linked $BIN_DIR/$name -> $src"
done

# Dev types only (lint + editor intellisense). Never needed to run.
if command -v bun >/dev/null 2>&1; then
  if (cd "$REPO_DIR" && bun install --silent) >/dev/null 2>&1; then
    echo "  ✓ dev dependencies installed (types for lint/editor)"
  else
    echo "  ! bun install skipped/failed — fine, not needed at runtime"
  fi
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "  ! $BIN_DIR is not on \$PATH — add it to your shell rc" >&2 ;;
esac

echo "Try: ccmeter      (subscription usage)"
echo "     ctxmeter     (context-window usage for this session)"
