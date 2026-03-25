/**
 * StreamBatcher — coalesces rapid string chunks into time-windowed flushes.
 *
 * Reduces IPC send() calls during LLM streaming by batching chunks that
 * arrive within a single animation-frame window (default 16ms) into one
 * joined string, then calling the flush callback once per window.
 */

export interface StreamBatcher {
  push(chunk: string): void;
  flushImmediate(): void;
}

export function createStreamBatcher(
  flush: (combined: string) => void,
  delayMs: number = 16,
): StreamBatcher {
  let buffer = '';
  let timer: ReturnType<typeof setTimeout> | null = null;

  function send() {
    timer = null;
    if (!buffer) return;
    const payload = buffer;
    buffer = '';
    flush(payload);
  }

  return {
    push(chunk: string) {
      buffer += chunk;
      if (!timer) {
        timer = setTimeout(send, delayMs);
      }
    },

    flushImmediate() {
      if (timer) { clearTimeout(timer); timer = null; }
      send();
    },
  };
}
