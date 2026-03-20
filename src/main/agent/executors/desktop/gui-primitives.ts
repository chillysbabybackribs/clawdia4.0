import {
  cacheTarget,
  recordFocus,
  recordSuccess,
  recordError,
  recordScreenshot,
} from '../../gui/ui-state';
import {
  storeCoordinate,
  invalidateCoordinate,
} from '../../../db/coordinate-cache';
import { run, cmdExists, wait } from './shared';
import { guiState } from './gui-state';
import { smartFocus } from './smart-focus';
import { shouldVerifyAction, postActionVerify } from './action-verify';
import { runScreenshotAnalyzer } from './screenshot-analyzer';

/**
 * Handle primitive GUI actions.
 * Returns null for any action this handler does not own (dispatcher falls through).
 */
export async function execPrimitiveAction(
  input: Record<string, any>,
  batchWindow?: string,
): Promise<string | null> {
  const { action, window: winName, x, y, text, delay: inputDelay } = input;
  const delayMs = inputDelay || 0;
  const effectiveWindow = winName || batchWindow;

  switch (action) {
    case 'list_windows': {
      if (!await cmdExists('wmctrl')) return '[Error] wmctrl not installed. Run: sudo apt install wmctrl';
      return await run('wmctrl -l -p');
    }

    case 'find_window': {
      if (!effectiveWindow) return '[Error] window name required.';
      if (!await cmdExists('xdotool')) return '[Error] xdotool not installed.';
      const ids = await run(`xdotool search --name "${effectiveWindow}" 2>/dev/null`);
      if (ids.startsWith('[Error]') || ids === '[No output]') return `No windows matching "${effectiveWindow}".`;
      const wids = ids.split('\n').filter(Boolean).slice(0, 5);
      const details: string[] = [];
      for (const wid of wids) {
        details.push(`  ${wid}: ${await run(`xdotool getwindowname ${wid} 2>/dev/null`)}`);
      }
      return `Found ${wids.length} window(s):\n${details.join('\n')}`;
    }

    case 'focus': {
      if (!effectiveWindow) return '[Error] window name required.';
      const { skipped } = await smartFocus(effectiveWindow);
      if (delayMs) await wait(delayMs);
      return skipped
        ? `Focused: "${effectiveWindow}" [cached — already focused]`
        : `Focused: "${effectiveWindow}"`;
    }

    case 'click': {
      if (x == null || y == null) return '[Error] x and y coordinates required.';
      if (!await cmdExists('xdotool')) return '[Error] xdotool not installed.';
      if (effectiveWindow) {
        const { focused, skipped } = await smartFocus(effectiveWindow);
        if (!focused) return `[Error] Could not focus "${effectiveWindow}" — aborting click to prevent interaction with wrong window.`;
        if (!skipped) await wait(100);
      }
      if (delayMs) await wait(delayMs);
      const clickResult = await run(`xdotool mousemove ${x} ${y} click 1`);
      if (clickResult.startsWith('[Error]')) {
        if (effectiveWindow && guiState.activeApp) {
          const hitTarget = Object.entries(guiState.knownTargets)
            .find(([, t]) => t.x === x && t.y === y);
          if (hitTarget) invalidateCoordinate(guiState.activeApp, effectiveWindow, hitTarget[0]);
        }
        recordError(guiState, 'click', `(${x},${y})`);
        return clickResult;
      }
      recordSuccess(guiState, 'click', `(${x},${y})`);
      if (effectiveWindow && guiState.activeApp) {
        const hitTarget = Object.entries(guiState.knownTargets)
          .find(([, t]) => t.x === x && t.y === y);
        if (hitTarget) {
          storeCoordinate(guiState.activeApp, effectiveWindow, hitTarget[0], x, y, guiState.confidence);
        }
      }
      let verifyBlock = '';
      if (shouldVerifyAction('click', input, x, y)) {
        verifyBlock = await postActionVerify(effectiveWindow);
      }
      return `Clicked (${x}, ${y})${verifyBlock ? '\n' + verifyBlock : ''}`;
    }

    case 'type': {
      if (!text) return '[Error] text required.';
      if (!await cmdExists('xdotool')) return '[Error] xdotool not installed.';
      if (effectiveWindow) {
        const { focused, skipped } = await smartFocus(effectiveWindow);
        if (!focused) return `[Error] Could not focus "${effectiveWindow}" — aborting type to prevent text entry into wrong window.`;
        if (!skipped) await wait(100);
      }
      if (delayMs) await wait(delayMs);
      await run(`xdotool type --delay 15 -- "${text.replace(/"/g, '\\"')}"`);
      recordSuccess(guiState, 'type', text.slice(0, 30));
      return `Typed "${text.slice(0, 50)}"`;
    }

    case 'key': {
      if (!text) return '[Error] key combo required.';
      if (!await cmdExists('xdotool')) return '[Error] xdotool not installed.';
      if (effectiveWindow) {
        const { focused, skipped } = await smartFocus(effectiveWindow);
        if (!focused) return `[Error] Could not focus "${effectiveWindow}" — aborting key press to prevent interaction with wrong window.`;
        if (!skipped) await wait(100);
      }
      if (delayMs) await wait(delayMs);
      await run(`xdotool key ${text}`);
      recordSuccess(guiState, 'key', text);
      let keyVerifyBlock = '';
      if (shouldVerifyAction('key', input)) {
        keyVerifyBlock = await postActionVerify(effectiveWindow);
      }
      return `Key: ${text}${keyVerifyBlock ? '\n' + keyVerifyBlock : ''}`;
    }

    case 'screenshot': {
      const filename = `/tmp/clawdia-screenshot-${Date.now()}.png`;
      if (effectiveWindow) { await run(`wmctrl -a "${effectiveWindow}" 2>/dev/null`); await wait(200); }
      if (delayMs) await wait(delayMs);
      if (await cmdExists('scrot')) { await run(`scrot ${effectiveWindow ? '-u ' : ''}${filename}`); }
      else if (await cmdExists('gnome-screenshot')) { await run(`gnome-screenshot -f ${filename}`); }
      else if (await cmdExists('import')) { await run(`import -window root ${filename}`); }
      else { return '[Error] No screenshot tool. Install: sudo apt install scrot'; }
      recordScreenshot(guiState);
      if (effectiveWindow) recordFocus(guiState, effectiveWindow, '');
      return `[Screenshot: ${filename}]`;
    }

    case 'screenshot_and_focus': {
      if (!effectiveWindow) return '[Error] window name required.';
      await smartFocus(effectiveWindow);
      await wait(250);
      const filename = `/tmp/clawdia-screenshot-${Date.now()}.png`;
      if (await cmdExists('scrot')) { await run(`scrot -u ${filename}`); }
      else if (await cmdExists('gnome-screenshot')) { await run(`gnome-screenshot -f ${filename}`); }
      else { return `Focused: "${effectiveWindow}" [No screenshot tool]`; }
      recordScreenshot(guiState);
      const windows = await run('wmctrl -l 2>/dev/null');
      let ocrBlock = '';
      if (await cmdExists('tesseract')) {
        const analysis = await runScreenshotAnalyzer(filename, { title: effectiveWindow });
        if (analysis) {
          ocrBlock = '\n\n[OCR Analysis]\n' + analysis.summary;
          for (const t of analysis.targets) {
            cacheTarget(guiState, t.label, t.x, t.y);
          }
          console.log(`[Desktop] OCR: ${analysis.targets.length} click targets cached`);
        }
      }
      return `Focused: "${effectiveWindow}"\n[Screenshot: ${filename}]${ocrBlock}\n\nOpen windows:\n${windows}`;
    }

    case 'wait':
    case 'delay': {
      const waitMs = inputDelay || (input.ms as number) || 500;
      await wait(waitMs);
      return `Waited ${waitMs}ms`;
    }

    case 'verify_window_title': {
      const title = await run('xdotool getactivewindow getwindowname 2>/dev/null');
      if (title.startsWith('[Error]')) return title;
      const trimmed = title.trim();
      if (trimmed) recordFocus(guiState, trimmed, '');
      return `Active window: "${trimmed}"`;
    }

    case 'verify_file_exists': {
      const filePath = input.path || text;
      if (!filePath) return '[Error] path or text (filepath) required.';
      const stat = await run(`stat --printf="%s bytes, modified %y" "${filePath}" 2>/dev/null`);
      if (stat.startsWith('[Error]')) return `File not found: ${filePath}`;
      return `File exists: ${filePath} (${stat})`;
    }

    case 'analyze_screenshot': {
      const filename = `/tmp/clawdia-screenshot-${Date.now()}.png`;
      let analyzeWindow = effectiveWindow;
      if (!analyzeWindow && guiState.focusedWindow) {
        analyzeWindow = guiState.focusedWindow.title;
        console.log(`[Desktop] analyze_screenshot: auto-using focused window "${analyzeWindow}"`);
      }
      if (analyzeWindow) {
        await smartFocus(analyzeWindow);
        await wait(250);
      }
      if (await cmdExists('scrot')) {
        await run(`scrot ${analyzeWindow ? '-u ' : ''}${filename}`);
      } else {
        return '[Error] No screenshot tool installed. Run: sudo apt install scrot';
      }
      recordScreenshot(guiState);
      if (!await cmdExists('tesseract')) {
        return `[Screenshot: ${filename}]\n[Warning] tesseract not installed — OCR unavailable. Run: sudo apt install tesseract-ocr`;
      }
      const analysis = await runScreenshotAnalyzer(filename, { title: analyzeWindow || '' });
      if (!analysis) {
        return `[Screenshot: ${filename}]\n[OCR analysis failed — raw screenshot available at path above]`;
      }
      for (const t of analysis.targets) {
        cacheTarget(guiState, t.label, t.x, t.y);
        if (guiState.activeApp) {
          storeCoordinate(guiState.activeApp, analyzeWindow || '', t.label, t.x, t.y, guiState.confidence);
        }
      }
      if (analysis.targets.length > 0) {
        console.log(`[Desktop] OCR: ${analysis.targets.length} click targets cached (memory + SQLite)`);
      }
      return `[Screenshot: ${filename}]\n\n${analysis.summary}`;
    }

    case 'screenshot_region': {
      const { rx, ry, rw, rh } = input;
      if (rx == null || ry == null || rw == null || rh == null) {
        return '[Error] screenshot_region requires rx, ry, rw, rh (region x, y, width, height).';
      }
      const filename = `/tmp/clawdia-screenshot-${Date.now()}.png`;
      if (await cmdExists('scrot')) {
        await run(`scrot -a ${rx},${ry},${rw},${rh} ${filename}`);
      } else if (await cmdExists('import')) {
        await run(`import -window root -crop ${rw}x${rh}+${rx}+${ry} ${filename}`);
      } else {
        return '[Error] No region screenshot tool. Install: sudo apt install scrot';
      }
      recordScreenshot(guiState);
      return `[Screenshot: ${filename}] (region: ${rw}x${rh} at ${rx},${ry})`;
    }

    default:
      return null;
  }
}
