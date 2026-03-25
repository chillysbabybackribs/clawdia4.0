import { describe, it, expect, vi } from 'vitest';

// Import directly from the production adapter.
// These functions are exported for testing — if the import fails,
// the exports need to be added to openai-adapter.ts.
import {
  getOpenAIMaxTokensField,
  toOpenAIMessages,
  toOpenAITools,
  stringifyToolResultContent,
} from '../../../src/main/agent/provider/openai-adapter';
import type { NormalizedMessage, NormalizedToolDefinition } from '../../../src/main/agent/client';

// ── toOpenAIMessages — assistant with tool calls ──────────────────────────────

describe('toOpenAIMessages — assistant with tool calls', () => {
  it('serializes assistant tool_use blocks as tool_calls array', () => {
    const messages: NormalizedMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading the file.' },
          { type: 'tool_use', id: 'call-1', name: 'file_read', input: { path: '/foo.txt' } },
        ],
      },
    ];
    const out = toOpenAIMessages(messages, '');
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('assistant');
    expect(out[0].tool_calls).toHaveLength(1);
    expect(out[0].tool_calls![0].id).toBe('call-1');
    expect(out[0].tool_calls![0].function.name).toBe('file_read');
    expect(JSON.parse(out[0].tool_calls![0].function.arguments)).toEqual({ path: '/foo.txt' });
  });

  it('assistant with only text omits tool_calls key', () => {
    const messages: NormalizedMessage[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];
    const out = toOpenAIMessages(messages, '');
    expect(out[0].tool_calls).toBeUndefined();
    expect(out[0].content).toBe('done');
  });

  it('assistant with only tool_use sets content to null', () => {
    const messages: NormalizedMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-2', name: 'shell_exec', input: { cmd: 'ls' } }],
      },
    ];
    const out = toOpenAIMessages(messages, '');
    expect(out[0].content).toBeNull();
    expect(out[0].tool_calls).toHaveLength(1);
  });

  it('multiple tool_use blocks in one assistant message', () => {
    const messages: NormalizedMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call-a', name: 'file_read', input: { path: '/a' } },
          { type: 'tool_use', id: 'call-b', name: 'file_read', input: { path: '/b' } },
        ],
      },
    ];
    const out = toOpenAIMessages(messages, '');
    expect(out[0].tool_calls).toHaveLength(2);
    expect(out[0].tool_calls![0].id).toBe('call-a');
    expect(out[0].tool_calls![1].id).toBe('call-b');
  });
});

// ── toOpenAIMessages — image degradation ─────────────────────────────────────

describe('toOpenAIMessages — image degradation in tool results', () => {
  it('image block in tool result degrades to placeholder string', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const messages: NormalizedMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-1',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
            ],
          },
        ],
      },
    ];
    const out = toOpenAIMessages(messages, '');
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('tool');
    expect(out[0].content).toBe('[image:image/png]');
    consoleSpy.mockRestore();
  });

  it('mixed text+image in tool result — text preserved, image degraded', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const messages: NormalizedMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-1',
            content: [
              { type: 'text', text: 'command output' },
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'xyz' } },
            ],
          },
        ],
      },
    ];
    const out = toOpenAIMessages(messages, '');
    expect(out[0].content).toContain('command output');
    expect(out[0].content).toContain('[image:image/jpeg]');
    consoleSpy.mockRestore();
  });
});

// ── toOpenAIMessages — system prompt ─────────────────────────────────────────

describe('toOpenAIMessages — system prompt', () => {
  it('prepends system message when instructions provided', () => {
    const out = toOpenAIMessages([{ role: 'user', content: 'hi' }], 'Be helpful.');
    expect(out[0].role).toBe('system');
    expect(out[0].content).toBe('Be helpful.');
    expect(out[1].role).toBe('user');
  });

  it('omits system message when instructions empty', () => {
    const out = toOpenAIMessages([{ role: 'user', content: 'hi' }], '');
    expect(out[0].role).toBe('user');
  });
});

// ── toOpenAITools — schema normalization ─────────────────────────────────────

describe('toOpenAITools — schema normalization', () => {
  it('array type without items gets default items injected', () => {
    const tools: NormalizedToolDefinition[] = [
      {
        name: 'do_thing',
        description: 'does a thing',
        input_schema: {
          type: 'object',
          properties: { tags: { type: 'array' } },
        },
      },
    ];
    const out = toOpenAITools(tools);
    expect(out[0].function.parameters.properties.tags.items).toEqual({
      type: 'object',
      additionalProperties: true,
    });
  });

  it('array type WITH existing items is not modified', () => {
    const tools: NormalizedToolDefinition[] = [
      {
        name: 'do_thing',
        description: 'does a thing',
        input_schema: {
          type: 'object',
          properties: { ids: { type: 'array', items: { type: 'string' } } },
        },
      },
    ];
    const out = toOpenAITools(tools);
    expect(out[0].function.parameters.properties.ids.items).toEqual({ type: 'string' });
  });

  it('wraps tool in function type envelope', () => {
    const tools: NormalizedToolDefinition[] = [
      { name: 'shell_exec', description: 'run a command', input_schema: { type: 'object' } },
    ];
    const out = toOpenAITools(tools);
    expect(out[0].type).toBe('function');
    expect(out[0].function.name).toBe('shell_exec');
    expect(out[0].function.description).toBe('run a command');
  });

  it('normalizes nested array properties recursively', () => {
    const tools: NormalizedToolDefinition[] = [
      {
        name: 'complex_tool',
        description: 'complex',
        input_schema: {
          type: 'object',
          properties: {
            nested: {
              type: 'object',
              properties: { items: { type: 'array' } },
            },
          },
        },
      },
    ];
    const out = toOpenAITools(tools);
    expect(out[0].function.parameters.properties.nested.properties.items.items).toBeDefined();
  });
});

// ── stringifyToolResultContent ────────────────────────────────────────────────

describe('stringifyToolResultContent', () => {
  it('string content passes through', () => {
    expect(stringifyToolResultContent('hello')).toBe('hello');
  });

  it('text block array joined', () => {
    expect(stringifyToolResultContent([
      { type: 'text', text: 'line 1' },
      { type: 'text', text: 'line 2' },
    ])).toBe('line 1\nline 2');
  });

  it('image block degrades to placeholder', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = stringifyToolResultContent([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
    ]);
    expect(result).toBe('[image:image/png]');
    consoleSpy.mockRestore();
  });
});

describe('OpenAI supportsHarnessGeneration', () => {
  it('OpenAIProviderClient.supportsHarnessGeneration is true', async () => {
    const { OpenAIProviderClient } = await import('../../../src/main/agent/provider/openai-adapter');
    const client = new OpenAIProviderClient('test-key');
    expect(client.supportsHarnessGeneration).toBe(true);
  });
});

describe('getOpenAIMaxTokensField', () => {
  it('uses max_completion_tokens for GPT-5 family models', () => {
    expect(getOpenAIMaxTokensField('gpt-5.4')).toBe('max_completion_tokens');
    expect(getOpenAIMaxTokensField('gpt-5.4-mini')).toBe('max_completion_tokens');
    expect(getOpenAIMaxTokensField('gpt-5.4-2026-03-01')).toBe('max_completion_tokens');
  });

  it('keeps max_tokens for older chat-completions models', () => {
    expect(getOpenAIMaxTokensField('gpt-4o')).toBe('max_tokens');
    expect(getOpenAIMaxTokensField('gpt-4.1-mini')).toBe('max_tokens');
  });
});
