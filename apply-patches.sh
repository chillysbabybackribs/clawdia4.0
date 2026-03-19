#!/bin/bash
# ═══════════════════════════════════════════════════════
# Clawdia 4.0 — Audit Cleanup Pass
# Run this from the project root: ./apply-patches.sh
# ═══════════════════════════════════════════════════════
set -e
cd "$(dirname "$0")"

echo "═══════════════════════════════════════════════════════"
echo "  Clawdia 4.0 — Audit Cleanup Patches"
echo "═══════════════════════════════════════════════════════"
echo ""

echo "── 1. Prompt files (already written directly) ──"
echo "  ✓ DESKTOP_APPS.md — slimmed (removed duplicate priority list + cascade description)"
echo "  ✓ full/CONTEXT.md — removed 'Desktop Application Control' section"
echo ""

echo "── 2. desktop-executors.ts patches ──"
bash patch-desktop-executors.sh
echo ""

echo "── 3. app-registry.ts header ──"
bash patch-app-registry.sh
echo ""

echo "── 4. loop.ts — CapabilitySnapshot wiring ──"
bash patch-loop.sh
echo ""

echo "── 5. New file: capability-snapshot.ts ──"
if [ -f "src/main/agent/capability-snapshot.ts" ]; then
  echo "  ✓ capability-snapshot.ts already exists"
else
  echo "  ✗ capability-snapshot.ts missing!"
fi
echo ""

echo "═══════════════════════════════════════════════════════"
echo "  Summary of changes:"
echo ""
echo "  PROMPT CLEANUP:"
echo "    - DESKTOP_APPS.md: ~150 fewer tokens (removed priority list + cascade)"
echo "    - full/CONTEXT.md: ~100 fewer tokens (removed Desktop section)"
echo ""
echo "  COMMENT FIXES:"
echo "    - desktop-executors.ts: header says 'PROFILE-DRIVEN' not fixed order"
echo "    - app-registry.ts: header says 'task-dependent' not fixed order"
echo ""
echo "  CODE CHANGES:"
echo "    - desktop-executors.ts: harness discovery reads registry, not compgen"
echo "    - desktop-executors.ts: imports listProfiles from app-registry"
echo "    - loop.ts: imports + logs CapabilitySnapshot after pre-LLM setup"
echo ""
echo "  NEW FILES:"
echo "    - src/main/agent/capability-snapshot.ts (~70 lines)"
echo ""
echo "  To verify: npm run build (or your build command)"
echo "  To revert: .bak files created for desktop-executors.ts"
echo "═══════════════════════════════════════════════════════"
