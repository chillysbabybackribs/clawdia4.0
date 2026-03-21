import { describe, it, expect } from 'vitest';
import { partitionIntoBatches, summarizeInput } from '../../src/main/agent/loop-dispatch';
import type { NormalizedToolUseBlock } from '../../src/main/agent/client';

function makeBlock(name: string, input: Record<string, any> = {}): NormalizedToolUseBlock {
  return { type: 'tool_use', id: `id_${name}`, name, input } as NormalizedToolUseBlock;
}

describe('partitionIntoBatches()', () => {
  it('puts independent parallel-safe tools in one batch', () => {
    const blocks = [
      makeBlock('file_read', { path: '/a' }),
      makeBlock('file_read', { path: '/b' }),
      makeBlock('memory_search', { query: 'test' }),
    ];
    const batches = partitionIntoBatches(blocks);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });

  it('isolates sequential tools (shell_exec) into their own batch', () => {
    const blocks = [
      makeBlock('file_read', { path: '/a' }),
      makeBlock('shell_exec', { command: 'ls' }),
      makeBlock('file_read', { path: '/b' }),
    ];
    const batches = partitionIntoBatches(blocks);
    expect(batches).toHaveLength(3);
    expect(batches[1][0].name).toBe('shell_exec');
  });

  it('isolates gui_interact into its own batch', () => {
    const blocks = [makeBlock('gui_interact', { action: 'screenshot' })];
    const batches = partitionIntoBatches(blocks);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
  });

  it('serializes browser stateful tools such as browser_navigate', () => {
    const blocks = [
      makeBlock('browser_navigate', { url: 'https://example.com/a' }),
      makeBlock('browser_navigate', { url: 'https://example.com/b' }),
    ];
    const batches = partitionIntoBatches(blocks);
    expect(batches).toHaveLength(2);
    expect(batches[0][0].name).toBe('browser_navigate');
    expect(batches[1][0].name).toBe('browser_navigate');
  });

  it('keeps browser_search parallel-safe', () => {
    const blocks = [
      makeBlock('browser_search', { query: 'quiet office keyboards' }),
      makeBlock('browser_search', { query: 'logitech mx keys s review' }),
    ];
    const batches = partitionIntoBatches(blocks);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it('forces batch boundary when input references previous tool name', () => {
    const blocks = [
      makeBlock('file_read', { path: '/a' }),
      makeBlock('file_edit', { path: '/a', old_str: 'file_read result', new_str: 'new' }),
    ];
    const batches = partitionIntoBatches(blocks);
    expect(batches).toHaveLength(2);
  });

  it('handles empty input', () => {
    expect(partitionIntoBatches([])).toEqual([]);
  });

  it('handles single tool', () => {
    const batches = partitionIntoBatches([makeBlock('file_read', { path: '/x' })]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
  });
});

describe('summarizeInput()', () => {
  it('returns command for shell_exec', () => {
    expect(summarizeInput('shell_exec', { command: 'ls -la' })).toBe('ls -la');
  });

  it('returns path for file_read', () => {
    expect(summarizeInput('file_read', { path: '/home/dp/file.ts' })).toBe('/home/dp/file.ts');
  });

  it('returns query string for browser_search', () => {
    expect(summarizeInput('browser_search', { query: 'vitest setup' })).toBe('"vitest setup"');
  });

  it('returns batch count for gui_interact batch_actions', () => {
    expect(summarizeInput('gui_interact', { action: 'batch_actions', actions: [1, 2, 3] })).toBe('batch (3 steps)');
  });
});
