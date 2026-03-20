import { describe, it, expect } from 'vitest';

// We test the trimHistory logic. Because trimHistory is not exported,
// we replicate its logic here to unit test the algorithm in isolation.
// The real test: after trimming, no user message at position 0 should
// contain ONLY tool_result blocks with no paired assistant turn.

import type { NormalizedMessage } from '../../src/main/agent/client';

// Mirrors the constants in loop.ts
const MAX_HISTORY_TURNS = 16;
const MAX_HISTORY_TOKENS = 80_000;

function estimateTokens(msg: NormalizedMessage): number {
  if (typeof msg.content === 'string') return Math.ceil(msg.content.length / 4);
  if (Array.isArray(msg.content)) {
    let total = 0;
    for (const block of msg.content as any[]) {
      if (block.type === 'text') total += Math.ceil((block.text?.length || 0) / 4);
      else if (block.type === 'tool_use') total += Math.ceil(JSON.stringify(block.input || {}).length / 4) + 20;
      else if (block.type === 'tool_result') total += Math.ceil((typeof block.content === 'string' ? block.content.length : JSON.stringify(block.content || '').length) / 4);
      else total += 50;
    }
    return total;
  }
  return 50;
}

function hasToolResults(msg: NormalizedMessage): boolean {
  if (!Array.isArray(msg.content)) return false;
  return (msg.content as any[]).some((b: any) => b.type === 'tool_result');
}

function hasOnlyToolResults(msg: NormalizedMessage): boolean {
  if (!Array.isArray(msg.content)) return false;
  return (msg.content as any[]).every((b: any) => b.type === 'tool_result');
}

// Current (buggy) implementation — used to demonstrate the failure
function trimHistoryBuggy(history: NormalizedMessage[]): NormalizedMessage[] {
  let trimmed = history.length > MAX_HISTORY_TURNS
    ? history.slice(-MAX_HISTORY_TURNS) : [...history];
  let totalTokens = trimmed.reduce((sum, m) => sum + estimateTokens(m), 0);
  while (totalTokens > MAX_HISTORY_TOKENS && trimmed.length > 2) {
    const dropped = trimmed.shift()!;
    totalTokens -= estimateTokens(dropped);
  }
  if (trimmed.length > 0 && trimmed[0].role === 'assistant') trimmed.shift();
  return trimmed;
}

// Fixed implementation — what loop.ts should do after the fix
function trimHistoryFixed(history: NormalizedMessage[]): NormalizedMessage[] {
  let trimmed = history.length > MAX_HISTORY_TURNS
    ? history.slice(-MAX_HISTORY_TURNS) : [...history];
  let totalTokens = trimmed.reduce((sum, m) => sum + estimateTokens(m), 0);
  while (totalTokens > MAX_HISTORY_TOKENS && trimmed.length > 2) {
    const dropped = trimmed.shift()!;
    totalTokens -= estimateTokens(dropped);
  }
  // Drop any leading assistant turn (can't start history with assistant)
  if (trimmed.length > 0 && trimmed[0].role === 'assistant') trimmed.shift();
  // Drop any leading user turns that are ONLY tool_results — their paired
  // assistant tool_use blocks were trimmed above, leaving orphaned IDs.
  // Use .every() not .some() — messages with mixed text+tool_results are preserved.
  while (trimmed.length > 0 && trimmed[0].role === 'user' && hasOnlyToolResults(trimmed[0])) {
    totalTokens -= estimateTokens(trimmed[0]);
    trimmed.shift();
    // The next message may now be an assistant turn at position 0 — drop it too
    if (trimmed.length > 0 && trimmed[0].role === 'assistant') {
      totalTokens -= estimateTokens(trimmed[0]);
      trimmed.shift();
    }
  }
  return trimmed;
}

function makeUserText(text: string): NormalizedMessage {
  return { role: 'user', content: text };
}

function makeAssistantText(text: string): NormalizedMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function makeAssistantWithToolUse(toolId: string, toolName: string): NormalizedMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Using tool...' },
      { type: 'tool_use', id: toolId, name: toolName, input: {} },
    ],
  };
}

