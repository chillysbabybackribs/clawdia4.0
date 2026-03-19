#!/bin/bash
# Clawdia 4.0 — Patch desktop-executors.ts
# Applies 3 targeted patches:
#   1. Fix stale header comment (priority order)
#   2. Add listProfiles to imports
#   3. Replace compgen harness discovery with registry read

set -e
FILE="/home/dp/Desktop/clawdia4.0/src/main/agent/executors/desktop-executors.ts"

if [ ! -f "$FILE" ]; then
  echo "ERROR: File not found: $FILE"
  exit 1
fi

# Backup
cp "$FILE" "${FILE}.bak"
echo "Backed up to ${FILE}.bak"

# Patch 1: Fix header comment
python3 -c "
import sys
with open('$FILE', 'r') as f:
    c = f.read()

old = '''/**
 * Desktop Tool Executors — Application control surfaces.
 * 
 * Control surface priority (highest → lowest):
 *   1. programmatic — shell_exec with Python/ImageMagick/ffmpeg
 *   2. dbus         — dbus_control for MPRIS/DBus-capable apps
 *   3. cli_anything — app_control with CLI-Anything harness
 *   4. native_cli   — shell_exec with app's native CLI/batch mode
 *   5. gui          — gui_interact (last resort)
 * 
 * The app-registry routing layer selects the surface before the LLM acts.
 * These executors carry out whichever surface was chosen.'''

new = '''/**
 * Desktop Tool Executors — Application control surfaces.
 * 
 * Control surface priority is PROFILE-DRIVEN, not fixed here.
 * The app-registry (routeTask) selects the surface per-task based on:
 *   - the app\\'s AppProfile.availableSurfaces
 *   - the task type (TASK_RULES regex match)
 *   - whether a CLI-Anything harness is installed (auto-promoted if so)
 * 
 * These executors carry out whichever surface was chosen.
 * NOTE: app_control is bypassed entirely when routeTask selects cli_anything
 * (the LLM calls shell_exec with the harness directly).'''

if old not in c:
    print('WARN: Header patch target not found (may already be applied)')
else:
    c = c.replace(old, new, 1)
    print('✓ Patch 1: Header comment fixed')

# Patch 2: Add listProfiles to imports
old2 = '''import {
  getAppProfile,
  getHarnessGuidance,
  type AppProfile,
  type ControlSurface,
  recordFallback,
} from '../../db/app-registry';'''

new2 = '''import {
  getAppProfile,
  getHarnessGuidance,
  listProfiles,
  type AppProfile,
  type ControlSurface,
  recordFallback,
} from '../../db/app-registry';'''

if old2 not in c:
    if 'listProfiles,' in c:
        print('SKIP: Patch 2 already applied (listProfiles in imports)')
    else:
        print('WARN: Import patch target not found')
else:
    c = c.replace(old2, new2, 1)
    print('✓ Patch 2: listProfiles added to imports')

# Patch 3: Replace compgen with registry read
old3 = '''  // CLI-Anything harnesses
  let harnesses: string[] = [];
  try {
    const { stdout } = await execAsync('bash -c \"compgen -c cli-anything-\" 2>/dev/null || echo \"\"', { timeout: 3000 });
    harnesses = stdout.trim().split('\\\\n').map(s => s.replace(/.*cli-anything-/, '').trim()).filter(Boolean);
  } catch {}'''

new3 = '''  // CLI-Anything harnesses — read from registry (populated by scanHarnesses)
  // instead of running a redundant compgen shell call.
  let harnesses: string[] = [];
  try {
    const profiles = listProfiles();
    harnesses = profiles
      .filter(p => p.cliAnything?.installed)
      .map(p => p.appId);
  } catch {}'''

if old3 not in c:
    if 'listProfiles()' in c and 'compgen' not in c.split('CLI-Anything harnesses')[1].split('Display layout')[0]:
        print('SKIP: Patch 3 already applied (listProfiles in harness section)')
    else:
        print('WARN: Harness patch target not found — trying alternate match')
        # Try with literal newlines
        import re
        pattern = r'  // CLI-Anything harnesses\n  let harnesses: string\[\] = \[\];\n  try \{[^}]+compgen[^}]+\} catch \{\}'
        if re.search(pattern, c):
            c = re.sub(pattern, new3.lstrip(), c, count=1)
            print('✓ Patch 3: Harness discovery replaced (regex match)')
        else:
            print('FAIL: Could not match harness section')
else:
    c = c.replace(old3, new3, 1)
    print('✓ Patch 3: Harness discovery replaced with registry read')

with open('$FILE', 'w') as f:
    f.write(c)

print(f'\\nFile written: {len(c)} chars')
"

echo ""
echo "Verifying patches..."
grep -c "PROFILE-DRIVEN" "$FILE" && echo "  ✓ Header patched" || echo "  ✗ Header NOT patched"
grep -c "listProfiles," "$FILE" && echo "  ✓ Import added" || echo "  ✗ Import NOT added"
grep -c "listProfiles()" "$FILE" && echo "  ✓ Registry read in harness section" || echo "  ✗ Registry read NOT found"
echo ""
echo "Done. Run 'diff ${FILE}.bak $FILE' to review changes."
