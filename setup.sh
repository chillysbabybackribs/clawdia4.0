#!/usr/bin/env bash
set -e

echo ""
echo "  ╔═══════════════════════════════════╗"
echo "  ║       Clawdia 4.0 — Setup         ║"
echo "  ╚═══════════════════════════════════╝"
echo ""

# ── Check Node.js ──
if ! command -v node &> /dev/null; then
  echo "❌ Node.js is not installed."
  echo "   Install Node.js 20+ from https://nodejs.org"
  echo "   Or use nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "❌ Node.js $NODE_VERSION detected. Clawdia requires Node.js 20+."
  echo "   Current: $(node -v)"
  echo "   Upgrade: nvm install 20 && nvm use 20"
  exit 1
fi
echo "✓ Node.js $(node -v)"

# ── Check npm ──
if ! command -v npm &> /dev/null; then
  echo "❌ npm is not installed."
  exit 1
fi
echo "✓ npm $(npm -v)"

# ── Check build tools (Linux) ──
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
  if ! command -v gcc &> /dev/null; then
    echo ""
    echo "⚠ Build tools not found. Installing..."
    echo "  Running: sudo apt install -y build-essential python3"
    sudo apt install -y build-essential python3 || {
      echo "❌ Failed to install build tools."
      echo "   Run manually: sudo apt install build-essential python3"
      exit 1
    }
  fi
  echo "✓ Build tools (gcc, make)"
fi

# ── Check build tools (macOS) ──
if [[ "$OSTYPE" == "darwin"* ]]; then
  if ! xcode-select -p &> /dev/null; then
    echo ""
    echo "⚠ Xcode Command Line Tools not found. Installing..."
    xcode-select --install
    echo "   After installation completes, run this script again."
    exit 0
  fi
  echo "✓ Xcode Command Line Tools"
fi

# ── Install dependencies ──
echo ""
echo "Installing dependencies..."
npm install || {
  echo ""
  echo "❌ npm install failed."
  echo ""
  echo "Common fixes:"
  echo "  Linux:   sudo apt install build-essential python3"
  echo "  macOS:   xcode-select --install"
  echo "  Windows: npm install -g windows-build-tools"
  echo ""
  echo "If better-sqlite3 fails specifically, try:"
  echo "  npx electron-rebuild -f -w better-sqlite3"
  exit 1
}
echo "✓ Dependencies installed"

# ── Build TypeScript ──
echo ""
echo "Building..."
npm run build:main || {
  echo "❌ TypeScript build failed."
  exit 1
}
echo "✓ Build complete"

# ── Detect GPU issues (Linux) ──
GPU_FLAG=""
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
  # Check for hybrid GPU setups that commonly cause Electron crashes
  if lspci 2>/dev/null | grep -qi "nvidia" && lspci 2>/dev/null | grep -qi "intel.*graphics"; then
    echo ""
    echo "⚠ Hybrid NVIDIA/Intel GPU detected."
    echo "  If you experience crashes, use: npm run dev:nogpu"
    GPU_FLAG=":nogpu"
  fi
fi

# ── Done ──
echo ""
echo "  ╔═══════════════════════════════════╗"
echo "  ║         Setup Complete ✓          ║"
echo "  ╚═══════════════════════════════════╝"
echo ""
echo "  To start Clawdia:"
echo ""
echo "    npm run dev${GPU_FLAG}"
echo ""
echo "  On first launch, paste your Anthropic API key"
echo "  in the welcome screen to get started."
echo ""
echo "  Get a key at: https://console.anthropic.com"
echo ""
