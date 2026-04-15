#!/usr/bin/env bash
#
# joust installer
#
# usage:
#   curl -fsSL https://raw.githubusercontent.com/ahoward/joust/main/install.sh | bash
#
set -euo pipefail

REPO="ahoward/joust"
INSTALL_DIR="${JOUST_INSTALL_DIR:-/usr/local/bin}"
BINARY="joust"

# --- detect platform ---

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  linux)  OS="linux" ;;
  darwin) OS="darwin" ;;
  *)      echo "error: unsupported OS: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64)  ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)             echo "error: unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

ASSET="joust-${OS}-${ARCH}"

echo "joust installer"
echo "  platform: ${OS}-${ARCH}"
echo "  install:  ${INSTALL_DIR}/${BINARY}"
echo ""

# --- fetch latest release tag ---

TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)

if [ -z "$TAG" ]; then
  echo "error: could not determine latest release" >&2
  exit 1
fi

echo "  version:  ${TAG}"

URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"

# --- download ---

echo ""
echo "downloading ${URL}..."

TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

curl -fSL --progress-bar -o "$TMPFILE" "$URL"

chmod +x "$TMPFILE"

# --- install ---

if [ -w "$INSTALL_DIR" ]; then
  mv "$TMPFILE" "${INSTALL_DIR}/${BINARY}"
else
  echo ""
  echo "installing to ${INSTALL_DIR} (requires sudo)..."
  sudo mv "$TMPFILE" "${INSTALL_DIR}/${BINARY}"
fi

echo ""
echo "installed: $(${INSTALL_DIR}/${BINARY} --help 2>&1 | head -1)"
echo ""
echo "done. run: joust --help"
