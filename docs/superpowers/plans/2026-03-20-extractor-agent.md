# Extractor Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a yt-dlp video extractor nested agent loop triggered by `/extractor` slash command or classifier intent detection, with full browser tool access and forced sonnet model.

**Architecture:** A self-contained `loop-ytdlp.ts` nested agent loop follows the exact pattern of `loop-harness.ts` — own `ProviderClient` via `createProviderClient`, own `AbortController` registered via `onRegisterCancel`, never touches `loop.ts` state. `loop.ts` short-circuits before the bloodhound block when `agentProfile === 'ytdlp'`. Six files need changes in dependency order.

**Tech Stack:** TypeScript, Anthropic claude-sonnet (forced via `resolveModelForProvider`), yt-dlp CLI, 8 browser tools + `shell_exec`, `loop-cancel.ts` abort registration pattern, `ProviderClient` interface.

**Spec:** `docs/superpowers/specs/2026-03-20-extractor-agent-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/shared/types.ts` | Modify | Add `'ytdlp'` to `AgentProfile` union — must be first |
| `src/main/agent/agent-profile-override.ts` | Modify | Add `/extractor` slash command + `ytdlp` branch before catch-all |
| `src/main/agent/classifier.ts` | Modify | Add `YTDLP_RE`, return `agentProfile: 'ytdlp'` when matched |
| `src/main/agent/prompt-builder.ts` | Modify | Add `ytdlp` branch in `buildDynamicPrompt` for profile directive |
| `src/main/agent/loop-ytdlp.ts` | Create | Nested agent loop: shell_exec + 8 browser tools, sentinel parsing |
| `src/main/agent/loop.ts` | Modify | Import cancel functions; insert ytdlp short-circuit; add suggestion |

---

## Task 1: Add `'ytdlp'` to `AgentProfile` type

**Files:**
- Modify: `src/shared/types.ts` (find `AgentProfile` type, ~line 50)

- [ ] **Step 1: Read the current AgentProfile line**

```bash
grep -n "AgentProfile" /home/dp/Desktop/clawdia4.0/src/shared/types.ts
```

Expected: line with `export type AgentProfile = 'general' | 'filesystem' | 'bloodhound';`

- [ ] **Step 2: Add `'ytdlp'` to the union**

Change:
```typescript
export type AgentProfile = 'general' | 'filesystem' | 'bloodhound';
```
To:
```typescript
export type AgentProfile = 'general' | 'filesystem' | 'bloodhound' | 'ytdlp';
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit 2>&1 | head -20
```

Expected: no new errors on `types.ts`.

- [ ] **Step 4: Commit**

```bash
cd /home/dp/Desktop/clawdia4.0 && git add src/shared/types.ts && git commit -m "feat: add 'ytdlp' to AgentProfile union"
```

---

## Task 2: Add `/extractor` slash command and `ytdlp` override branch

**Files:**
- Modify: `src/main/agent/agent-profile-override.ts`

> **Context:** `SLASH_PROFILE_MAP` maps slash commands to `AgentProfile` values. `applyAgentProfileOverride` has explicit branches for `'filesystem'` and `'bloodhound'`, then falls through to a `'general'` catch-all. The `'ytdlp'` branch MUST be added before the catch-all or ytdlp resets silently to general.

- [ ] **Step 1: Add `/extractor` to `SLASH_PROFILE_MAP`**

Find the `SLASH_PROFILE_MAP` object and add the entry:

```typescript
const SLASH_PROFILE_MAP: Record<string, AgentProfile> = {
  '/filesystem-agent': 'filesystem',
  '/general-agent': 'general',
  '/bloodhound': 'bloodhound',
  '/extractor': 'ytdlp',           // ADD THIS
};
```

- [ ] **Step 2: Add `ytdlp` branch before the catch-all in `applyAgentProfileOverride`**

Find the end of the `bloodhound` branch (which returns early). After that block and before the final catch-all return, insert:

