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

  it('includes system awareness context when provided', () => {
    const prompt = buildDynamicPrompt({
      model: 'test-model',
      toolGroup: 'full',
      systemAwarenessContext: '[SYSTEM AWARENESS]\n- Max runtime per run is 10 minutes.',
    });
    expect(prompt).toContain('[SYSTEM AWARENESS]');
    expect(prompt).toContain('Max runtime per run is 10 minutes.');
  });

  it('includes harness directive context when provided', () => {
    const prompt = buildDynamicPrompt({
      model: 'test-model',
      toolGroup: 'full',
      harnessDirectiveContext: '[HARNESS]\nid=research\nactual_mode=step_controlled',
    });
    expect(prompt).toContain('[HARNESS]');
    expect(prompt).toContain('id=research');
    expect(prompt).toContain('actual_mode=step_controlled');
  });

  it('does not inject a hardcoded workspace root by default', () => {
    const prompt = buildDynamicPrompt({
      model: 'test-model',
      toolGroup: 'full',
    });
    expect(prompt).not.toContain('PRIMARY PROJECT ROOT');
    expect(prompt).toContain('no workspace root is being injected');
    expect(prompt).not.toContain('clawdia4.0');
  });

  it('injects runtime workspace context only when explicitly provided', () => {
    const prompt = buildDynamicPrompt({
      model: 'test-model',
      toolGroup: 'full',
      projectRoot: '/tmp/example-workspace',
    });
    expect(prompt).toContain('WORKSPACE ROOT: /tmp/example-workspace');
    expect(prompt).toContain('WORKSPACE SOURCE: /tmp/example-workspace/src');
  });
});
