/**
 * Native Browser Input — Browser-level input primitives via Electron's
 * webContents API.
 *
 * These functions use webContents.sendInputEvent(), which dispatches events
 * through Chromium's native input pipeline without going through
 * webContents.debugger or a DevTools protocol session.
 */

import { BrowserView } from 'electron';

// ═══════════════════════════════════
// Types
// ═══════════════════════════════════

export interface ElementInfo {
  /** CSS selector that uniquely identifies this element */
  selector: string;
  /** Element tag name (lowercase) */
  tag: string;
  /** 'input' | 'textarea' | 'contenteditable' | 'shadow-input' | 'shadow-textarea' | 'unknown' */
  fieldType: string;
  /** Bounding rect center coordinates for native mouse input */
  x: number;
  y: number;
  /** Current value or text content */
  currentValue: string;
  /** Descriptive label for the field */
  label: string;
  /** name attribute if present */
  name: string;
}

export interface FillResult {
  success: boolean;
  message: string;
  /** What the field actually contains after filling */
  actualValue: string;
  /** How long the operation took */
  elapsedMs: number;
}

// ═══════════════════════════════════
// Core native-input primitives
// ═══════════════════════════════════

/**
 * Click at specific coordinates using Chromium input events.
 * This properly updates Chromium's internal focus state —
 * unlike el.focus() or el.click() which only dispatch DOM events.
 */
export async function nativeClickInput(view: BrowserView, x: number, y: number): Promise<void> {
  const wc = view.webContents;
  wc.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  await wait(30);
  wc.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  await wait(50);
}

/**
 * Type text using Chromium keyboard events.
 * Each character goes through Chromium's input pipeline as a real keystroke.
 * Works with every framework, editor, and Web Component.
 */
export async function nativeTypeInput(view: BrowserView, text: string, delayMs: number = 5): Promise<void> {
  const wc = view.webContents;
  for (const char of text) {
    const code = char.charCodeAt(0);
    // keyDown
    wc.sendInputEvent({ type: 'keyDown', keyCode: char });
    // char event (this is what actually inserts the character)
    wc.sendInputEvent({ type: 'char', keyCode: char });
    // keyUp
    wc.sendInputEvent({ type: 'keyUp', keyCode: char });
    if (delayMs > 0) await wait(delayMs);
  }
}

/**
 * Send a special key (Enter, Tab, Backspace, etc.) via Chromium input events.
 */
export async function nativeKeyInput(view: BrowserView, key: string, modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }): Promise<void> {
  const wc = view.webContents;
  const mods: Electron.InputEvent['modifiers'] = [];
  if (modifiers?.ctrl) mods.push('control');
  if (modifiers?.shift) mods.push('shift');
  if (modifiers?.alt) mods.push('alt');
  if (modifiers?.meta) mods.push('meta');

  wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: mods.length > 0 ? mods : undefined });
  await wait(20);
  wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods.length > 0 ? mods : undefined });
  await wait(20);
}

/**
 * Select all text in the focused element (Ctrl+A) then delete it.
 * Works for both native inputs and contenteditable editors.
 */
export async function clearFocusedField(view: BrowserView): Promise<void> {
  await nativeKeyInput(view, 'a', { ctrl: true });
  await wait(30);
  await nativeKeyInput(view, 'Backspace');
  await wait(30);
}

// ═══════════════════════════════════
// Compound Operations
// ═══════════════════════════════════

/**
 * Resolve an element's position and type via JS injection.
 * This is the ONE place we still use executeJavaScript — to inspect
 * the DOM and get coordinates. All actual input goes through native input
 * events, not the debugger protocol.
 */
