import type { BrowserView, WebContents } from 'electron';

export interface WaitOptions {
  timeoutMs?: number;
  settleMs?: number;
}

export interface UrlWaitOptions extends WaitOptions {
  match?: 'includes' | 'equals' | 'regex';
}

export async function waitForLoad(view: BrowserView, opts: WaitOptions = {}): Promise<void> {
  const wc = view.webContents;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const settleMs = opts.settleMs ?? 150;

  if (wc.isDestroyed()) throw new Error('Browser view was destroyed while waiting for load');
  if (!wc.isLoadingMainFrame() && !wc.isLoading()) {
    await wait(settleMs);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      finish(new Error(`Timed out waiting for page load after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      timer = null;
      cleanup();
      if (error) reject(error);
      else resolve();
    };

    const onStop = () => finish();
    const onFinish = () => finish();
    const onFail = (_event: Event, errorCode: number, errorDescription: string, _url: string, isMainFrame: boolean) => {
      if (!isMainFrame) return;
      if (errorCode === -3) return; // ERR_ABORTED often precedes a successful follow-up navigation.
      finish(new Error(`Page load failed (${errorCode}): ${errorDescription}`));
    };
    const onDestroyed = () => finish(new Error('Browser view was destroyed while waiting for load'));

    const cleanup = () => {
      wc.removeListener('did-stop-loading', onStop);
      wc.removeListener('did-finish-load', onFinish);
      wc.removeListener('did-fail-load', onFail as any);
      wc.removeListener('destroyed', onDestroyed);
    };

    wc.on('did-stop-loading', onStop);
    wc.on('did-finish-load', onFinish);
    wc.on('did-fail-load', onFail as any);
    wc.on('destroyed', onDestroyed);
  });

  await waitForDomSettled(view, { settleMs, timeoutMs: Math.min(timeoutMs, 2_000) });
}

export async function waitForDomSettled(view: BrowserView, opts: WaitOptions = {}): Promise<void> {
  const settleMs = opts.settleMs ?? 150;
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const wc = view.webContents;
  if (wc.isDestroyed()) throw new Error('Browser view was destroyed while waiting for DOM settle');

  try {
    await withTimeout(
      wc.executeJavaScript(`new Promise((resolve) => {
        const finish = () => setTimeout(resolve, ${Math.max(0, settleMs)});
        if (typeof requestAnimationFrame !== 'function') return finish();
        requestAnimationFrame(() => requestAnimationFrame(finish));
      })`),
      timeoutMs,
      'Timed out waiting for DOM settle',
    );
  } catch {
    await wait(settleMs);
  }
}

export async function waitForPotentialNavigation(view: BrowserView, opts: WaitOptions = {}): Promise<void> {
  const wc = view.webContents;
  const timeoutMs = opts.timeoutMs ?? 4_000;
  const settleMs = opts.settleMs ?? 150;
  if (wc.isDestroyed()) throw new Error('Browser view was destroyed while waiting for navigation settle');

  const navigationStarted = await new Promise<boolean>((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => finish(false), 150);
    const onStart = (_event: Event, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
      if (!isMainFrame || isInPlace) return;
      finish(true);
    };

    function finish(value: boolean) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      wc.removeListener('did-start-navigation', onStart as any);
      resolve(value);
    }

    wc.on('did-start-navigation', onStart as any);
  });

  if (navigationStarted) {
    await waitForLoad(view, { timeoutMs, settleMs });
    return;
  }

  await waitForDomSettled(view, { timeoutMs: Math.min(timeoutMs, 1_500), settleMs });
}

export async function waitForSelector(view: BrowserView, selector: string, opts: WaitOptions = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const exists = await view.webContents.executeJavaScript(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })()`);
      if (exists) return true;
    } catch {
      return false;
    }
    await wait(100);
  }
  return false;
}

export async function waitForText(view: BrowserView, text: string, opts: WaitOptions = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const needle = text.trim().toLowerCase();
  if (!needle) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const exists = await view.webContents.executeJavaScript(`(() => {
        const text = (document.body && document.body.innerText || '').toLowerCase();
        return text.includes(${JSON.stringify(needle)});
      })()`);
      if (exists) return true;
    } catch {
      return false;
    }
    await wait(100);
  }
  return false;
}

export async function waitForUrlMatch(view: BrowserView, expected: string, opts: UrlWaitOptions = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const mode = opts.match ?? 'includes';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const currentUrl = view.webContents.getURL();
      if (
        (mode === 'includes' && currentUrl.includes(expected)) ||
        (mode === 'equals' && currentUrl === expected) ||
        (mode === 'regex' && new RegExp(expected).test(currentUrl))
      ) {
        return true;
      }
    } catch {
      return false;
    }
    await wait(100);
  }
  return false;
}

export async function waitForPageReady(view: BrowserView, opts: WaitOptions = {}): Promise<void> {
  await waitForLoad(view, opts);
  await waitForDomSettled(view, { timeoutMs: Math.min(opts.timeoutMs ?? 5_000, 2_000), settleMs: opts.settleMs });
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
