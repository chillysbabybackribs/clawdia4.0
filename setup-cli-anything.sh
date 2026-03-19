#!/bin/bash
# ═══════════════════════════════════════════════════════
# Clawdia 4.0 — CLI-Anything Setup Script
# Installs GIMP + LibreOffice CLI harnesses
# ═══════════════════════════════════════════════════════
set -e

echo "═══════════════════════════════════════════════════════"
echo "  CLI-Anything Setup for Clawdia 4.0"
echo "═══════════════════════════════════════════════════════"
echo ""

INSTALL_DIR="$HOME/CLI-Anything"

# ── Step 1: Clone repo if not present ──
if [ -d "$INSTALL_DIR" ]; then
  echo "[1/6] CLI-Anything repo already exists at $INSTALL_DIR"
  cd "$INSTALL_DIR" && git pull --ff-only 2>/dev/null || true
else
  echo "[1/6] Cloning CLI-Anything..."
  git clone https://github.com/HKUDS/CLI-Anything.git "$INSTALL_DIR"
fi
echo ""

# ── Step 2: Install GIMP if not present ──
if command -v gimp &>/dev/null; then
  echo "[2/6] GIMP already installed: $(gimp --version 2>&1 | head -1)"
else
  echo "[2/6] Installing GIMP..."
  sudo apt update -qq && sudo apt install -y gimp
fi
echo ""

# ── Step 3: Verify LibreOffice ──
if command -v soffice &>/dev/null; then
  echo "[3/6] LibreOffice already installed: $(soffice --version 2>&1)"
else
  echo "[3/6] Installing LibreOffice..."
  sudo apt update -qq && sudo apt install -y libreoffice
fi
echo ""

# ── Step 4: Install GIMP CLI harness ──
echo "[4/6] Installing cli-anything-gimp..."
cd "$INSTALL_DIR/gimp/agent-harness"
pip install -e . --break-system-packages 2>&1 | tail -3
if command -v cli-anything-gimp &>/dev/null; then
  echo "  ✓ cli-anything-gimp installed successfully"
  cli-anything-gimp --help 2>&1 | head -5
else
  echo "  ✗ cli-anything-gimp not on PATH — trying with python3 -m"
  python3 -m cli_anything.gimp --help 2>&1 | head -3 || echo "  ✗ GIMP harness install failed"
fi
echo ""

# ── Step 5: Install LibreOffice CLI harness ──
echo "[5/6] Installing cli-anything-libreoffice..."
cd "$INSTALL_DIR/libreoffice/agent-harness"
pip install -e . --break-system-packages 2>&1 | tail -3
if command -v cli-anything-libreoffice &>/dev/null; then
  echo "  ✓ cli-anything-libreoffice installed successfully"
  cli-anything-libreoffice --help 2>&1 | head -5
else
  echo "  ✗ cli-anything-libreoffice not on PATH — trying with python3 -m"
  python3 -m cli_anything.libreoffice --help 2>&1 | head -3 || echo "  ✗ LibreOffice harness install failed"
fi
echo ""

# ── Step 6: Verify everything ──
echo "[6/6] Verification..."
echo ""
echo "  CLI-Anything repo:    $INSTALL_DIR"
echo "  GIMP binary:          $(which gimp 2>/dev/null || echo 'NOT FOUND')"
echo "  LibreOffice binary:   $(which soffice 2>/dev/null || echo 'NOT FOUND')"
echo "  cli-anything-gimp:    $(which cli-anything-gimp 2>/dev/null || echo 'NOT FOUND')"
echo "  cli-anything-libre:   $(which cli-anything-libreoffice 2>/dev/null || echo 'NOT FOUND')"
echo ""

# List all cli-anything commands discovered
echo "  All CLI-Anything harnesses on PATH:"
compgen -c cli-anything- 2>/dev/null | sort -u | while read cmd; do
  echo "    - $cmd"
done
echo ""

echo "═══════════════════════════════════════════════════════"
echo "  Setup complete!"
echo ""
echo "  Clawdia will auto-detect these harnesses on the next"
echo "  desktop task (via scanHarnesses in app-registry.ts)."
echo ""
echo "  Test commands:"
echo "    cli-anything-gimp --help"
echo "    cli-anything-gimp project new --width 800 --height 600 -o /tmp/test.json"
echo "    cli-anything-libreoffice --help"
echo "═══════════════════════════════════════════════════════"