export async function resolveElement(view: BrowserView, selector: string): Promise<ElementInfo | null> {
  try {
    const result = await view.webContents.executeJavaScript(`(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;

      // Drill into shadow DOM if needed
      var target = el;
      if (el.shadowRoot) {
        var inner = el.shadowRoot.querySelector('textarea, input:not([type=hidden]), [contenteditable="true"], [role=textbox]');
        if (inner) target = inner;
      }
      // Drill into light DOM children for wrapper elements
      if (target === el && !el.isContentEditable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
        var child = el.querySelector('textarea, input:not([type=hidden]), [contenteditable="true"], [role=textbox]');
        if (child) target = child;
      }

      var rect = target.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        // Try the outer element's rect
        rect = el.getBoundingClientRect();
      }
      if (rect.width === 0 || rect.height === 0) return null;

      // Determine field type
      var fieldType = 'unknown';
      var ttag = target.tagName.toUpperCase();
      if (ttag === 'INPUT') fieldType = target !== el ? 'shadow-input' : 'input';
      else if (ttag === 'TEXTAREA') fieldType = target !== el ? 'shadow-textarea' : 'textarea';
      else if (target.isContentEditable) fieldType = 'contenteditable';
      else if (target.getAttribute('role') === 'textbox') fieldType = 'contenteditable';

      // Get current value
      var currentValue = '';
      if (target.isContentEditable) currentValue = (target.textContent || '').trim();
      else currentValue = target.value || '';

      // Build label
      var label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '';

      return {
        selector: ${JSON.stringify(selector)},
        tag: target.tagName.toLowerCase(),
        fieldType: fieldType,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        currentValue: currentValue.slice(0, 200),
        label: label.slice(0, 80),
        name: el.getAttribute('name') || target.getAttribute('name') || '',
      };
    })()`);
    return result;
  } catch {
    return null;
  }
}

/**
 * Read back the current value of a field after filling.
 * Handles native inputs, textareas, contenteditable, and shadow DOM.
 */
export async function readFieldValue(view: BrowserView, selector: string): Promise<string> {
  try {
    return await view.webContents.executeJavaScript(`(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return '';
      // Drill into shadow/children
      var target = el;
      if (el.shadowRoot) {
        var inner = el.shadowRoot.querySelector('textarea, input:not([type=hidden]), [contenteditable="true"], [role=textbox]');
        if (inner) target = inner;
      }
      if (target === el && !el.isContentEditable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
        var child = el.querySelector('textarea, input:not([type=hidden]), [contenteditable="true"], [role=textbox]');
        if (child) target = child;
      }
      if (target.isContentEditable) {
        // For contenteditable, use innerText instead of textContent.
        // innerText respects CSS visibility and gives us the text as
        // rendered (with proper line breaks from <p>/<br> tags), while
        // textContent includes hidden elements and doesn't collapse whitespace.
        // This is critical for Lexical/ProseMirror which wrap text in <p> tags.
        return (target.innerText || target.textContent || '').trim();
      }
      return target.value || '';
    })()`);
  } catch {
    return '';
  }
}

/**
 * The atomic fill operation: resolve element → native click → clear → type → verify.
 * This is the single tool that replaces browser_click + browser_focus_field + browser_type.
 */
