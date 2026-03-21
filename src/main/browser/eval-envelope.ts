import type { EvalErrorEnvelope, EvalResultEnvelope } from './runtime-types';

function clip(text: string, maxChars: number): { value: string; truncated: boolean } {
  if (text.length <= maxChars) return { value: text, truncated: false };
  return { value: text.slice(0, maxChars) + '…', truncated: true };
}

export function serializeEvalValue(value: any, maxChars: number): { value: any; truncated: boolean; error?: EvalErrorEnvelope } {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return { value: '[undefined]', truncated: false };
    if (json.length <= maxChars) return { value, truncated: false };
    return { value: clip(json, maxChars).value, truncated: true };
  } catch (error: any) {
    const fallback = clip(String(value), maxChars);
    return {
      value: fallback.value,
      truncated: fallback.truncated,
      error: {
        type: 'serialization',
        message: error?.message || 'Failed to serialize evaluation result',
        diagnostic: 'Value was coerced to string because JSON serialization failed.',
      },
    };
  }
}

export function normalizeEvalException(exceptionDetails: any): EvalErrorEnvelope {
  const description = exceptionDetails?.exception?.description;
  const text = exceptionDetails?.text;
  const stackText = Array.isArray(exceptionDetails?.stackTrace?.callFrames)
    ? exceptionDetails.stackTrace.callFrames
        .slice(0, 8)
        .map((frame: any) => `${frame.functionName || '<anonymous>'} (${frame.url || 'page'}:${frame.lineNumber ?? 0}:${frame.columnNumber ?? 0})`)
        .join('\n')
    : undefined;
  return {
    type: 'runtime',
    message: description || text || 'Runtime.evaluate failed',
    stack: stackText,
    diagnostic: text && description && text !== description ? text : undefined,
  };
}

export function buildEvalSuccessEnvelope(url: string, result: any, maxChars: number): EvalResultEnvelope {
  const serialized = serializeEvalValue(result?.result?.value, maxChars);
  return {
    ok: true,
    url,
    value: serialized.value,
    truncated: serialized.truncated,
    type: result?.result?.type || typeof serialized.value,
    error: serialized.error,
  };
}

export function buildEvalErrorEnvelope(url: string, error: EvalErrorEnvelope): EvalResultEnvelope {
  return {
    ok: false,
    url,
    value: null,
    truncated: false,
    type: 'error',
    error,
  };
}

export function normalizeThrownEvalError(url: string, error: any): EvalResultEnvelope {
  const message = error?.message || String(error);
  const type: EvalErrorEnvelope['type'] =
    /timed out/i.test(message) ? 'timeout' :
    /serialize/i.test(message) ? 'serialization' :
    'unknown';
  return buildEvalErrorEnvelope(url, {
    type,
    message,
    stack: typeof error?.stack === 'string' ? error.stack.slice(0, 4000) : undefined,
  });
}
