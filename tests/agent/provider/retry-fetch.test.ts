import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { retryFetch } from '../../../src/main/agent/provider/retry-fetch';

describe('retryFetch()', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns immediately on a successful first attempt', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const res = await retryFetch('https://example.com', {});
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);

    vi.unstubAllGlobals();
  });

  it('retries on 429 and succeeds on second attempt', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const promise = retryFetch('https://example.com', {});
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);

    vi.unstubAllGlobals();
  });

  it('exhausts maxAttempts and returns the last failing response', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('error', { status: 503 }));
    vi.stubGlobal('fetch', mockFetch);

    const promise = retryFetch('https://example.com', {}, { maxAttempts: 3 });
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(res.status).toBe(503);

    vi.unstubAllGlobals();
  });

  it('does not retry on non-retryable status (e.g. 400)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }));
    vi.stubGlobal('fetch', mockFetch);

    const res = await retryFetch('https://example.com', {});
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(res.status).toBe(400);

    vi.unstubAllGlobals();
  });

  it('respects Retry-After header delay', async () => {
    const headers = new Headers({ 'retry-after': '5' });
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const promise = retryFetch('https://example.com', {});
    // Should not have retried yet before 5s
    await vi.advanceTimersByTimeAsync(4999);
    expect(mockFetch).toHaveBeenCalledOnce();
    // After 5s delay, should retry
    await vi.advanceTimersByTimeAsync(1);
    const res = await promise;
    expect(res.status).toBe(200);

    vi.unstubAllGlobals();
  });

  it('aborts immediately during retry delay when signal fires', async () => {
    const controller = new AbortController();
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response('error', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const promise = retryFetch('https://example.com', {}, { signal: controller.signal });
    // Abort during the retry delay (before the 1s backoff expires)
    controller.abort();
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toThrow();
    // Should not have retried after abort
    expect(mockFetch).toHaveBeenCalledOnce();

    vi.unstubAllGlobals();
  });
});
