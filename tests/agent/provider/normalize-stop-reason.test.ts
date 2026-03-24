import { describe, it, expect } from 'vitest';
import { normalizeStopReason, lookupModelMaxOutput } from '../../../src/main/agent/provider/types';

describe('normalizeStopReason()', () => {
  it('maps Anthropic tool_use → tool_use', () => {
    expect(normalizeStopReason('tool_use')).toBe('tool_use');
  });

  it('maps OpenAI tool_calls → tool_use', () => {
    expect(normalizeStopReason('tool_calls')).toBe('tool_use');
  });

  it('maps Gemini function_calls → tool_use', () => {
    expect(normalizeStopReason('function_calls')).toBe('tool_use');
  });

  it('maps end_turn → end_turn', () => {
    expect(normalizeStopReason('end_turn')).toBe('end_turn');
  });

  it('maps stop → end_turn', () => {
    expect(normalizeStopReason('stop')).toBe('end_turn');
  });

  it('maps length → max_tokens', () => {
    expect(normalizeStopReason('length')).toBe('max_tokens');
  });

  it('maps max_tokens → max_tokens', () => {
    expect(normalizeStopReason('max_tokens')).toBe('max_tokens');
  });

  it('passes through unknown values unchanged', () => {
    expect(normalizeStopReason('content_filter')).toBe('content_filter');
    expect(normalizeStopReason('')).toBe('');
  });
});

describe('lookupModelMaxOutput()', () => {
  const map: Record<string, number> = { 'gpt-5.4': 32768, 'gpt-5.4-mini': 16384 };

  it('returns exact match', () => {
    expect(lookupModelMaxOutput('gpt-5.4', map, 8192)).toBe(32768);
  });

  it('matches by prefix — version suffix ignored', () => {
    expect(lookupModelMaxOutput('gpt-5.4-20260101', map, 8192)).toBe(32768);
    expect(lookupModelMaxOutput('gpt-5.4-mini-preview', map, 8192)).toBe(16384);
  });

  it('returns fallback for unknown model', () => {
    expect(lookupModelMaxOutput('gpt-unknown', map, 8192)).toBe(8192);
  });
});
