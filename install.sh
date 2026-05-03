#!/bin/sh
# joust installer — downloads a release binary, verifies sha256, places it on PATH.
#
# usage:
#   curl -fsSL https://github.com/ahoward/joust/releases/latest/download/install.sh | sh
#
# env overrides:
#   JOUST_VERSION=v0.2.0      pin a specific version (default: latest)
#   JOUST_INSTALL_DIR=/path   install location (default: $HOME/.local/bin)
#
# output (when install dir is NOT on $PATH):
#   the last line of stdout is `JOUST_BINARY=<absolute_path>` so a calling
#   agent / skill can invoke joust by absolute path even without a PATH update.

set -eu

REPO="ahoward/joust"
VERSION="${JOUST_VERSION:-latest}"
INSTALL_DIR="${JOUST_INSTALL_DIR:-$HOME/.local/bin}"

# --- detect platform/arch ---

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS-$ARCH" in
  linux-x86_64)  TARGET="linux-x64" ;;
  darwin-arm64)  TARGET="darwin-arm64" ;;
  darwin-x86_64) TARGET="darwin-x64" ;;
  *)
    echo "joust: unsupported platform $OS-$ARCH" >&2
    echo "joust: supported: linux-x64, darwin-arm64, darwin-x64" >&2
    exit 1
    ;;
esac

ASSET="joust-$TARGET"

# --- resolve release URL ---

if [ "$VERSION" = "latest" ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/$VERSION"
fi

BINARY_URL="$BASE/$ASSET"
SHA_URL="$BASE/$ASSET.sha256"

# --- platform-aware sha256 verification ---

verify_sha256() {
  expected="$1"
  file="$2"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    echo "joust: neither sha256sum nor shasum found; cannot verify" >&2
    return 1
  fi
  if [ "$expected" != "$actual" ]; then
    echo "joust: checksum mismatch for $file" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    return 1
  fi
}

# --- download to a temp dir, verify, then atomic mv ---

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT INT TERM

echo "joust: downloading $ASSET from $BINARY_URL"
if ! curl --fail --silent --show-error -L "$BINARY_URL" -o "$TMPDIR/joust"; then
  echo "joust: download failed" >&2
  exit 1
fi

echo "joust: downloading checksum"
if ! curl --fail --silent --show-error -L "$SHA_URL" -o "$TMPDIR/joust.sha256"; then
  echo "joust: checksum download failed" >&2
  exit 1
fi

EXPECTED_SHA="$(awk '{print $1}' "$TMPDIR/joust.sha256")"
if [ -z "$EXPECTED_SHA" ]; then
  echo "joust: empty checksum file from $SHA_URL" >&2
  exit 1
fi

echo "joust: verifying checksum"
if ! verify_sha256 "$EXPECTED_SHA" "$TMPDIR/joust"; then
  exit 1
fi

# --- ensure install dir exists, place binary atomically ---

if ! mkdir -p "$INSTALL_DIR"; then
  echo "joust: cannot create $INSTALL_DIR" >&2
  exit 1
fi

if [ ! -w "$INSTALL_DIR" ]; then
  echo "joust: $INSTALL_DIR is not writable by $(id -un)" >&2
  echo "joust: set JOUST_INSTALL_DIR=<path> to override" >&2
  exit 1
fi

chmod +x "$TMPDIR/joust"
mv "$TMPDIR/joust" "$INSTALL_DIR/joust"

# --- verify install ---

if ! "$INSTALL_DIR/joust" --version >/dev/null 2>&1; then
  echo "joust: installed binary failed --version probe at $INSTALL_DIR/joust" >&2
  exit 1
fi

INSTALLED="$("$INSTALL_DIR/joust" --version)"
echo "joust: installed $INSTALLED at $INSTALL_DIR/joust"

# --- PATH detection ---
# if the install dir is on $PATH, we're done. otherwise emit a parseable
# JOUST_BINARY=<path> line so a calling agent can capture it.

case ":${PATH:-}:" in
  *":$INSTALL_DIR:"*)
    : # on PATH; nothing more to do
    ;;
  *)
    echo "joust: $INSTALL_DIR is not on \$PATH; add this to your shell init:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    echo "JOUST_BINARY=$INSTALL_DIR/joust"
    ;;
esac