export async function fillFieldWithInputEvents(view: BrowserView, selector: string, text: string): Promise<FillResult> {
  const start = Date.now();

  // Step 1: Resolve the element and get coordinates
  const info = await resolveElement(view, selector);
  if (!info) {
    return { success: false, message: `No element found for selector: ${selector}`, actualValue: '', elapsedMs: Date.now() - start };
  }
  if (info.fieldType === 'unknown') {
    return { success: false, message: `Element "${selector}" is not an editable field (tag: ${info.tag})`, actualValue: '', elapsedMs: Date.now() - start };
  }

  // Step 2: Scroll element into view
  try {
    await view.webContents.executeJavaScript(`(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (el) el.scrollIntoView({behavior:'instant', block:'center'});
    })()`);
    await wait(100);
  } catch { /* non-fatal */ }

  // Step 3: Re-resolve after scroll (coordinates may have changed)
  const scrolledInfo = await resolveElement(view, selector);
  const x = scrolledInfo?.x ?? info.x;
  const y = scrolledInfo?.y ?? info.y;

  // Step 4: Native click to properly focus (this sets Chromium's internal focus state)
  await nativeClickInput(view, x, y);
  await wait(150);

  // Step 5: Clear existing content via Ctrl+A → Backspace
  if (text.length > 0) {
    await clearFocusedField(view);
    await wait(50);
  }

  // Step 6: Type the text character by character via Chromium keyboard events
  if (text.length > 0) {
    await nativeTypeInput(view, text, 5);
    await wait(100);
  }

  // Step 7: Verify the text was entered correctly
  // Wait a moment for framework state to settle (Lexical, ProseMirror update async)
  await wait(200);
  const actualValue = await readFieldValue(view, selector);

  // Normalize aggressively for comparison:
  //  - Collapse all whitespace (including \n, \t, zero-width spaces, nbsp)
  //  - Strip unicode control characters that editors insert
  //  - Trim
  function normalize(s: string): string {
    return s
      .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')  // zero-width chars
      .replace(/\u00A0/g, ' ')                       // non-breaking space → space
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")   // smart single quotes → ASCII
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')   // smart double quotes → ASCII
      .replace(/[\u2013\u2014]/g, '-')                // en/em dash → hyphen
      .replace(/\u2026/g, '...')                      // ellipsis → three dots
      .replace(/\s+/g, ' ')                           // collapse whitespace
      .trim();
  }
  const normalizedActual = normalize(actualValue);
  const normalizedExpected = normalize(text);

  const elapsed = Date.now() - start;
  const desc = `${info.tag}[name=${info.name || 'unnamed'}]`;

  // Exact match after normalization
  if (normalizedActual === normalizedExpected) {
    return {
      success: true,
      message: `Filled ${desc}: "${text.slice(0, 50)}"`,
      actualValue,
      elapsedMs: elapsed,
    };
  }

  // Containment match — the field contains what we typed (editors may add wrapper text)
  if (normalizedActual.length > 0 && normalizedActual.includes(normalizedExpected)) {
    return {
      success: true,
      message: `Filled ${desc}: "${text.slice(0, 50)}" (field contains extra formatting)`,
      actualValue,
      elapsedMs: elapsed,
    };
  }

  // Reverse containment — we typed more than what the field shows (truncation)
  if (normalizedExpected.length > 0 && normalizedExpected.includes(normalizedActual) && normalizedActual.length > normalizedExpected.length * 0.8) {
    return {
      success: true,
      message: `Filled ${desc}: "${text.slice(0, 50)}" (minor truncation: ${normalizedActual.length}/${normalizedExpected.length} chars)`,
      actualValue,
      elapsedMs: elapsed,
    };
  }

  // Check for partial match (less than 80% of expected)
  if (normalizedActual.length > 0 && normalizedExpected.startsWith(normalizedActual)) {
    return {
      success: false,
      message: `Partial fill on ${desc}: got ${normalizedActual.length}/${normalizedExpected.length} chars`,
      actualValue,
      elapsedMs: elapsed,
    };
  }

  // Fuzzy match — if >90% of characters match, the field was filled successfully.
  // Editors often auto-correct quotes (' → ‘/’), dashes (-- → —), or add minor formatting.
  // This is NOT a failure — the text was entered and the editor transformed it.
  if (normalizedActual.length > 0 && normalizedExpected.length > 0) {
    const shorter = Math.min(normalizedActual.length, normalizedExpected.length);
    const longer = Math.max(normalizedActual.length, normalizedExpected.length);
    // Length similarity check
    if (shorter / longer > 0.9) {
      // Count matching characters at corresponding positions
      let matches = 0;
      for (let ci = 0; ci < shorter; ci++) {
        if (normalizedActual[ci] === normalizedExpected[ci]) matches++;
      }
      if (matches / longer > 0.9) {
        return {
          success: true,
          message: `Filled ${desc}: "${text.slice(0, 50)}" (${Math.round(matches / longer * 100)}% match, editor may have auto-formatted)`,
          actualValue,
          elapsedMs: elapsed,
        };
      }
    }
  }

  // Rich editors often normalize whitespace or strip a handful of characters
  // while still preserving the actual text content. Treat very small deltas as success.
  if (normalizedActual.length > 0 && normalizedExpected.length > 0) {
    const lengthDelta = Math.abs(normalizedExpected.length - normalizedActual.length);
    if (lengthDelta <= 6) {
      const shorterText = normalizedActual.length <= normalizedExpected.length ? normalizedActual : normalizedExpected;
      const longerText = normalizedActual.length > normalizedExpected.length ? normalizedActual : normalizedExpected;
      if (longerText.includes(shorterText) || shorterText.length / longerText.length >= 0.98) {
        return {
          success: true,
          message: `Filled ${desc}: "${text.slice(0, 50)}" (minor editor normalization: ${normalizedActual.length}/${normalizedExpected.length} chars)`,
          actualValue,
          elapsedMs: elapsed,
        };
      }
    }
  }

  // Field is empty — typing didn't register at all
  if (normalizedActual.length === 0) {
    return {
      success: false,
      message: `Fill failed on ${desc}: field is empty after typing. Native input events may not have reached the element.`,
      actualValue: '',
      elapsedMs: elapsed,
    };
  }

  // Content doesn't match at all
  return {
    success: false,
    message: `Type mismatch on ${desc}: expected "${normalizedExpected.slice(0, 40)}" but got "${normalizedActual.slice(0, 40)}" (lengths: ${normalizedExpected.length} vs ${normalizedActual.length})`,
    actualValue,
    elapsedMs: elapsed,
  };
}

// ═══════════════════════════════════
// Utility
// ═══════════════════════════════════

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
