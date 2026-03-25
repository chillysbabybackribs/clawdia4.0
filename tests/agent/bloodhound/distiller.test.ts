import { describe, it, expect } from 'vitest';
import { __testing, distillSteps } from '../../../src/main/agent/bloodhound/distiller';
import type { RunEventRecord } from '../../../src/main/db/run-events';

// Helper to build minimal RunEventRecord for tests
function makeEvent(overrides: Partial<RunEventRecord> & Pick<RunEventRecord, 'kind'>): RunEventRecord {
  return {
    id: 1,
    runId: 'run-1',
    seq: 0,
    timestamp: '2026-03-24T00:00:00.000Z',
    phase: 'dispatch',
    surface: 'browser',
    toolName: 'browser_navigate',
    payload: {},
    ...overrides,
  };
}

describe('distillSteps()', () => {
  it('returns empty array for empty events', () => {
    expect(distillSteps([])).toEqual([]);
  });

  it('returns empty array when only lifecycle events present', () => {
    const events = [
      makeEvent({ kind: 'run_started' }),
      makeEvent({ kind: 'run_classified' }),
      makeEvent({ kind: 'run_detached' }),
    ];
    expect(distillSteps(events)).toEqual([]);
  });

  it('pairs tool_started + tool_completed into one SequenceStep', () => {
    const events = [
      makeEvent({
        kind: 'tool_started',
        seq: 0,
        toolName: 'browser_navigate',
        surface: 'browser',
        payload: { toolUseId: 'tid-1', input: { url: 'https://github.com' }, ordinal: 0, detail: '' },
      }),
      makeEvent({
        kind: 'tool_completed',
        seq: 1,
        toolName: 'browser_navigate',
        surface: 'browser',
        payload: { toolUseId: 'tid-1', resultPreview: 'Navigated to github.com', durationMs: 300, detail: '' },
      }),
    ];
    const steps = distillSteps(events);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      seq: 0,
      surface: 'browser',
      tool: 'browser_navigate',
      input: { url: 'https://github.com' },
      outputSummary: 'Navigated to github.com',
      durationMs: 300,
      success: true,
    });
  });

  it('marks step success=false when closing event is tool_failed', () => {
    const events = [
      makeEvent({
        kind: 'tool_started',
        seq: 0,
        toolName: 'browser_click',
        payload: { toolUseId: 'tid-2', input: { selector: '#btn' }, ordinal: 1, detail: '' },
      }),
      makeEvent({
        kind: 'tool_failed',
        seq: 1,
        toolName: 'browser_click',
        payload: { toolUseId: 'tid-2', resultPreview: 'Element not found', durationMs: 50, detail: '' },
      }),
    ];
    const steps = distillSteps(events);
    expect(steps).toHaveLength(1);
    expect(steps[0].success).toBe(false);
    expect(steps[0].outputSummary).toBe('Element not found');
  });

  it('drops tool_started with no matching closing event', () => {
    const events = [
      makeEvent({
        kind: 'tool_started',
        seq: 0,
        payload: { toolUseId: 'tid-orphan', input: {}, ordinal: 0, detail: '' },
      }),
    ];
    expect(distillSteps(events)).toEqual([]);
  });

  it('assigns correct surface from tool name prefix', () => {
    const events = [
      makeEvent({ kind: 'tool_started', seq: 0, toolName: 'file_read', surface: 'filesystem', payload: { toolUseId: 'a', input: { path: '/tmp/f' }, ordinal: 0, detail: '' } }),
      makeEvent({ kind: 'tool_completed', seq: 1, toolName: 'file_read', surface: 'filesystem', payload: { toolUseId: 'a', resultPreview: 'content', durationMs: 10, detail: '' } }),
      makeEvent({ kind: 'tool_started', seq: 2, toolName: 'shell_exec', surface: 'shell', payload: { toolUseId: 'b', input: { command: 'ls' }, ordinal: 1, detail: '' } }),
      makeEvent({ kind: 'tool_completed', seq: 3, toolName: 'shell_exec', surface: 'shell', payload: { toolUseId: 'b', resultPreview: 'file.txt', durationMs: 20, detail: '' } }),
    ];
    const steps = distillSteps(events);
    expect(steps).toHaveLength(2);
    expect(steps[0].surface).toBe('filesystem');
    expect(steps[1].surface).toBe('shell');
  });

  it('strips sensitive keys from input before storing', () => {
    const events = [
      makeEvent({ kind: 'tool_started', seq: 0, toolName: 'browser_navigate', payload: { toolUseId: 'c', input: { url: 'https://x.com', token: 'secret123', password: 'hunter2', authorization: 'Bearer abc', apiKey: 'sk-abcdefghijklmnopqrstuvwxyz' }, ordinal: 0, detail: '' } }),
      makeEvent({ kind: 'tool_completed', seq: 1, toolName: 'browser_navigate', payload: { toolUseId: 'c', resultPreview: 'ok', durationMs: 100, detail: '' } }),
    ];
    const steps = distillSteps(events);
    expect(steps[0].input.token).toBe('[redacted]');
    expect(steps[0].input.password).toBe('[redacted]');
    expect(steps[0].input.authorization).toBe('[redacted]'); // contains 'auth'
    expect(steps[0].input.apiKey).toBe('[redacted]');       // value matches sk- pattern
    expect(steps[0].input.url).toBe('https://x.com');
  });

  it('truncates outputSummary to 200 chars', () => {
    const longOutput = 'x'.repeat(300);
    const events = [
      makeEvent({ kind: 'tool_started', seq: 0, toolName: 'file_read', payload: { toolUseId: 'd', input: {}, ordinal: 0, detail: '' } }),
      makeEvent({ kind: 'tool_completed', seq: 1, toolName: 'file_read', payload: { toolUseId: 'd', resultPreview: longOutput, durationMs: 5, detail: '' } }),
    ];
    const steps = distillSteps(events);
    expect(steps[0].outputSummary.length).toBeLessThanOrEqual(200);
  });
});

describe('parseJsonArrayFromLLMText()', () => {
  it('parses bare JSON arrays', () => {
    expect(__testing.parseJsonArrayFromLLMText('[{"seq":0}]')).toEqual([{ seq: 0 }]);
  });

  it('parses fenced json arrays', () => {
    expect(__testing.parseJsonArrayFromLLMText('```json\n[{"seq":0}]\n```')).toEqual([{ seq: 0 }]);
  });

  it('extracts the array when the model adds extra text', () => {
    expect(__testing.parseJsonArrayFromLLMText('Here is the cleaned output:\n```json\n[{"seq":0}]\n```\nDone.')).toEqual([{ seq: 0 }]);
  });

  it('throws when no json array is present', () => {
    expect(() => __testing.parseJsonArrayFromLLMText('not json')).toThrow('LLM did not return a valid JSON array');
  });
});
