import { describe, it, expect } from 'vitest';
import type { NormalizedMessage } from '../../../src/main/agent/client';

// We test the toOpenAIMessages and SSE boundary logic in isolation.
// These functions are private in openai-adapter.ts, so we replicate them
// here to test the algorithm.

// ── Current (buggy) toOpenAIMessages for the mixed-content case ──────────────

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_call_id?: string;
}

function stringifyContent(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block: any) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'image') return `[image:${block.source?.media_type}]`;
    return '';
  }).join('\n');
}

function toOpenAIMessagesBuggy(messages: NormalizedMessage[]): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = [];
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (msg.role === 'assistant') continue; // simplified for test
    const toolResults = (msg.content as any[]).filter((b: any) => b.type === 'tool_result');
    if (toolResults.length > 0) {
      for (const block of toolResults) {
        out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: stringifyContent(block.content) });
      }
      continue; // BUG: skips text blocks
    }
    const text = (msg.content as any[]).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    out.push({ role: 'user', content: text });
  }
  return out;
}

function toOpenAIMessagesFixed(messages: NormalizedMessage[]): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = [];
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (msg.role === 'assistant') continue; // simplified for test
    const toolResults = (msg.content as any[]).filter((b: any) => b.type === 'tool_result');
    const textBlocks = (msg.content as any[]).filter((b: any) => b.type === 'text');
    if (toolResults.length > 0) {
      for (const block of toolResults) {
        out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: stringifyContent(block.content) });
      }
      // FIX: also emit text blocks — do NOT drop them
      if (textBlocks.length > 0) {
        const text = textBlocks.map((b: any) => b.text).join('');
        if (text) out.push({ role: 'user', content: text });
      }
      continue;
    }
    const text = textBlocks.map((b: any) => b.text).join('');
    out.push({ role: 'user', content: text });
  }
  return out;
}

// ── SSE boundary detection ───────────────────────────────────────────────────

function findBoundaryBuggy(buffer: string): number {
  return buffer.indexOf('\n\n');
}

function findBoundaryFixed(buffer: string): number {
  return buffer.search(/\r?\n\r?\n/);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('OpenAI toOpenAIMessages — mixed user content', () => {
  it('pure tool_result user message — same behavior in both', () => {
    const messages: NormalizedMessage[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tid-1', content: 'output' }],
      },
    ];
    const buggy = toOpenAIMessagesBuggy(messages);
    const fixed = toOpenAIMessagesFixed(messages);
    expect(buggy).toHaveLength(1);
    expect(fixed).toHaveLength(1);
    expect(fixed[0].role).toBe('tool');
  });

  it('mixed tool_result + text user message — buggy drops text, fixed preserves it', () => {
    const messages: NormalizedMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tid-1', content: 'cmd output' },
          { type: 'text', text: 'follow-up question here' },
        ],
      },
    ];
    const buggy = toOpenAIMessagesBuggy(messages);
    const fixed = toOpenAIMessagesFixed(messages);

    // Buggy: only the tool message, text is lost
    expect(buggy).toHaveLength(1);
    expect(buggy[0].role).toBe('tool');

    // Fixed: tool message + user text message
    expect(fixed).toHaveLength(2);
    expect(fixed[0].role).toBe('tool');
    expect(fixed[1].role).toBe('user');
    expect(fixed[1].content).toBe('follow-up question here');
  });

  it('pure text user message — both implementations agree', () => {
    const messages: NormalizedMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ];
    const buggy = toOpenAIMessagesBuggy(messages);
    const fixed = toOpenAIMessagesFixed(messages);
    expect(buggy).toHaveLength(1);
    expect(fixed).toHaveLength(1);
    expect(fixed[0].content).toBe('hello');
  });
});

describe('OpenAI SSE boundary detection', () => {
  it('LF-only boundary detected by both', () => {
    const buf = 'data: {"x":1}\n\ndata: {"x":2}\n\n';
    expect(findBoundaryBuggy(buf)).toBe(13);
    expect(findBoundaryFixed(buf)).toBe(13);
  });

  it('CRLF boundary NOT detected by buggy, detected by fixed', () => {
    const buf = 'data: {"x":1}\r\n\r\ndata: {"x":2}\r\n\r\n';
    expect(findBoundaryBuggy(buf)).toBe(-1);
    expect(findBoundaryFixed(buf)).toBeGreaterThan(-1);
  });

  it('mixed CRLF detected by fixed', () => {
    const buf = 'data: {"x":1}\r\n\ndata: {"x":2}';
    expect(findBoundaryFixed(buf)).toBeGreaterThan(-1);
  });
});
