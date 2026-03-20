import { describe, it, expect } from 'vitest';

// We test the tool-call accumulation logic in isolation by replicating the
// streaming loop algorithm. The real GeminiProviderClient makes live HTTP calls;
// we test the accumulation algorithm directly.

interface FunctionCallPart {
  functionCall: {
    id?: string;
    name: string;
    args?: Record<string, any>;
  };
}

interface TextPart {
  text: string;
}

type Part = FunctionCallPart | TextPart;

interface Chunk {
  parts: Part[];
}

// ── Buggy accumulator (current implementation before fix) ───────────────────

function accumulateBuggy(chunks: Chunk[]): Map<number, { id: string; name: string; args: Record<string, any> }> {
  const toolCalls = new Map<number, { id: string; name: string; args: Record<string, any> }>();
  chunks.forEach((chunk) => {
    chunk.parts.forEach((part, index) => {
      if ('functionCall' in part) {
        toolCalls.set(index, {
          id: part.functionCall.id || `${part.functionCall.name}-${index}`,
          name: part.functionCall.name,
          args: part.functionCall.args || {},
        });
      }
    });
  });
  return toolCalls;
}

// ── Fixed accumulator (what gemini-adapter.ts should do after fix) ───────────

function accumulateFixed(chunks: Chunk[]): Array<{ id: string; name: string; args: Record<string, any> }> {
  const toolCalls: Array<{ id: string; name: string; args: Record<string, any> }> = [];
  let callCount = 0; // Monotonically increasing across ALL chunks
  for (const chunk of chunks) {
    for (const part of chunk.parts) {
      if ('functionCall' in part) {
        const stableId = part.functionCall.id || `call:${callCount}`;
        toolCalls.push({
          id: stableId,
          name: part.functionCall.name,
          args: part.functionCall.args || {},
        });
        callCount++;
      }
    }
  }
  return toolCalls;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Gemini tool-call accumulation', () => {
  it('single chunk with one tool call — both implementations agree', () => {
    const chunks: Chunk[] = [
      { parts: [{ functionCall: { name: 'file_read', args: { path: '/a' } } }] },
    ];
    const buggy = accumulateBuggy(chunks);
    const fixed = accumulateFixed(chunks);
    expect(buggy.size).toBe(1);
    expect(fixed).toHaveLength(1);
    expect(fixed[0].name).toBe('file_read');
  });

  it('single chunk with two tool calls — both implementations agree', () => {
    const chunks: Chunk[] = [
      {
        parts: [
          { functionCall: { name: 'file_read', args: { path: '/a' } } },
          { functionCall: { name: 'file_read', args: { path: '/b' } } },
        ],
      },
    ];
    const buggy = accumulateBuggy(chunks);
    const fixed = accumulateFixed(chunks);
    expect(buggy.size).toBe(2);
    expect(fixed).toHaveLength(2);
  });

  it('two chunks each with one tool call — buggy OVERWRITES, fixed PRESERVES both', () => {
    // Chunk 1: file_read at forEach index 0
    // Chunk 2: file_write at forEach index 0
    // Buggy: file_write overwrites file_read (same Map key = 0)
    // Fixed: both preserved in order
    const chunks: Chunk[] = [
      { parts: [{ functionCall: { name: 'file_read', args: { path: '/a' } } }] },
      { parts: [{ functionCall: { name: 'file_write', args: { path: '/b', content: 'x' } } }] },
    ];
    const buggy = accumulateBuggy(chunks);
    const fixed = accumulateFixed(chunks);

    // Buggy: only 1 entry — file_read was silently LOST
    expect(buggy.size).toBe(1);
    expect(buggy.get(0)!.name).toBe('file_write');

    // Fixed: both preserved
    expect(fixed).toHaveLength(2);
    expect(fixed[0].name).toBe('file_read');
    expect(fixed[1].name).toBe('file_write');
  });

  it('uses provider-supplied ID when available', () => {
    const chunks: Chunk[] = [
      { parts: [{ functionCall: { id: 'gemini-tool-abc123', name: 'shell_exec', args: {} } }] },
    ];
    const fixed = accumulateFixed(chunks);
    expect(fixed[0].id).toBe('gemini-tool-abc123');
  });

  it('generates stable synthetic IDs across chunks when no provider ID', () => {
    const chunks: Chunk[] = [
      { parts: [{ functionCall: { name: 'file_read', args: {} } }] },
      { parts: [{ functionCall: { name: 'file_write', args: {} } }] },
    ];
    const fixed = accumulateFixed(chunks);
    expect(fixed[0].id).toBe('call:0');
    expect(fixed[1].id).toBe('call:1');
  });

  it('three chunks — all tool calls preserved in order', () => {
    const chunks: Chunk[] = [
      { parts: [{ functionCall: { name: 'tool_a', args: {} } }] },
      { parts: [{ functionCall: { name: 'tool_b', args: {} } }] },
      { parts: [{ functionCall: { name: 'tool_c', args: {} } }] },
    ];
    const fixed = accumulateFixed(chunks);
    expect(fixed).toHaveLength(3);
    expect(fixed.map(t => t.name)).toEqual(['tool_a', 'tool_b', 'tool_c']);
  });

  it('mixed text and function call parts in same chunk', () => {
    const chunks: Chunk[] = [
      {
        parts: [
          { text: 'Let me read the file.' },
          { functionCall: { name: 'file_read', args: { path: '/x' } } },
        ],
      },
    ];
    const fixed = accumulateFixed(chunks);
    expect(fixed).toHaveLength(1);
    expect(fixed[0].name).toBe('file_read');
  });
});
