# Classifier Design — Clawdia 4.0
# ═══════════════════════════════════
# The classifier runs BEFORE the LLM API call. It is pure regex/keyword
# matching — zero LLM cost, zero latency. It returns a TaskProfile that
# determines which tool group, which prompt modules, and which model to use.
#
# Design principle: Be generous with GROUP_FULL. The cost difference
# between a filtered group and full group is ~200 tokens after caching.
# A wrong classification that misses needed tools costs an entire
# wasted iteration (~3,000+ tokens). When in doubt, send everything.
# ═══════════════════════════════════


## TaskProfile Interface

```typescript
interface TaskProfile {
  toolGroup: 'core' | 'browser' | 'full';
  promptModules: Set<'coding' | 'research' | 'document' | 'desktop_apps' | 'self_knowledge'>;
  model: 'haiku' | 'sonnet' | 'opus';
  isGreeting: boolean;
}
```


## Classification Rules (evaluated top-to-bottom, first match wins for toolGroup)

### Rule 0: Greetings
PATTERN: /^(hi|hello|hey|yo|sup|good morning|good afternoon|good evening)[!?.,]?$/i
  → toolGroup: 'core'  (doesn't matter, no tools will be called)
  → promptModules: []
  → model: 'haiku'
  → isGreeting: true

### Rule 1: Explicit browser intent
PATTERN: /https?:\/\//i  (URL present)
   OR: /(search|look up|google|browse|find online|navigate to|go to|open.*website|check.*site|what.*price|how much.*cost|latest news)/i
  → toolGroup: 'browser'
  → promptModules: ['research'] if /(compare|vs|best|recommend|analyze|report)/i
  → model: 'sonnet'

### Rule 1b: Coordination / parallel-agent intent
PATTERN: /(agent_spawn|spawn .* (agent|sub-agent|worker)|sub-agent|parallel|coordinator|swarm|workstream)/i
  → toolGroup: 'full'
  → promptModules: preserve any browser/research modules already matched
  → model: 'sonnet'

Reason: coordination requests need `agent_spawn`, which is not present in the browser-only group.

### Rule 2: Explicit filesystem/code intent
PATTERN: /(read|write|edit|create|delete|move|copy|rename).*file/i
   OR: /(src\/|\.ts|\.tsx|\.js|\.py|\.rs|\.go|\.java|\.cpp|\.c$|\.h$|package\.json|Cargo\.toml)/i
   OR: /(refactor|debug|implement|fix.*bug|build|compile|npm|pip|cargo|git )/i
   OR: /(ls |cd |cat |grep |find |mkdir |rm |chmod |sudo )/i
  → toolGroup: 'core'
  → promptModules: ['coding']
  → model: 'sonnet'

### Rule 3: Document creation
PATTERN: /(document|report|spreadsheet|pdf|docx|xlsx|csv|slides|presentation|write.*memo|write.*letter)/i
  → toolGroup: 'full'  (may need browser for research + fs for saving)
  → promptModules: ['document', 'research']
  → model: 'sonnet'

### Rule 4: Desktop application control
PATTERN: /(gimp|blender|inkscape|libreoffice|audacity|obs|kdenlive|shotcut|vlc|firefox|chrome|spotify|...)/i
   OR: /(launch|open|start|run|control|close|quit|interact).*app/i
   OR: /play.*music|pause.*music|next.*track|volume|screenshot|click.*button|dbus|xdotool|wmctrl/i
  → toolGroup: 'full'
  → promptModules: ['desktop_apps']
  → model: 'sonnet'

Note: The routing layer (app-registry.ts) handles surface selection AFTER
classification. The classifier just gates tool access; the registry decides
whether to use programmatic, DBus, CLI, or GUI for the detected app.

### Rule 5: Self-reference
PATTERN: /(clawdia|your (code|source|memory|data|settings|config)|this app|clear (my|your|all) (data|history|memory)|reset)/i
  → toolGroup: 'core'
  → promptModules: ['self_knowledge']
  → model: 'sonnet'

### Rule 6: Complex multi-domain (fallback for compound requests)
PATTERN: message length > 200 characters AND matches 2+ of the above patterns
  → toolGroup: 'full'
  → promptModules: (union of all matched modules)
  → model: 'sonnet'

### Rule 7: Default (conversational / ambiguous)
No pattern matched
  → toolGroup: 'full'  (safe default — let the model decide what it needs)
  → promptModules: []
  → model: 'sonnet'


## Model Selection Override

These override the per-rule model choice:

- If user explicitly says "use opus" or "use haiku" → respect that
- If message contains "assess", "evaluate", "plan", "deep analysis" → 'opus'
- If message is a simple factual question (< 50 chars, question mark, no action verbs) → 'haiku'


## Mid-Loop Escalation

When the model signals it needs tools not in the current group:
1. Model produces tool_use for an unknown tool name → API returns error
2. Loop catches the error
3. Re-classify with toolGroup = 'full'
4. Re-send the current iteration with expanded tools
5. Accept one cache miss; subsequent iterations cache the new group

This should happen rarely (<5% of requests) if the classifier is well-tuned.
