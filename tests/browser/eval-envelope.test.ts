import { describe, expect, it } from 'vitest';
import {
  buildEvalSuccessEnvelope,
  normalizeEvalException,
  normalizeThrownEvalError,
  serializeEvalValue,
} from '../../src/main/browser/eval-envelope';

describe('eval-envelope', () => {
  it('marks oversized JSON payloads as truncated', () => {
    const envelope = buildEvalSuccessEnvelope('https://example.com', {
      result: { type: 'object', value: { text: 'x'.repeat(80) } },
    }, 20);
    expect(envelope.ok).toBe(true);
    expect(envelope.truncated).toBe(true);
  });

  it('surfaces serialization errors without throwing', () => {
    const value: any = {};
    value.self = value;
    const result = serializeEvalValue(value, 50);
    expect(result.error?.type).toBe('serialization');
    expect(typeof result.value).toBe('string');
  });

  it('normalizes runtime exception details', () => {
    const error = normalizeEvalException({
      text: 'Uncaught',
      exception: { description: 'ReferenceError: foo is not defined' },
      stackTrace: { callFrames: [{ functionName: 'run', url: 'https://example.com', lineNumber: 2, columnNumber: 4 }] },
    });
    expect(error.type).toBe('runtime');
    expect(error.message).toContain('ReferenceError');
    expect(error.stack).toContain('run');
  });

  it('classifies thrown timeouts', () => {
    const envelope = normalizeThrownEvalError('https://example.com', new Error('Timed out waiting for debugger command Runtime.evaluate'));
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.type).toBe('timeout');
  });
});
