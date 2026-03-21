import { describe, expect, it } from 'vitest';
import { buildDynamicPrompt } from '../../src/main/agent/prompt-builder';

describe('buildDynamicPrompt()', () => {
  it('includes execution graph scaffold context when provided', () => {
    const prompt = buildDynamicPrompt({
      model: 'test-model',
      toolGroup: 'full',
      executionGraphContext: '[EXECUTION GRAPH SCAFFOLD]\nSummary: demo',
    });
    expect(prompt).toContain('[EXECUTION GRAPH SCAFFOLD]');
    expect(prompt).toContain('Summary: demo');
  });
});