```typescript
  if (forcedAgentProfile === 'ytdlp') {
    promptModules.add('browser');
    promptModules.delete('filesystem');
    promptModules.delete('bloodhound');
    return {
      ...baseProfile,
      agentProfile: 'ytdlp',
      toolGroup: 'browser',
      promptModules,
      isGreeting: false,
    };
  }
```

The catch-all block currently looks like:
```typescript
  promptModules.delete('filesystem');
  return {
    ...baseProfile,
    agentProfile: 'general',
    promptModules,
    isGreeting: false,
  };
```
The new `ytdlp` block must go immediately before this.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /home/dp/Desktop/clawdia4.0 && git add src/main/agent/agent-profile-override.ts && git commit -m "feat: add /extractor slash command and ytdlp profile override branch"
```

---

## Task 3: Add classifier regex for download intent

**Files:**
- Modify: `src/main/agent/classifier.ts`

> **Context:** The classifier uses pure regex rules. Add `YTDLP_RE` to detect clear download/video intent, then return `agentProfile: 'ytdlp'` when matched. Place the check before the `BLOODHOUND_RE` check (line ~75) so explicit download intent takes priority. Note `AgentProfile` is imported from `../../shared/types` — `'ytdlp'` is now valid after Task 1.

- [ ] **Step 1: Write the failing test**

Create `tests/agent/classifier-ytdlp.test.ts`:

```typescript
import { classify } from '../../../src/main/agent/classifier';

