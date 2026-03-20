# Auto-Graduation Integration Patch
# Apply these 3 edits to wire up self-training

## ═══════════════════════════════════════════════════
## EDIT 1: src/main/main.ts — Add import (after line 33)
## ═══════════════════════════════════════════════════

# FIND this line:
import { getDb, closeDb } from './db/database';

# ADD this line immediately AFTER it:
import { scheduleAutoGraduation } from './db/executor-auto-graduation';


## ═══════════════════════════════════════════════════
## EDIT 2: src/main/main.ts — Add startup call (after line 101)
## ═══════════════════════════════════════════════════

# FIND these two lines:
  getDb();
  seedPolicyProfiles();

# ADD this line immediately AFTER seedPolicyProfiles():
  scheduleAutoGraduation();


## ═══════════════════════════════════════════════════
## EDIT 3: src/main/db/browser-playbooks.ts — Add nudge (2 spots)
## ═══════════════════════════════════════════════════

# FIND this import block at the top of browser-playbooks.ts:
import { getDb } from './database';

# ADD this line immediately AFTER it:
import { nudgeGraduation } from './executor-auto-graduation';

# THEN FIND the return block at the end of savePlaybook() (~line 210):
  return {
    domain,
    taskPattern: pattern,

# ADD this line immediately BEFORE the return:
  nudgeGraduation();

  return {
    domain,
    taskPattern: pattern,
