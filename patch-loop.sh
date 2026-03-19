#!/bin/bash
# Clawdia 4.0 — Patch loop.ts to add CapabilitySnapshot logging
set -e
FILE="/home/dp/Desktop/clawdia4.0/src/main/agent/loop.ts"

python3 -c "
with open('$FILE', 'r') as f:
    c = f.read()

changes = 0

# Patch 1: Add import for CapabilitySnapshot
import_anchor = \"import { IPC_EVENTS } from '../../shared/ipc-channels';\"
import_line = \"import { buildCapabilitySnapshot, formatSnapshotLog } from './capability-snapshot';\"

if import_line in c:
    print('SKIP: CapabilitySnapshot import already present')
else:
    if import_anchor in c:
        c = c.replace(import_anchor, import_line + '\n' + import_anchor, 1)
        changes += 1
        print('✓ Patch 1: Added CapabilitySnapshot import')
    else:
        print('WARN: Could not find import anchor')

# Patch 2: Add snapshot logging after parallel setup completes
# Target: the line 'const { executionPlan } = ctx;' — add snapshot right after
snapshot_anchor = '  // Destructure for readability after parallel setup'
snapshot_code = '''  // Destructure for readability after parallel setup
  // ── Capability Snapshot (diagnostic logging) ──
  if (isDesktopTask) {
    const profile = executionPlan?.appProfile || null;
    const appId = executionPlan?.appId || null;
    // Parse system capabilities from the cached desktop context string
    const capStr = ctx.desktopContext || '';
    const sysCaps = {
      xdotool: capStr.includes('xdotool'),
      dbus: capStr.includes('DBus: available'),
      a11y: capStr.includes('AT-SPI') && !capStr.includes('not installed'),
    };
    const snapshot = buildCapabilitySnapshot(appId, executionPlan, profile, sysCaps);
    console.log(formatSnapshotLog(snapshot));
  }'''

if 'buildCapabilitySnapshot' in c and 'formatSnapshotLog' in c:
    # Check if the snapshot logging block is already there
    if 'Capability Snapshot (diagnostic logging)' in c:
        print('SKIP: Snapshot logging already present')
    else:
        print('WARN: Imports present but logging block not found')
elif snapshot_anchor in c:
    c = c.replace(snapshot_anchor, snapshot_code, 1)
    changes += 1
    print('✓ Patch 2: Added capability snapshot logging')
else:
    print('WARN: Could not find snapshot anchor')

if changes > 0:
    with open('$FILE', 'w') as f:
        f.write(c)
    print(f'\nWritten {changes} patch(es) to {len(c)} chars')
else:
    print('\nNo changes needed')
"

echo ""
echo "Verifying..."
grep -c "buildCapabilitySnapshot" "$FILE" && echo "  ✓ Snapshot import present" || echo "  ✗ Missing snapshot import"
grep -c "formatSnapshotLog" "$FILE" && echo "  ✓ Snapshot logging present" || echo "  ✗ Missing snapshot logging"
