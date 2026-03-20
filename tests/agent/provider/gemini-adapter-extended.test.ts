import { describe, it, expect, vi } from 'vitest';
import {
  toGeminiContents,
  toGeminiTools,
  stringifyToolResultContent,
  maybeJson,
  buildToolNameIndex,
} from '../../../src/main/agent/provider/gemini-adapter';
import type { NormalizedMessage, NormalizedToolDefinition } from '../../../src/main/agent/client';

// ── maybeJson ─────────────────────────────────────────────────────────────────

describe('maybeJson', () => {
  it('parses valid JSON', () => {
    expect(maybeJson('{"key":"val"}')).toEqual({ key: 'val' });
  });

  it('wraps plain string in result object', () => {
    expect(maybeJson('plain text')).toEqual({ result: 'plain text' });
  });

  it('parses JSON array', () => {
    expect(maybeJson('[1,2,3]')).toEqual([1, 2, 3]);
  });
});

// ── buildToolNameIndex ────────────────────────────────────────────────────────

describe('buildToolNameIndex', () => {
  it('indexes tool_use id → name from assistant messages', () => {
    const messages: NormalizedMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call-1', name: 'file_read', input: {} },
          { type: 'tool_use', id: 'call-2', name: 'shell_exec', input: {} },
        ],
      },
    ];
    const index = buildToolNameIndex(messages);
    expect(index.get('call-1')).toBe('file_read');
    expect(index.get('call-2')).toBe('shell_exec');
  });

  it('ignores non-assistant messages', () => {
    const messages: NormalizedMessage[] = [
      { role: 'user', content: 'hello' },
    ];
    const index = buildToolNameIndex(messages);
    expect(index.size).toBe(0);
  });

  it('accumulates tool names across multiple assistant messages', () => {
    const messages: NormalizedMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'tool_a', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'tool_b', input: {} }] },
    ];
    const index = buildToolNameIndex(messages);
    expect(index.get('a')).toBe('tool_a');
    expect(index.get('b')).toBe('tool_b');
  });
});

// ── toGeminiContents ──────────────────────────────────────────────────────────

describe('toGeminiContents — string messages', () => {
  it('user string message maps to role=user', () => {
    const out = toGeminiContents([{ role: 'user', content: 'hello' }]);
    expect(out[0].role).toBe('user');
    expect(out[0].parts).toEqual([{ text: 'hello' }]);
  });

  it('assistant string message maps to role=model', () => {
    const out = toGeminiContents([{ role: 'assistant', content: 'hi' }]);
    expect(out[0].role).toBe('model');
    expect(out[0].parts).toEqual([{ text: 'hi' }]);
  });
});

describe('toGeminiContents — assistant with tool calls', () => {
  it('serializes tool_use as functionCall part', () => {
    const messages: NormalizedMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading.' },
          { type: 'tool_use', id: 'call-1', name: 'file_read', input: { path: '/a.txt' } },
        ],
      },
    ];
    const out = toGeminiContents(messages);
    expect(out[0].role).toBe('model');
    expect(out[0].parts).toHaveLength(2);
    expect(out[0].parts[0]).toEqual({ text: 'Reading.' });
    expect(out[0].parts[1]).toEqual({
      functionCall: { id: 'call-1', name: 'file_read', args: { path: '/a.txt' } },
    });
  });

  it('tool_use with no input defaults args to {}', () => {
    const messages: NormalizedMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'shell_exec', input: undefined as any }] },
    ];
    const out = toGeminiContents(messages);
    expect(out[0].parts[0].functionCall?.args).toEqual({});
  });
});

describe('toGeminiContents — tool results (functionResponse)', () => {
  it('tool_result maps to functionResponse with name from index', () => {
    const messages: NormalizedMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'file_read', input: {} }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '{"lines":3}' }],
      },
    ];
    const out = toGeminiContents(messages);
    const toolResultMsg = out[1];
    expect(toolResultMsg.role).toBe('user');
    expect(toolResultMsg.parts[0].functionResponse?.name).toBe('file_read');
    expect(toolResultMsg.parts[0].functionResponse?.id).toBe('call-1');
    expect(toolResultMsg.parts[0].functionResponse?.response).toEqual({ lines: 3 });
  });

  it('falls back to tool_use_id as name when id not in index', () => {
    const messages: NormalizedMessage[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'unknown-id', content: 'result' }],
      },
    ];
    const out = toGeminiContents(messages);
    expect(out[0].parts[0].functionResponse?.name).toBe('unknown-id');
  });

  it('plain string tool result wrapped via maybeJson', () => {
    const messages: NormalizedMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'shell_exec', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: 'exit 0' }] },
    ];
    const out = toGeminiContents(messages);
    expect(out[1].parts[0].functionResponse?.response).toEqual({ result: 'exit 0' });
  });

  it('image in tool result degrades to placeholder', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const messages: NormalizedMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'tool', input: {} }] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'c',
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }],
          },
        ],
      },
    ];
    const out = toGeminiContents(messages);
    const resp = out[1].parts[0].functionResponse?.response;
    expect(JSON.stringify(resp)).toContain('[image:image/png]');
    consoleSpy.mockRestore();
  });
});

