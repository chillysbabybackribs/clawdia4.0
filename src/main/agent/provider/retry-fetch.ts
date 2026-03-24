/**
 * retryFetch — fetch wrapper with exponential backoff retry for transient errors.
 *
 * Used by OpenAI and Gemini adapters. AbortSignal is respected during delay
 * windows via Promise.race — abort fires immediately, not after the full backoff.
 */

const DEFAULT_RETRYABLE = new Set([429, 502, 503, 504]);
const DEFAULT_MAX_ATTEMPTS = 3;

export interface RetryFetchOptions {
  retryable?: Set<number>;
  maxAttempts?: number;
  signal?: AbortSignal;
}

export async function retryFetch(
  url: string,
  init: RequestInit,
  options: RetryFetchOptions = {},
): Promise<Response> {
  const retryable = options.retryable ?? DEFAULT_RETRYABLE;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const signal = options.signal;

  let response!: Response;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    response = await fetch(url, { ...init, signal });

    if (response.ok || !retryable.has(response.status)) return response;
    if (attempt === maxAttempts - 1) break;

    const retryAfter = response.headers.get('retry-after');
    const delayMs = retryAfter
      ? parseFloat(retryAfter) * 1000
      : 2 ** attempt * 1000 + Math.random() * 200;

    await abortableDelay(delayMs, signal);
  }

  return response;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal.addEventListener('abort', onAbort, { once: true });
  });
}