describe('classifier — ytdlp profile', () => {
  test('detects youtube URL', () => {
    const r = classify('download https://youtube.com/watch?v=abc123');
    expect(r.agentProfile).toBe('ytdlp');
    expect(r.toolGroup).toBe('browser');
  });

  test('detects youtu.be URL', () => {
    const r = classify('grab https://youtu.be/xyz');
    expect(r.agentProfile).toBe('ytdlp');
  });

  test('detects vimeo URL', () => {
    const r = classify('save video from vimeo.com/12345');
    expect(r.agentProfile).toBe('ytdlp');
  });

  test('detects download + video intent', () => {
    const r = classify('download the video from this link');
    expect(r.agentProfile).toBe('ytdlp');
  });

  test('does not match general web search', () => {
    const r = classify('search youtube for piano tutorials');
    expect(r.agentProfile).not.toBe('ytdlp');
  });

  test('does not match greeting', () => {
    const r = classify('hi');
    expect(r.agentProfile).not.toBe('ytdlp');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx jest tests/agent/classifier-ytdlp.test.ts --no-coverage 2>&1 | tail -20
```

Expected: FAIL — `'ytdlp'` not returned by classifier yet.

- [ ] **Step 3: Add `YTDLP_RE` constant after the existing `BLOODHOUND_RE` line**

```typescript
const YTDLP_RE = /\b(download|grab|save|extract|rip)\b.*(video|clip|audio|youtube|youtu\.be|vimeo|twitch|reel|short)|youtu\.be\/|youtube\.com\/watch|vimeo\.com\/\d/i;
```

- [ ] **Step 4: Add ytdlp check at the top of `classify()`, after the greeting check and before bloodhound match**

Find this comment/block in `classify()`:
```typescript
  // Collect all matching modules
  const matchesBrowser = BROWSER_RE.test(trimmed);
  const matchesBloodhound = BLOODHOUND_RE.test(trimmed);
```

Insert before that block:
```typescript
  // Rule: ytdlp — clear download/video intent
  if (YTDLP_RE.test(trimmed)) {
    modules.add('browser');
    return { agentProfile: 'ytdlp', toolGroup: 'browser', promptModules: modules, model: 'sonnet', isGreeting: false };
  }
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx jest tests/agent/classifier-ytdlp.test.ts --no-coverage 2>&1 | tail -20
```

Expected: all 6 tests PASS.

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 7: Commit**

```bash
cd /home/dp/Desktop/clawdia4.0 && git add src/main/agent/classifier.ts tests/agent/classifier-ytdlp.test.ts && git commit -m "feat: add YTDLP_RE classifier for download/video intent"
```

---

## Task 4: Add ytdlp profile directive in prompt-builder

**Files:**
- Modify: `src/main/agent/prompt-builder.ts`

> **Context:** `buildDynamicPrompt` has an `if (opts.agentProfile)` block that injects profile directives. It has branches for `'filesystem'` and `'bloodhound'`. Add `'ytdlp'` as a third branch. This is an `else if` after the bloodhound branch.

- [ ] **Step 1: Find the bloodhound branch**

In `prompt-builder.ts`, locate:
```typescript
    } else if (opts.agentProfile === 'bloodhound') {
      lines.push('PROFILE DIRECTIVE: You are acting as Bloodhound...');
    }
```

- [ ] **Step 2: Add the ytdlp branch immediately after**

```typescript
    } else if (opts.agentProfile === 'ytdlp') {
      lines.push('PROFILE DIRECTIVE: You are acting as Extractor, a video download agent. Use browser tools to locate the exact video URL(s) the user wants, then download with yt-dlp to ~/Desktop.');
    }
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
cd /home/dp/Desktop/clawdia4.0 && git add src/main/agent/prompt-builder.ts && git commit -m "feat: inject ytdlp profile directive in buildDynamicPrompt"
```

---

## Task 5: Create `loop-ytdlp.ts` — the nested agent loop

**Files:**
- Create: `src/main/agent/loop-ytdlp.ts`

> **Context:** This is the heart of the feature. Model it exactly on `loop-harness.ts`. Key points:
> - At entry, create a FRESH `ProviderClient` via `createProviderClient(client.provider, options.apiKey, resolveModelForProvider(client.provider, 'sonnet'))`. The passed-in `client` is only used to read `.provider` — never mutated.
> - Register abort via `options.onRegisterCancel(() => abortController.abort())` — do NOT call `clearNestedCancel` directly.
> - Tools: `shell_exec` + all 8 browser tools.
> - Pre-flight: run `which yt-dlp` via `shell_exec`. If it fails, return `success: false`.
> - Success sentinel: `[EXTRACTOR_SUCCESS:<path>]` — parsed out of LLM text each iteration.
> - Multiple sentinels allowed (playlist).
> - Loop limits: max 30 iterations, 10 min wall time.

- [ ] **Step 1: Write the failing test**

Create `tests/agent/loop-ytdlp.test.ts`:

```typescript
import { runYtdlpPipeline, EXTRACTOR_SENTINEL_RE, parseExtractorSentinels } from '../../../src/main/agent/loop-ytdlp';

describe('loop-ytdlp helpers', () => {
  test('EXTRACTOR_SENTINEL_RE matches valid sentinel', () => {
    const match = '[EXTRACTOR_SUCCESS:/home/dp/Desktop/my video.mp4]'.match(EXTRACTOR_SENTINEL_RE);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('/home/dp/Desktop/my video.mp4');
  });

  test('EXTRACTOR_SENTINEL_RE does not match partial text', () => {
    const match = 'EXTRACTOR_SUCCESS:/path'.match(EXTRACTOR_SENTINEL_RE);
    expect(match).toBeNull();
  });

  test('parseExtractorSentinels extracts multiple paths', () => {
    const text = 'Done\n[EXTRACTOR_SUCCESS:/a/b.mp4]\n[EXTRACTOR_SUCCESS:/a/c.mp4]';
    expect(parseExtractorSentinels(text)).toEqual(['/a/b.mp4', '/a/c.mp4']);
  });

  test('parseExtractorSentinels returns empty array when none found', () => {
    expect(parseExtractorSentinels('no sentinels here')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx jest tests/agent/loop-ytdlp.test.ts --no-coverage 2>&1 | tail -20
```

Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Create `src/main/agent/loop-ytdlp.ts`**

```typescript
/**
 * loop-ytdlp.ts — Extractor nested agent loop.
 *
 * Self-contained pipeline for finding and downloading videos with yt-dlp.
 * Follows the same structural pattern as loop-harness.ts:
 *   - Own ProviderClient (created fresh at entry)
 *   - Own AbortController (registered via onRegisterCancel)
 *   - Never touches loop.ts module state
 */

import type { ProviderClient } from './provider/base';
import type { NormalizedMessage, NormalizedTextBlock, NormalizedToolResultBlock, NormalizedToolUseBlock } from './client';
import { createProviderClient, resolveModelForProvider } from './provider/factory';
import { executeTool, getToolsForGroup } from './tool-builder';

const YTDLP_MAX_ITERATIONS = 30;
const YTDLP_MAX_MS = 10 * 60 * 1000;

// Exported for testing
export const EXTRACTOR_SENTINEL_RE = /\[EXTRACTOR_SUCCESS:([^\]]+)\]/g;

export function parseExtractorSentinels(text: string): string[] {
  const paths: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(EXTRACTOR_SENTINEL_RE.source, 'g');
  while ((match = re.exec(text)) !== null) {
    paths.push(match[1]);
  }
  return paths;
}

export interface YtdlpPipelineOptions {
  client: ProviderClient;           // only .provider is read — never mutated
  apiKey: string;
  onProgress: (text: string) => void;
  onRegisterCancel: (fn: () => void) => void;
}

export interface YtdlpResult {
  success: boolean;
  files: string[];
  reason?: string;
}

const YTDLP_SYSTEM_PROMPT = `You are Extractor, a video download agent inside Clawdia.

Your job: use browser tools to find the exact video URL(s) the user wants,
then download them with yt-dlp to ~/Desktop.

Download command: yt-dlp -o "~/Desktop/%(title)s.%(ext)s" <url>

After each download:
1. Read yt-dlp's stdout for the line: [download] Destination: <path>
2. Run: ls "<path>" to confirm the file exists.
3. If confirmed, output exactly: [EXTRACTOR_SUCCESS:<path>]

Rules:
- Never fabricate download results or file paths.
- If yt-dlp fails, read stderr and retry with --format best or a corrected URL.
- If the video requires login, report to the user — do not attempt to fill credentials.
- If geo-blocked, report and suggest the user configure yt-dlp cookies.
- Stop and report clearly if the video is genuinely unavailable.
- When the task is complete, output a plain summary of what was downloaded.`;

// Tools available to Extractor: shell_exec + all 8 browser tools
const EXTRACTOR_TOOLS = [
  'shell_exec',
  'browser_search', 'browser_navigate', 'browser_read_page',
  'browser_click', 'browser_type', 'browser_extract', 'browser_scroll', 'browser_screenshot',
];

export async function runYtdlpPipeline(
  query: string,
  options: YtdlpPipelineOptions,
): Promise<YtdlpResult> {
  const { client, apiKey, onProgress, onRegisterCancel } = options;

  // Create a fresh client using the same provider — never mutate the passed-in client
  const modelId = resolveModelForProvider(client.provider, 'sonnet');
  const ytdlpClient = createProviderClient(client.provider, apiKey, modelId);

  // Private abort controller
  const abortController = new AbortController();
  onRegisterCancel(() => abortController.abort());

  // Get tool schemas for Extractor tool set
  const allTools = getToolsForGroup('browser');
  const shellTools = getToolsForGroup('core').filter(t => t.name === 'shell_exec');
  const extractorToolSchemas = [...shellTools, ...allTools].filter(t =>
    EXTRACTOR_TOOLS.includes(t.name)
  );

  const messages: NormalizedMessage[] = [
    { role: 'user', content: query },
  ];

  const files: string[] = [];
  const startMs = Date.now();

  onProgress('[Extractor] Starting video download agent...');

  for (let iteration = 0; iteration < YTDLP_MAX_ITERATIONS; iteration++) {
    if (abortController.signal.aborted) {
      onProgress('[Extractor] Cancelled.');
      return { success: files.length > 0, files, reason: 'cancelled' };
    }
    if (Date.now() - startMs > YTDLP_MAX_MS) {
      onProgress('[Extractor] Timed out after 10 minutes.');
      return { success: false, files, reason: 'timed out' };
    }

    let response;
    try {
      response = await ytdlpClient.chat(
        [{ role: 'system' as const, content: YTDLP_SYSTEM_PROMPT }, ...messages] as any,
        extractorToolSchemas,
        { signal: abortController.signal },
      );
    } catch (err: any) {
      if (abortController.signal.aborted) {
        return { success: files.length > 0, files, reason: 'cancelled' };
      }
      return { success: false, files, reason: `LLM error: ${err.message}` };
    }

    // Collect assistant message content
    const assistantContent: Array<NormalizedTextBlock | NormalizedToolUseBlock> = [];
    let textOutput = '';

    for (const block of response.content) {
      assistantContent.push(block);
      if (block.type === 'text') {
        textOutput += block.text;
        onProgress(block.text);
      }
    }

    messages.push({ role: 'assistant', content: assistantContent });

    // Parse sentinels from this iteration's text
    const newFiles = parseExtractorSentinels(textOutput);
    for (const f of newFiles) {
      if (!files.includes(f)) files.push(f);
    }

    // If no tool calls, the agent is done
    const toolUseBlocks = assistantContent.filter(
      (b): b is NormalizedToolUseBlock => b.type === 'tool_use'
    );

    if (toolUseBlocks.length === 0) {
      // Agent finished — check if we have files
      return {
        success: files.length > 0,
        files,
        reason: files.length === 0 ? 'no files downloaded' : undefined,
      };
    }

    // Dispatch tool calls
    const toolResults: NormalizedToolResultBlock[] = [];
    for (const toolCall of toolUseBlocks) {
      if (abortController.signal.aborted) break;
      try {
        const result = await executeTool(toolCall.name, toolCall.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      } catch (err: any) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: `Error: ${err.message}`,
          is_error: true,
        });
      }
    }

    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults });
    }
  }

  return { success: false, files, reason: 'iteration limit reached' };
}
```

- [ ] **Step 4: Run the helper tests**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx jest tests/agent/loop-ytdlp.test.ts --no-coverage 2>&1 | tail -20
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit 2>&1 | head -30
```

Fix any type errors before continuing. Common issues:
- `client.provider` — verify `ProviderClient` interface has a `.provider` field; if not, check `provider/base.ts` and use the correct property name
- `ytdlpClient.chat(...)` signature — look at how `loop-harness.ts` calls `client.chat()` and match that pattern exactly

- [ ] **Step 6: Commit**

```bash
cd /home/dp/Desktop/clawdia4.0 && git add src/main/agent/loop-ytdlp.ts tests/agent/loop-ytdlp.test.ts && git commit -m "feat: add loop-ytdlp nested agent loop with sentinel parsing"
```

---

## Task 6: Wire `loop.ts` — short-circuit + cancel + suggestion

**Files:**
- Modify: `src/main/agent/loop.ts`

> **Context:** Three changes needed:
> 1. Import `registerNestedCancel` and `clearNestedCancel` from `./loop-cancel` (currently only `fireNestedCancel` is imported)
> 2. Insert ytdlp short-circuit block BEFORE the `if (profile.toolGroup === 'browser')` check at line 338
> 3. Add `clearNestedCancel()` call immediately after `cleanupRunControl(runKey)` at the bottom of `runAgentLoop` (line ~901)
> 4. Add suggestion behavior before `onStreamEnd()` at the end of the main loop

- [ ] **Step 1: Update the `loop-cancel` import**

Find in `loop.ts`:
```typescript
import { fireNestedCancel } from './loop-cancel';
```

Replace with:
```typescript
import { fireNestedCancel, registerNestedCancel, clearNestedCancel } from './loop-cancel';
```

- [ ] **Step 2: Add the `loop-ytdlp` import at the top of the file**

Add after the existing `loop-harness` import line (or after the loop-cancel import):
```typescript
import { runYtdlpPipeline, type YtdlpResult } from './loop-ytdlp';
```

- [ ] **Step 3: Insert ytdlp short-circuit before the bloodhound block**

Find this exact block at line 338:
```typescript
  if (profile.toolGroup === 'browser') {
    const executorRun = await executeSavedBloodhoundPlaybook(userMessage, getCurrentUrl() || undefined);
```

Insert the following IMMEDIATELY BEFORE that block:

```typescript
  // ── Extractor agent short-circuit ──
  if (profile.agentProfile === 'ytdlp') {
    if (!client.supportsHarnessGeneration) {
      options.onStreamText?.('Extractor requires a provider that supports nested agent loops (Anthropic). Switch providers to use it.');
      options.onStreamEnd?.();
      cleanupRunControl(runKey);
      return { response: '', toolCalls: [] };
    }
    let ytdlpResult: YtdlpResult;
    try {
      ytdlpResult = await runYtdlpPipeline(userMessage, {
        client,
        apiKey: options.apiKey,
        onProgress: (text) => options.onStreamText?.(text),
        onRegisterCancel: registerNestedCancel,
      });
    } finally {
      clearNestedCancel();
    }
    const summary = ytdlpResult.success
      ? `Downloaded ${ytdlpResult.files.length} file(s):\n${ytdlpResult.files.join('\n')}`
      : `Extractor failed: ${ytdlpResult.reason}`;
    options.onStreamText?.(summary);
    options.onStreamEnd?.();
    cleanupRunControl(runKey);
    return { response: summary, toolCalls: [] };
  }

```

- [ ] **Step 4: Add `clearNestedCancel()` after the final `cleanupRunControl`**

Find the final return of `runAgentLoop`:
```typescript
  // Clean up
  cleanupRunControl(runKey);

  return { response: finalText, toolCalls: dispatchCtx.allToolCalls };
```

Change to:
```typescript
  // Clean up
  cleanupRunControl(runKey);
  clearNestedCancel();  // guard: clears any registered nested cancel fn on all exit paths

  return { response: finalText, toolCalls: dispatchCtx.allToolCalls };
```

- [ ] **Step 5: Add ytdlp suggestion behavior**

Find where `finalText` is assembled just before the final `onStreamEnd()` call. The pattern to look for is where text accumulation ends and `onStreamEnd` is about to be called. Add the suggestion flag at the top of `runAgentLoop` (in the variable declarations area near the top of the function body):

```typescript
  const YTDLP_SUGGEST_RE = /\b(video|youtube|download|clip|watch|stream|vimeo|twitch)\b/i;
  let ytdlpSuggested = false;
```

Then, find the location just before `options.onStreamEnd?.()` is called at the end of the main loop. Immediately before that `onStreamEnd` call, add:

```typescript
  if (!ytdlpSuggested && YTDLP_SUGGEST_RE.test(finalText) && profile.agentProfile !== 'ytdlp') {
    ytdlpSuggested = true;
    const hint = '\n\nI have an Extractor agent that can find and download videos automatically — type `/extractor` or ask me to use it.';
    options.onStreamText?.(hint);
    finalText += hint;
  }
```

> Note: You need to read `loop.ts` from line 700 onward to find exactly where `onStreamEnd` is called at the natural loop exit. Search for `onStreamEnd?.()` and identify the one that's NOT inside the early-return blocks.

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit 2>&1 | head -30
```

Fix any errors. If `client.supportsHarnessGeneration` doesn't exist on `ProviderClient`, check `src/main/agent/provider/base.ts` for the actual property name and use that.

- [ ] **Step 7: Run all tests**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx jest --no-coverage 2>&1 | tail -30
```

Expected: all existing tests still pass, new tests pass.

- [ ] **Step 8: Commit**

```bash
cd /home/dp/Desktop/clawdia4.0 && git add src/main/agent/loop.ts && git commit -m "feat: wire ytdlp short-circuit, cancel cleanup, and suggestion hint in loop.ts"
```

---

## Task 7: Pre-flight check for yt-dlp not installed

**Files:**
- Modify: `src/main/agent/loop-ytdlp.ts`

> **Context:** Before starting the LLM loop, check that yt-dlp is installed. Use a quick `which yt-dlp` shell call. If it fails, return early with a helpful message rather than letting the LLM discover the error after several tool calls.

- [ ] **Step 1: Write the failing test**

Add to `tests/agent/loop-ytdlp.test.ts`:

```typescript
import { checkYtdlpInstalled } from '../../../src/main/agent/loop-ytdlp';

describe('checkYtdlpInstalled', () => {
  test('returns false when yt-dlp not found', async () => {
    // We can't guarantee yt-dlp is installed in test env — mock shell_exec
    // This tests the function contract, not the real shell
    const result = await checkYtdlpInstalled(() => Promise.reject(new Error('not found')));
    expect(result).toBe(false);
  });

  test('returns true when yt-dlp found', async () => {
    const result = await checkYtdlpInstalled(() => Promise.resolve('/usr/bin/yt-dlp'));
    expect(result).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx jest tests/agent/loop-ytdlp.test.ts --no-coverage 2>&1 | tail -20
```

- [ ] **Step 3: Export `checkYtdlpInstalled` from `loop-ytdlp.ts`**

Add this function near the top of the file, before `runYtdlpPipeline`:

```typescript
/** Exported for testing — checks that yt-dlp is available. */
export async function checkYtdlpInstalled(
  exec: (cmd: string) => Promise<string> = defaultExec,
): Promise<boolean> {
  try {
    await exec('which yt-dlp');
    return true;
  } catch {
    return false;
  }
}

async function defaultExec(cmd: string): Promise<string> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);
  const { stdout } = await execAsync(cmd, { timeout: 5000 });
  return stdout.trim();
}
```

At the start of `runYtdlpPipeline`, add the pre-flight check:

```typescript
  // Pre-flight: verify yt-dlp is installed
  const ytdlpInstalled = await checkYtdlpInstalled();
  if (!ytdlpInstalled) {
    onProgress('[Extractor] yt-dlp is not installed. Install it with: pip install yt-dlp (or: sudo apt install yt-dlp)');
    return { success: false, files: [], reason: 'yt-dlp not installed' };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx jest tests/agent/loop-ytdlp.test.ts --no-coverage 2>&1 | tail -20
```

Expected: all tests PASS.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 6: Commit**

```bash
cd /home/dp/Desktop/clawdia4.0 && git add src/main/agent/loop-ytdlp.ts tests/agent/loop-ytdlp.test.ts && git commit -m "feat: add yt-dlp pre-flight check with testable injection interface"
```

---

## Task 8: Final integration check

- [ ] **Step 1: Run the full test suite**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx jest --no-coverage 2>&1 | tail -40
```

Expected: all tests pass. If any fail, fix before proceeding.

- [ ] **Step 2: Verify TypeScript compiles clean**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit 2>&1
```

Expected: no output (zero errors).

- [ ] **Step 3: Smoke test the classifier end-to-end**

```bash
cd /home/dp/Desktop/clawdia4.0 && node -e "
const { classify } = require('./src/main/agent/classifier');
console.log(classify('download https://youtube.com/watch?v=abc'));
console.log(classify('/extractor some video'));
"
```

Expected: first call returns `agentProfile: 'ytdlp'`. Second is handled by `parseManualAgentProfileOverride` in `loop.ts` before classify is called — so this tests the classifier only; the slash command path is in `agent-profile-override.ts`.

- [ ] **Step 4: Final commit if any loose changes**

```bash
cd /home/dp/Desktop/clawdia4.0 && git status
```

Commit any uncommitted files before closing out.