describe('toGeminiContents — pure text user message', () => {
  it('text block user message maps correctly', () => {
    const messages: NormalizedMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello there' }] },
    ];
    const out = toGeminiContents(messages);
    expect(out[0].role).toBe('user');
    expect(out[0].parts).toEqual([{ text: 'hello there' }]);
  });
});

// ── toGeminiTools ─────────────────────────────────────────────────────────────

describe('toGeminiTools — schema normalization', () => {
  it('wraps all tools in a single functionDeclarations array', () => {
    const tools: NormalizedToolDefinition[] = [
      { name: 'tool_a', description: 'a', input_schema: { type: 'object' } },
      { name: 'tool_b', description: 'b', input_schema: { type: 'object' } },
    ];
    const out = toGeminiTools(tools);
    expect(out).toHaveLength(1);
    expect(out[0].functionDeclarations).toHaveLength(2);
    expect(out[0].functionDeclarations[0].name).toBe('tool_a');
    expect(out[0].functionDeclarations[1].name).toBe('tool_b');
  });

  it('removes additionalProperties (Gemini does not support it)', () => {
    const tools: NormalizedToolDefinition[] = [
      {
        name: 'tool',
        description: 'd',
        input_schema: { type: 'object', additionalProperties: true },
      },
    ];
    const out = toGeminiTools(tools);
    expect(out[0].functionDeclarations[0].parameters.additionalProperties).toBeUndefined();
  });

  it('array without items gets items: { type: string } (Gemini default)', () => {
    const tools: NormalizedToolDefinition[] = [
      {
        name: 'tool',
        description: 'd',
        input_schema: {
          type: 'object',
          properties: { tags: { type: 'array' } },
        },
      },
    ];
    const out = toGeminiTools(tools);
    expect(out[0].functionDeclarations[0].parameters.properties.tags.items).toEqual({ type: 'string' });
  });

  it('array with existing items is not modified', () => {
    const tools: NormalizedToolDefinition[] = [
      {
        name: 'tool',
        description: 'd',
        input_schema: {
          type: 'object',
          properties: { ids: { type: 'array', items: { type: 'integer' } } },
        },
      },
    ];
    const out = toGeminiTools(tools);
    expect(out[0].functionDeclarations[0].parameters.properties.ids.items).toEqual({ type: 'integer' });
  });

  it('normalizes nested properties recursively, stripping additionalProperties', () => {
    const tools: NormalizedToolDefinition[] = [
      {
        name: 'tool',
        description: 'd',
        input_schema: {
          type: 'object',
          properties: {
            nested: {
              type: 'object',
              additionalProperties: false,
              properties: { val: { type: 'string' } },
            },
          },
        },
      },
    ];
    const out = toGeminiTools(tools);
    const nested = out[0].functionDeclarations[0].parameters.properties.nested;
    expect(nested.additionalProperties).toBeUndefined();
    expect(nested.properties.val).toEqual({ type: 'string' });
  });
});

// ── stringifyToolResultContent ────────────────────────────────────────────────

describe('stringifyToolResultContent (Gemini)', () => {
  it('string passes through unchanged', () => {
    expect(stringifyToolResultContent('output')).toBe('output');
  });

  it('text block array joined with newline', () => {
    expect(stringifyToolResultContent([
      { type: 'text', text: 'line 1' },
      { type: 'text', text: 'line 2' },
    ])).toBe('line 1\nline 2');
  });

  it('image block degrades to placeholder with warning', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = stringifyToolResultContent([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '' } },
    ]);
    expect(result).toBe('[image:image/jpeg]');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[Gemini]'));
    consoleSpy.mockRestore();
  });
});
