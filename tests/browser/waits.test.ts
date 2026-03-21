import { describe, expect, it } from 'vitest';
import { waitForText, waitForUrlMatch } from '../../src/main/browser/waits';

function makeView(executeResult: any, url = 'https://example.com/products/1') {
  return {
    webContents: {
      executeJavaScript: async () => executeResult,
      getURL: () => url,
    },
  } as any;
}

describe('browser waits', () => {
  it('waits for visible text matches', async () => {
    const ok = await waitForText(makeView(true), 'Widget', { timeoutMs: 50 });
    expect(ok).toBe(true);
  });

  it('waits for URL matches using regex mode', async () => {
    const ok = await waitForUrlMatch(makeView(true, 'https://example.com/dp/B001'), 'dp\\/B\\d+', { timeoutMs: 50, match: 'regex' });
    expect(ok).toBe(true);
  });
});
