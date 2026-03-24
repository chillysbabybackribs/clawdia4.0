/**
 * Bloodhound Distiller — converts raw run_events into clean SequenceStep[].
 *
 * distillSteps() is a pure function (no I/O). It pairs tool_started +
 * tool_completed/tool_failed events by payload.toolUseId and produces
 * a normalized, sanitized step array.
 *
 * distillWithLLM() is async and best-effort — callers must catch errors.
 */

import type { RunEventRecord } from '../../db/run-events';
import type { SequenceStep, Surface } from '../../db/task-sequences';
import { getApiKey } from '../../store';
import { createProviderClient } from '../provider/factory';

// ═══════════════════════════════════
// Surface mapping
// ═══════════════════════════════════

const SURFACE_PREFIXES: Array<[string, Surface]> = [
  ['browser_', 'browser'],
  ['file_', 'filesystem'],
  ['directory_', 'filesystem'],
  ['fs_', 'filesystem'],
  ['app_control', 'desktop'],
  ['gui_interact', 'desktop'],
  ['dbus_control', 'desktop'],
  ['memory_', 'memory'],
];
const SURFACE_EXACT: Record<string, Surface> = {
  shell_exec: 'shell',
  agent_spawn: 'swarm',
};

function toolToSurface(toolName: string): Surface {
  if (SURFACE_EXACT[toolName]) return SURFACE_EXACT[toolName];
  for (const [prefix, surface] of SURFACE_PREFIXES) {
    if (toolName.startsWith(prefix)) return surface;
  }
  return 'other';
}

// ═══════════════════════════════════
// Input sanitization
// ═══════════════════════════════════

const REDACT_KEYS = new Set(['password', 'token', 'api_key', 'secret', 'auth', 'cookie', 'credential']);
const REDACT_VALUE_RE = /^sk-[a-zA-Z0-9]{20,}/;

function sanitizeInput(input: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(input)) {
    if (REDACT_KEYS.has(k.toLowerCase())) {
      result[k] = '[redacted]';
    } else if (typeof v === 'string' && REDACT_VALUE_RE.test(v)) {
      result[k] = '[redacted]';
    } else {
      result[k] = v;
    }
  }
  return result;
}

// ═══════════════════════════════════
// distillSteps — pure, no I/O
// ═══════════════════════════════════

export function distillSteps(events: RunEventRecord[]): SequenceStep[] {
  const started = new Map<string, RunEventRecord>();
  for (const event of events) {
    if (event.kind === 'tool_started') {
      const toolUseId = event.payload?.toolUseId as string | undefined;
      if (toolUseId) started.set(toolUseId, event);
    }
  }

  const steps: SequenceStep[] = [];

  for (const event of events) {
    if (event.kind !== 'tool_completed' && event.kind !== 'tool_failed') continue;
    const toolUseId = event.payload?.toolUseId as string | undefined;
    if (!toolUseId) continue;

    const startEvent = started.get(toolUseId);
    if (!startEvent) continue;

    const rawInput = (startEvent.payload?.input as Record<string, any>) || {};
    const rawOutput = (event.payload?.resultPreview as string) || '';
    const durationMs = (event.payload?.durationMs as number) || 0;
    const toolName = startEvent.toolName || '';

    steps.push({
      seq: startEvent.seq,
      surface: toolToSurface(toolName),
      tool: toolName,
      input: sanitizeInput(rawInput),
      outputSummary: rawOutput.slice(0, 200),
      durationMs,
      success: event.kind === 'tool_completed',
    });
  }

  steps.sort((a, b) => a.seq - b.seq);
  steps.forEach((s, i) => { s.seq = i; });

  return steps;
}

// ═══════════════════════════════════
// distillWithLLM — async, best-effort
// ═══════════════════════════════════

export async function distillWithLLM(
  goal: string,
  steps: SequenceStep[],
): Promise<SequenceStep[]> {
  let client;
  const anthropicKey = getApiKey('anthropic');
  const geminiKey = getApiKey('gemini');

  if (anthropicKey) {
    client = createProviderClient('anthropic', anthropicKey, 'claude-haiku-4-5-20251001');
  } else if (geminiKey) {
    client = createProviderClient('gemini', geminiKey, 'gemini-2.5-flash');
  } else {
    throw new Error('No provider available for distillation');
  }

  const prompt = `You are cleaning up a recorded task sequence for storage.

Goal: "${goal}"

Steps (JSON):
${JSON.stringify(steps, null, 2)}

Return ONLY a JSON array of the same steps with:
1. Improved outputSummary (clear, under 100 chars, describes what happened)
2. Cleaned input objects (remove noise keys like timestamps, request IDs, internal metadata)
3. Same seq, surface, tool, durationMs, success values unchanged

Return only the JSON array, no markdown, no explanation.`;

  const response = await client.chat(
    [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    [],
    '',
    '',
    undefined,
    { maxTokens: 2048 },
  );

  const text = response.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');

  const parsed = JSON.parse(text.trim());
  if (!Array.isArray(parsed) || parsed.length !== steps.length) {
    throw new Error('LLM returned wrong number of steps');
  }
  return parsed as SequenceStep[];
}
