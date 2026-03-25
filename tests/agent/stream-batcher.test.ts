import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStreamBatcher } from '../../src/main/agent/stream-batcher';

describe('createStreamBatcher()', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('buffers chunks and flushes them as a single joined string after the delay', () => {
    const flush = vi.fn();
    const batcher = createStreamBatcher(flush, 16);

    batcher.push('hello ');
    batcher.push('world');

    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(16);

    expect(flush).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledWith('hello world');
  });

  it('does not flush again if no new chunks arrive after the first flush', () => {
    const flush = vi.fn();
    const batcher = createStreamBatcher(flush, 16);

    batcher.push('a');
    vi.advanceTimersByTime(16);
    expect(flush).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledOnce();
  });

  it('flushes separate windows as separate calls', () => {
    const flush = vi.fn();
    const batcher = createStreamBatcher(flush, 16);

    batcher.push('first');
    vi.advanceTimersByTime(16);

    batcher.push('second');
    vi.advanceTimersByTime(16);

    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenNthCalledWith(1, 'first');
    expect(flush).toHaveBeenNthCalledWith(2, 'second');
  });

  it('flushImmediate sends buffered chunks right away and cancels pending timer', () => {
    const flush = vi.fn();
    const batcher = createStreamBatcher(flush, 16);

    batcher.push('early');
    batcher.flushImmediate();

    expect(flush).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledWith('early');

    // Timer should be cancelled — no second call
    vi.advanceTimersByTime(16);
    expect(flush).toHaveBeenCalledOnce();
  });

  it('flushImmediate is a no-op when buffer is empty', () => {
    const flush = vi.fn();
    const batcher = createStreamBatcher(flush, 16);

    batcher.flushImmediate();

    expect(flush).not.toHaveBeenCalled();
  });
});
