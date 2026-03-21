import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendDebuggerCommand = vi.fn();
const evaluateDebuggerExpression = vi.fn();

vi.mock('../../src/main/browser/debugger-session', () => ({
  sendDebuggerCommand,
  evaluateDebuggerExpression,
}));

describe('dom-snapshot', () => {
  beforeEach(() => {
    sendDebuggerCommand.mockReset();
    evaluateDebuggerExpression.mockReset();
  });

  it('returns page data plus frame summary', async () => {
    evaluateDebuggerExpression.mockResolvedValue({
      url: 'https://example.com',
      title: 'Example',
      visibleText: 'Example page',
      interactiveElements: [{ index: 0, tag: 'button', text: 'Continue', selectorHint: '#continue' }],
      forms: [{ id: 'signup', selectorHint: '#signup', fields: [{ name: 'email', selectorHint: 'input[name="email"]' }] }],
    });
    sendDebuggerCommand.mockResolvedValue({
      frameTree: {
        frame: { id: 'root', url: 'https://example.com', name: '' },
        childFrames: [
          { frame: { id: 'child-1', url: 'https://example.com/embed', name: 'embed' }, childFrames: [] },
        ],
      },
    });

    const { buildDomSnapshot } = await import('../../src/main/browser/dom-snapshot');
    const view = { webContents: {} } as any;

    const snapshot = await buildDomSnapshot(view);
    expect(snapshot.url).toBe('https://example.com');
    expect(snapshot.title).toBe('Example');
    expect(snapshot.frames).toEqual([
      { id: 'root', parentId: undefined, url: 'https://example.com', name: '' },
      { id: 'child-1', parentId: 'root', url: 'https://example.com/embed', name: 'embed' },
    ]);
    expect(sendDebuggerCommand).toHaveBeenCalledWith(view, 'Page.getFrameTree');
  });

  it('marks the selected frame when frame-targeted snapshotting is used', async () => {
    evaluateDebuggerExpression.mockResolvedValue({
      url: 'https://example.com/frame',
      title: 'Frame Example',
      visibleText: 'Frame text',
      interactiveElements: [],
      forms: [],
    });
    sendDebuggerCommand.mockResolvedValue({
      frameTree: {
        frame: { id: 'root', url: 'https://example.com', name: '' },
        childFrames: [
          { frame: { id: 'frame-1', url: 'https://example.com/frame', name: 'embed' }, childFrames: [] },
        ],
      },
    });

    const { buildDomSnapshot } = await import('../../src/main/browser/dom-snapshot');
    const snapshot = await buildDomSnapshot({ webContents: {} } as any, { frameId: 'frame-1' });
    expect(evaluateDebuggerExpression).toHaveBeenCalled();
    expect(snapshot.selectedFrameId).toBe('frame-1');
    expect(snapshot.selectedFrameUrl).toBe('https://example.com/frame');
  });
});
