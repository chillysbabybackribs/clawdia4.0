#!/bin/bash
set -e

cd ~/Desktop/clawdia4.0

echo "═══════════════════════════════════════"
echo "  Clawdia 4.0 — Setup & Launch"
echo "═══════════════════════════════════════"
echo ""

# Clean stale artifacts
echo "→ Cleaning stale artifacts..."
rm -rf node_modules package-lock.json dist

# Install dependencies
echo "→ Installing dependencies..."
npm install

# Compile main process TypeScript
echo "→ Compiling main process..."
npx tsc -p tsconfig.main.json

# Verify compiled output exists
if [ ! -f dist/main/main.js ] || [ ! -f dist/main/preload.js ]; then
  echo "✗ Main process compilation failed — check tsconfig.main.json"
  exit 1
fi

echo "✓ Build complete"
echo ""
echo "═══════════════════════════════════════"
echo "  Starting dev server..."
echo "═══════════════════════════════════════"
echo ""

# Launch all three processes concurrently
npm run dev
