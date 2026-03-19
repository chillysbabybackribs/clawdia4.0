#!/bin/bash
# Clawdia 4.0 — Patch app-registry.ts header comment
set -e
FILE="/home/dp/Desktop/clawdia4.0/src/main/db/app-registry.ts"

python3 -c "
with open('$FILE', 'r') as f:
    c = f.read()

old = ''' * Control surfaces (in priority order):
 *   programmatic → cli_anything → native_cli → dbus → gui'''

new = ''' * Control surfaces (order is task-dependent, see TASK_RULES):
 *   programmatic, cli_anything, native_cli, dbus, gui
 * CLI-Anything is auto-promoted to first when installed.'''

if old in c:
    c = c.replace(old, new, 1)
    with open('$FILE', 'w') as f:
        f.write(c)
    print('✓ app-registry.ts header comment fixed')
else:
    print('SKIP: Already patched or target not found')
"
