import type { BrowserView } from 'electron';
import { evaluateDebuggerExpression, sendDebuggerCommand } from './debugger-session';

export interface DomSnapshotOptions {
  maxTextLength?: number;
  maxInteractiveElements?: number;
  maxForms?: number;
  frameId?: string;
}

export interface DomSnapshotResult {
  url: string;
  title: string;
  visibleText: string;
  interactiveElements: Array<Record<string, any>>;
  forms: Array<Record<string, any>>;
  frames: Array<{ id: string; parentId?: string; url: string; name?: string }>;
  selectedFrameId?: string;
  selectedFrameUrl?: string;
}

export async function buildDomSnapshot(view: BrowserView, opts: DomSnapshotOptions = {}): Promise<DomSnapshotResult> {
  const maxTextLength = Math.max(500, Math.min(opts.maxTextLength ?? 8_000, 20_000));
  const maxInteractiveElements = Math.max(10, Math.min(opts.maxInteractiveElements ?? 50, 200));
  const maxForms = Math.max(1, Math.min(opts.maxForms ?? 10, 50));

  const data = await evaluateDebuggerExpression<Pick<DomSnapshotResult, 'url' | 'title' | 'visibleText' | 'interactiveElements' | 'forms'>>(view, `(() => {
    const maxTextLength = ${maxTextLength};
    const maxInteractiveElements = ${maxInteractiveElements};
    const maxForms = ${maxForms};
    const visibleText = (() => {
      const clone = document.body ? document.body.cloneNode(true) : null;
      if (!clone) return '';
      clone.querySelectorAll('script,style,noscript,svg').forEach((el) => el.remove());
      return (clone.innerText || '').trim().slice(0, maxTextLength);
    })();

    const selectorHint = (el) => {
      const id = el.getAttribute('id');
      if (id) return '#' + id;
      const name = el.getAttribute('name');
      if (name) return el.tagName.toLowerCase() + '[name="' + name + '"]';
      const aria = el.getAttribute('aria-label');
      if (aria) return '[' + 'aria-label="' + aria.slice(0, 80) + '"' + ']';
      const role = el.getAttribute('role');
      if (role) return el.tagName.toLowerCase() + '[role="' + role + '"]';
      return el.tagName.toLowerCase();
    };

    const interactiveElements = [];
    const selector = 'a[href],button,input,textarea,select,[contenteditable="true"],[role=button],[role=link],[role=tab],[role=menuitem],[role=textbox],[onclick]';
    document.querySelectorAll(selector).forEach((el) => {
      if (interactiveElements.length >= maxInteractiveElements) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      interactiveElements.push({
        index: interactiveElements.length,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        role: el.getAttribute('role') || '',
        text: ((el.textContent || '').trim().replace(/\\s+/g, ' ')).slice(0, 120),
        ariaLabel: (el.getAttribute('aria-label') || '').slice(0, 120),
        placeholder: (el.getAttribute('placeholder') || '').slice(0, 120),
        href: (el.getAttribute('href') || '').slice(0, 240),
        selectorHint: selectorHint(el),
      });
    });

    const forms = [];
    document.querySelectorAll('form').forEach((form) => {
      if (forms.length >= maxForms) return;
      const fields = [];
      form.querySelectorAll('input,textarea,select,[contenteditable="true"],[role=textbox]').forEach((field) => {
        if (fields.length >= 20) return;
        const rect = field.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        fields.push({
          tag: field.tagName.toLowerCase(),
          type: field.getAttribute('type') || '',
          name: field.getAttribute('name') || '',
          ariaLabel: field.getAttribute('aria-label') || '',
          placeholder: field.getAttribute('placeholder') || '',
          selectorHint: selectorHint(field),
        });
      });
      forms.push({
        id: form.getAttribute('id') || '',
        name: form.getAttribute('name') || '',
        action: form.getAttribute('action') || '',
        selectorHint: selectorHint(form),
        fields,
      });
    });

    return {
      url: window.location.href,
      title: document.title || '',
      visibleText,
      interactiveElements,
      forms,
    };
  })()`, {
    frameId: opts.frameId,
    timeoutMs: 5_000,
  });

  const frames = await getFrameSummary(view);
  const selectedFrame = opts.frameId ? frames.find((frame) => frame.id === opts.frameId) : undefined;
  return {
    ...data,
    frames,
    selectedFrameId: selectedFrame?.id,
    selectedFrameUrl: selectedFrame?.url,
  };
}

async function getFrameSummary(view: BrowserView): Promise<Array<{ id: string; parentId?: string; url: string; name?: string }>> {
  try {
    const tree = await sendDebuggerCommand<any>(view, 'Page.getFrameTree');
    const frames: Array<{ id: string; parentId?: string; url: string; name?: string }> = [];
    walkFrames(tree.frameTree, undefined, frames);
    return frames.slice(0, 50);
  } catch {
    return [];
  }
}

function walkFrames(
  node: any,
  parentId: string | undefined,
  out: Array<{ id: string; parentId?: string; url: string; name?: string }>,
): void {
  if (!node?.frame) return;
  out.push({
    id: node.frame.id,
    parentId,
    url: node.frame.url || '',
    name: node.frame.name || '',
  });
  for (const child of node.childFrames || []) walkFrames(child, node.frame.id, out);
}
