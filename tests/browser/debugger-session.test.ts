import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import {
  cleanupDebuggerSession,
  ensureDebuggerAttached,
  evaluateDebuggerExpression,
  getRecentNetworkActivity,
  sendDebuggerCommand,
  startNetworkWatch,
  stopNetworkWatch,
  subscribeToDebuggerEvents,
} from '../../src/main/browser/debugger-session';

class FakeDebugger extends EventEmitter {
  attached = false;
  commands: Array<{ method: string; params: Record<string, any> }> = [];

  isAttached(): boolean {
    return this.attached;
  }

  attach(): void {
    this.attached = true;
  }

  detach(): void {
    this.attached = false;
    this.emit('detach', {}, 'target_closed');
  }

  async sendCommand(method: string, params: Record<string, any> = {}): Promise<any> {
    this.commands.push({ method, params });
    if (method === 'Page.createIsolatedWorld') {
      return { executionContextId: 777 };
    }
    return { ok: true, method, params };
  }
}

class FakeWebContents extends EventEmitter {
  id = 101;
  destroyed = false;
  debugger = new FakeDebugger();

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

function makeView() {
  return {
    webContents: new FakeWebContents(),
  } as any;
}

describe('debugger-session', () => {
  it('attaches once and sends commands through the wrapper', async () => {
    const view = makeView();
    await ensureDebuggerAttached(view);
    expect(view.webContents.debugger.isAttached()).toBe(true);

    const result = await sendDebuggerCommand(view, 'Page.enable', { foo: 'bar' }, 1000);
    expect(result).toEqual({ ok: true, method: 'Page.enable', params: { foo: 'bar' } });
    expect(view.webContents.debugger.commands[0]).toEqual({ method: 'Page.enable', params: { foo: 'bar' } });

    cleanupDebuggerSession(view);
  });

  it('subscribes to debugger events and tracks bounded network activity', async () => {
    const view = makeView();
    const events: Array<{ method: string; params: Record<string, any> }> = [];
    const unsubscribe = subscribeToDebuggerEvents(view, (method, params) => events.push({ method, params }));

    await startNetworkWatch(view, 20);
    view.webContents.debugger.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'req-1',
      request: { url: 'https://example.com/api', method: 'POST' },
      type: 'XHR',
    });
    view.webContents.debugger.emit('message', {}, 'Network.responseReceived', {
      requestId: 'req-1',
      response: { url: 'https://example.com/api', status: 200 },
      type: 'XHR',
    });

    const entries = getRecentNetworkActivity(view, 10);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.some(entry => entry.url === 'https://example.com/api' && entry.status === 200)).toBe(true);
    expect(events.map(event => event.method)).toContain('Network.requestWillBeSent');

    unsubscribe();
    await stopNetworkWatch(view);
    cleanupDebuggerSession(view);
  });

  it('evaluates in a frame-specific isolated world when frameId is provided', async () => {
    const view = makeView();
    await evaluateDebuggerExpression(view, 'document.title', { frameId: 'frame-1', timeoutMs: 900 });
    expect(view.webContents.debugger.commands[0]).toEqual({
      method: 'Page.createIsolatedWorld',
      params: {
        frameId: 'frame-1',
        worldName: 'clawdia-frame-101',
        grantUniversalAccess: false,
      },
    });
    expect(view.webContents.debugger.commands[1]).toEqual({
      method: 'Runtime.evaluate',
      params: {
        expression: 'document.title',
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
        contextId: 777,
      },
    });
    cleanupDebuggerSession(view);
  });
});
