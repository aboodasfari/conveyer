#!/usr/bin/env bash
# Stage @github/copilot, its platform-specific sibling, and @github/copilot-sdk
# into src-tauri/resources/copilot-bundle/node_modules so Tauri can bundle them
# into <app>.app/Contents/Resources/node_modules. Prunes wrong-platform native
# binaries from the @github/copilot tree to keep the .app size sane.
#
# Usage: ./scripts/stage-copilot.sh <rust-target-triple>
#   e.g. ./scripts/stage-copilot.sh aarch64-apple-darwin
#        ./scripts/stage-copilot.sh x86_64-apple-darwin
#        ./scripts/stage-copilot.sh x86_64-unknown-linux-gnu
#        ./scripts/stage-copilot.sh x86_64-pc-windows-msvc

set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  # Fall back to the host triple from `rustc -vV` so local builds without
  # `--target` just work.
  TARGET="$(rustc -vV 2>/dev/null | awk '/^host:/{print $2}')"
fi
if [ -z "$TARGET" ]; then
  echo "Usage: $0 <rust-target-triple>" >&2
  exit 1
fi

# Map rust target -> copilot platform + arch.
case "$TARGET" in
  aarch64-apple-darwin)         PLATFORM="darwin-arm64";  ARCH="arm64" ;;
  x86_64-apple-darwin)          PLATFORM="darwin-x64";    ARCH="x64"   ;;
  aarch64-unknown-linux-gnu)    PLATFORM="linux-arm64";   ARCH="arm64" ;;
  x86_64-unknown-linux-gnu)     PLATFORM="linux-x64";     ARCH="x64"   ;;
  aarch64-unknown-linux-musl)   PLATFORM="linuxmusl-arm64"; ARCH="arm64" ;;
  x86_64-unknown-linux-musl)    PLATFORM="linuxmusl-x64"; ARCH="x64"   ;;
  aarch64-pc-windows-msvc)      PLATFORM="win32-arm64";   ARCH="arm64" ;;
  x86_64-pc-windows-msvc)       PLATFORM="win32-x64";     ARCH="x64"   ;;
  *) echo "Unsupported target: $TARGET" >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/node_modules/@github"
STAGE="$ROOT/src-tauri/resources/copilot-bundle/node_modules/@github"

if [ ! -d "$SRC/copilot" ]; then
  echo "Missing $SRC/copilot — run \`npm ci\` first." >&2
  exit 1
fi

# Read the @github/copilot version so we install the matching sibling package.
COPILOT_VERSION="$(node -p "require('$SRC/copilot/package.json').version")"
SIBLING_PKG="@github/copilot-$PLATFORM"

# Ensure the platform-specific sibling is installed. npm only auto-installs the
# host platform's optional dep, so cross-target builds (e.g. building
# x86_64-apple-darwin on an arm64 runner) need an explicit install.
if [ ! -d "$SRC/copilot-$PLATFORM" ]; then
  echo "Installing $SIBLING_PKG@$COPILOT_VERSION (cross-platform sibling)..."
  (cd "$ROOT" && npm install --no-save --no-audit --no-fund \
    "$SIBLING_PKG@$COPILOT_VERSION")
fi

echo "Staging @github/copilot + $SIBLING_PKG + @github/copilot-sdk for $PLATFORM..."

rm -rf "$STAGE"
mkdir -p "$STAGE"

# Use cp -R; we want a writable copy we can prune. -R follows symlinks at the
# top level which is what we want for npm trees.
cp -R "$SRC/copilot"          "$STAGE/copilot"
cp -R "$SRC/copilot-$PLATFORM" "$STAGE/copilot-$PLATFORM"
cp -R "$SRC/copilot-sdk"      "$STAGE/copilot-sdk"

# Prune wrong-platform native binaries from @github/copilot.
prune_siblings() {
  local dir="$1"; local keep="$2"
  [ -d "$dir" ] || return 0
  for entry in "$dir"/*; do
    [ -e "$entry" ] || continue
    local name; name="$(basename "$entry")"
    if [ "$name" != "$keep" ]; then
      rm -rf "$entry"
    fi
  done
}

prune_siblings "$STAGE/copilot/prebuilds"    "$PLATFORM"
prune_siblings "$STAGE/copilot/mxc-bin"      "$ARCH"
prune_siblings "$STAGE/copilot/ripgrep/bin"  "$PLATFORM"
prune_siblings "$STAGE/copilot/tgrep/bin"    "$PLATFORM"

# Report final staged size so CI logs show the bundle weight.
if command -v du >/dev/null; then
  echo "Staged size:"
  du -sh "$STAGE"/* 2>/dev/null | sort -h || true
  echo "Total staged: $(du -sh "$STAGE" | awk '{print $1}')"
fi

echo "Done. Staged into: $STAGE"