function makeToolResult(toolId: string): NormalizedMessage {
  return {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: toolId, content: 'result text' },
    ],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('trimHistory — pair preservation', () => {
  it('returns empty array for empty input', () => {
    expect(trimHistoryFixed([])).toEqual([]);
  });

  it('does not trim a short conversation', () => {
    const history: NormalizedMessage[] = [
      makeUserText('hello'),
      makeAssistantText('hi'),
    ];
    expect(trimHistoryFixed(history)).toHaveLength(2);
  });

  it('buggy version can produce orphaned tool_result at position 0', () => {
    const history: NormalizedMessage[] = [
      makeUserText('initial'),
      makeAssistantWithToolUse('tool-1', 'file_read'),
      makeToolResult('tool-1'),
      ...Array.from({ length: 14 }, (_, i) => makeUserText(`msg ${i}`)),
    ];
    // 17 messages > MAX_HISTORY_TURNS (16) → first sliced off
    // → assistant at [0] → leading-assistant-drop → tool_result at [0] = orphaned
    const buggyResult = trimHistoryBuggy(history);
    const firstIsOrphanedToolResult =
      buggyResult.length > 0 &&
      buggyResult[0].role === 'user' &&
      Array.isArray(buggyResult[0].content) &&
      (buggyResult[0].content as any[]).some((b: any) => b.type === 'tool_result');
    expect(firstIsOrphanedToolResult).toBe(true);
  });

  it('fixed version never leaves an orphaned tool_result at position 0', () => {
    const history: NormalizedMessage[] = [
      makeUserText('initial'),
      makeAssistantWithToolUse('tool-1', 'file_read'),
      makeToolResult('tool-1'),
      ...Array.from({ length: 14 }, (_, i) => makeUserText(`msg ${i}`)),
    ];
    const result = trimHistoryFixed(history);
    const firstIsOrphanedToolResult =
      result.length > 0 &&
      result[0].role === 'user' &&
      Array.isArray(result[0].content) &&
      (result[0].content as any[]).some((b: any) => b.type === 'tool_result');
    expect(firstIsOrphanedToolResult).toBe(false);
  });

  it('fixed version preserves intact tool_use+tool_result pairs in the middle', () => {
    const history: NormalizedMessage[] = [
      makeUserText('task'),
      makeAssistantWithToolUse('t1', 'file_read'),
      makeToolResult('t1'),
      makeAssistantWithToolUse('t2', 'file_write'),
      makeToolResult('t2'),
      makeAssistantText('done'),
    ];
    const result = trimHistoryFixed(history);
    expect(result).toHaveLength(6);
    expect(result[0].role).toBe('user');
    const hasOrphan = Array.isArray(result[0].content) &&
      (result[0].content as any[]).some((b: any) => b.type === 'tool_result');
    expect(hasOrphan).toBe(false);
  });

  it('drops multiple orphaned pairs when trimming deeply', () => {
    const history: NormalizedMessage[] = [
      makeUserText('start'),
      makeAssistantWithToolUse('t1', 'file_read'),
      makeToolResult('t1'),
      makeAssistantWithToolUse('t2', 'file_read'),
      makeToolResult('t2'),
      ...Array.from({ length: 12 }, (_, i) => makeUserText(`filler ${i}`)),
    ];
    const result = trimHistoryFixed(history);
    if (result.length > 0) {
      const firstHasToolResult =
        Array.isArray(result[0].content) &&
        (result[0].content as any[]).some((b: any) => b.type === 'tool_result');
      expect(firstHasToolResult).toBe(false);
    }
  });

  it('does not drop a user message that has both text and tool_results (mixed content)', () => {
    const mixedContent = [
      { type: 'tool_result', tool_use_id: 't1', content: 'output' },
      { type: 'text', text: 'and here is my follow-up question' },
    ];
    const history: NormalizedMessage[] = [
      makeUserText('initial'),
      makeAssistantWithToolUse('t1', 'shell_exec'),
      { role: 'user', content: mixedContent } as NormalizedMessage,
      ...Array.from({ length: 14 }, (_, i) => makeUserText(`filler ${i}`)),
    ];
    // 17 messages → slice to 16, drops 'initial' → assistant(t1) at [0]
    // Leading-assistant-drop fires → mixed message at [0]
    // hasOnlyToolResults([tool_result, text]) === false → NOT dropped
    const result = trimHistoryFixed(history);
    const hasMixed = result.some(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        (m.content as any[]).some((b: any) => b.type === 'tool_result') &&
        (m.content as any[]).some((b: any) => b.type === 'text'),
    );
    expect(hasMixed).toBe(true);
  });
});
