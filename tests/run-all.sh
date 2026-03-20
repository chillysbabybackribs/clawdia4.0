#!/bin/bash
# ═══════════════════════════════════════════════════════
# Clawdia 4.0 — Test Suite Runner
#
# Tests that need native modules (better-sqlite3) run via Electron.
# Pure-logic tests run via npx tsx (faster, no Electron overhead).
# ═══════════════════════════════════════════════════════
cd "$(dirname "$0")/.."

echo "═══════════════════════════════════════════════════════"
echo "  Clawdia 4.0 — Test Suite"
echo "═══════════════════════════════════════════════════════"
echo ""

FAILED_SUITES=()

run_tsx() {
  local name="$1"
  local file="$2"
  echo "── $name (tsx) ──"
  if npx tsx "$file"; then
    echo ""
  else
    FAILED_SUITES+=("$name")
    echo ""
  fi
}

run_electron() {
  local name="$1"
  local file="$2"
  echo "── $name (electron) ──"
  local tmpout
  tmpout=$(mktemp)
  npx electron --no-sandbox tests/electron-runner.js "$file" >"$tmpout" 2>&1
  local rc=$?
  # Show output, filtering Electron noise
  grep -v -E '(libEGL|libGL|GPU|MESA|Gtk-WARNING|DBus|DevTools)' "$tmpout" || true
  rm -f "$tmpout"
  if [ $rc -ne 0 ]; then
    FAILED_SUITES+=("$name")
  fi
  echo ""
}

# Pure logic tests — no native modules, fast
run_tsx "Classifier"           tests/test-classifier.ts
run_tsx "Agent Overrides"     tests/test-agent-profile-override.ts
run_tsx "Filesystem Routing"  tests/test-filesystem-agent-routing.ts
run_tsx "Filesystem Stop"     tests/test-filesystem-agent-stop.ts
run_tsx "Capability Snapshot"  tests/test-capability-snapshot.ts
run_tsx "Loop Dispatch"        tests/test-loop-dispatch.ts
run_tsx "UI State + Shortcuts" tests/phase1-test.ts

# Tests requiring native modules (better-sqlite3 via executors/DB) — run via Electron
run_electron "Tool Builder"    tests/test-tool-builder.ts
run_electron "Filesystem Agent" tests/test-filesystem-agent.ts
run_electron "Routing"         tests/test-routing.ts

echo "═══════════════════════════════════════════════════════"
if [ ${#FAILED_SUITES[@]} -eq 0 ]; then
  echo "  ✅ All test suites passed!"
else
  echo "  ❌ Failed suites: ${FAILED_SUITES[*]}"
  exit 1
fi
echo "═══════════════════════════════════════════════════════"
