import * as os from 'os';
import {
  cacheTarget,
  recordSuccess,
  recordError,
  recordScreenshot,
} from '../../gui/ui-state';
import {
  storeCoordinate,
} from '../../../db/coordinate-cache';
import { run, cmdExists, wait } from './shared';
import { guiState } from './gui-state';
import { smartFocus } from './smart-focus';
import { postActionVerify, createMacroTrace } from './action-verify';
import { runScreenshotAnalyzer } from './screenshot-analyzer';

/**
 * Handle macro (composite) GUI actions.
 * Returns null for any action this handler does not own.
 */
export async function execMacroAction(
  input: Record<string, any>,
  batchWindow?: string,
): Promise<string | null> {
  const { action, window: winName, x, y, text, delay: inputDelay } = input;
  const delayMs = inputDelay || 0;
  const effectiveWindow = winName || batchWindow;

  switch (action) {
    case 'launch_and_focus': {
      const appBinary = input.app || text;
      if (!appBinary) return '[Error] launch_and_focus requires "app" (binary name) or "text".';
      const windowMatch = effectiveWindow || appBinary;
      const m = createMacroTrace(`launch_and_focus("${appBinary}")`);

      const launchResult = await m.step('launch', appBinary, async () => {
        await run(`setsid ${appBinary} >/dev/null 2>&1 &`);
        return `Launched ${appBinary} in background`;
      });

      const waitResult = await m.step('wait_for_window', windowMatch, async () => {
        const launchStart = Date.now();
        while (Date.now() - launchStart < 10_000) {
          await wait(500);
          const windows = await run('wmctrl -l 2>/dev/null');
          if (new RegExp(windowMatch, 'i').test(windows)) {
            return `Window "${windowMatch}" appeared after ${Date.now() - launchStart}ms`;
          }
        }
        return `[Error] No window matching "${windowMatch}" appeared within 10s`;
      });
      if (waitResult.startsWith('[Error')) {
        return `${m.finish()}\n${waitResult}. Use list_windows to check.`;
      }

      await m.step('focus', windowMatch, async () => {
        await smartFocus(windowMatch);
        await wait(500);
        return `Focused "${windowMatch}"`;
      });

      let ocrResult = '';
      if (await cmdExists('tesseract') && await cmdExists('scrot')) {
        ocrResult = await m.step('ocr_capture', windowMatch, async () => {
          const filename = `/tmp/clawdia-launch-${Date.now()}.png`;
          await run(`scrot -u ${filename}`);
          recordScreenshot(guiState);
          const analysis = await runScreenshotAnalyzer(filename, { title: windowMatch });
          if (analysis) {
            for (const t of analysis.targets) {
              cacheTarget(guiState, t.label, t.x, t.y);
              if (guiState.activeApp) {
                storeCoordinate(guiState.activeApp, windowMatch, t.label, t.x, t.y, guiState.confidence);
              }
            }
            return analysis.summary;
          }
          return 'OCR returned no results';
        });
      }

      recordSuccess(guiState, 'launch_and_focus', appBinary);
      return `${m.finish()}\n\nResult: Launched and focused "${appBinary}" → "${windowMatch}"${ocrResult ? '\n\n' + ocrResult : ''}`;
    }

    case 'open_menu_path': {
      let menuPath: string[];
      if (Array.isArray(input.path)) {
        menuPath = input.path;
      } else if (typeof input.path === 'string') {
        menuPath = input.path.split(/\s*>\s*/);
      } else if (text) {
        menuPath = text.split(/\s*>\s*/);
      } else {
        return '[Error] open_menu_path requires "path" as array ["File","Export As"] or string "File > Export As".';
      }
      if (menuPath.length === 0) return '[Error] Menu path is empty.';
      const mMenu = createMacroTrace(`open_menu_path("${menuPath.join(' > ')}")`);

      if (effectiveWindow) {
        await mMenu.step('focus', effectiveWindow, async () => {
          const { skipped } = await smartFocus(effectiveWindow!);
          if (!skipped) await wait(100);
          return skipped ? `Focused "${effectiveWindow}" [cached]` : `Focused "${effectiveWindow}"`;
        });
      }

      const firstMenu = menuPath[0].trim();
      const firstLetter = firstMenu[0].toLowerCase();
      await mMenu.step('open_menu', firstMenu, async () => {
        await run(`xdotool key alt+${firstLetter}`);
        await wait(300);
        return `Opened menu "${firstMenu}" via Alt+${firstLetter}`;
      });

      for (let i = 1; i < menuPath.length; i++) {
        const item = menuPath[i].trim();
        const isFinal = i === menuPath.length - 1;
        await mMenu.step(isFinal ? 'activate' : 'navigate', item, async () => {
          for (const char of item.slice(0, 5)) {
            await run(`xdotool key ${char.toLowerCase()}`);
            await wait(50);
          }
          await wait(200);
          if (!isFinal) {
            await run('xdotool key Right');
            await wait(200);
            return `Navigated to submenu "${item}"`;
          } else {
            await run('xdotool key Return');
            await wait(300);
            return `Activated "${item}"`;
          }
        });
      }

      const verifyResult = await postActionVerify(effectiveWindow);
      recordSuccess(guiState, 'open_menu_path', menuPath.join(' > '));
      return `${mMenu.finish()}\n\nResult: Menu ${menuPath.join(' > ')}${verifyResult ? '\n' + verifyResult : ''}`;
    }

    case 'fill_dialog': {
      const fields = input.fields as Array<{ value: string; label?: string }>;
      if (!fields || !Array.isArray(fields) || fields.length === 0) {
        return '[Error] fill_dialog requires "fields" array with {value} objects in tab order.';
      }
      const mFill = createMacroTrace(`fill_dialog(${fields.length} fields)`);

      if (effectiveWindow) {
        await mFill.step('focus', effectiveWindow, async () => {
          const { skipped } = await smartFocus(effectiveWindow!);
          if (!skipped) await wait(100);
          return skipped ? `Focused "${effectiveWindow}" [cached]` : `Focused "${effectiveWindow}"`;
        });
      }

      for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        const value = String(field.value);
        const label = field.label ? ` (${field.label})` : '';
        const fillResult = await mFill.step('fill_field', `field ${i + 1}${label}: "${value.slice(0, 30)}"`, async () => {
          if (i > 0) {
            await run('xdotool key Tab');
            await wait(100);
          }
          await run('xdotool key ctrl+a');
          await wait(50);
          await run(`xdotool type --delay 10 -- "${value.replace(/"/g, '\\"')}"`);
          await wait(100);
          return `Filled field ${i + 1}${label}: "${value.slice(0, 40)}"`;
        });
        if (fillResult.startsWith('[Error')) break;
      }

      const shouldConfirm = input.confirm !== false;
      if (shouldConfirm) {
        await mFill.step('confirm', 'Enter', async () => {
          await wait(200);
          await run('xdotool key Return');
          await wait(300);
          return 'Confirmed (Enter)';
        });
      }

      recordSuccess(guiState, 'fill_dialog', `${fields.length} fields`);
      const verifyResult = shouldConfirm ? await postActionVerify(effectiveWindow) : '';
      return `${mFill.finish()}${verifyResult ? '\n' + verifyResult : ''}`;
    }

    case 'confirm_dialog': {
      const mConfirm = createMacroTrace(`confirm_dialog(${input.button || 'Enter'})`);

      if (effectiveWindow) {
        await mConfirm.step('focus', effectiveWindow, async () => {
          const { skipped } = await smartFocus(effectiveWindow!);
          if (!skipped) await wait(100);
          return skipped ? `Focused "${effectiveWindow}" [cached]` : `Focused "${effectiveWindow}"`;
        });
      }

      const settleMs = input.settle_ms || 300;
      await mConfirm.step('settle', `${settleMs}ms`, async () => {
        await wait(settleMs);
        return `Waited ${settleMs}ms for dialog to settle`;
      });

      if (input.button) {
        const buttonLabel = String(input.button).toLowerCase();
        const target = Object.entries(guiState.knownTargets)
          .find(([label]) => label.toLowerCase().includes(buttonLabel));
        if (target) {
          const [label, coords] = target;
          await mConfirm.step('click_button', label, async () => {
            await run(`xdotool mousemove ${coords.x} ${coords.y} click 1`);
            recordSuccess(guiState, 'confirm_dialog', label);
            return `Clicked "${label}" at (${coords.x}, ${coords.y})`;
          });
          return mConfirm.finish();
        }
        console.log(`[Macro] confirm_dialog: button "${input.button}" not in cache, using Enter`);
      }

      await mConfirm.step('confirm', 'Enter', async () => {
        await run('xdotool key Return');
        recordSuccess(guiState, 'confirm_dialog', 'Enter');
        return 'Pressed Enter';
      });

      const verifyResult = await postActionVerify(effectiveWindow);
      return `${mConfirm.finish()}${verifyResult ? '\n' + verifyResult : ''}`;
    }

    case 'export_file': {
      const exportPath = input.path || input.export_path;
      if (!exportPath) return '[Error] export_file requires "path" (output file path).';
      const mExport = createMacroTrace(`export_file("${exportPath}")`);

      if (effectiveWindow) {
        await mExport.step('focus', effectiveWindow, async () => {
          const { skipped } = await smartFocus(effectiveWindow!);
          if (!skipped) await wait(100);
          return skipped ? `Focused "${effectiveWindow}" [cached]` : `Focused "${effectiveWindow}"`;
        });
      }

      let shortcut = input.shortcut as string | undefined;
      if (!shortcut) {
        const app = input.app || guiState.activeApp || '';
        const { resolveShortcut } = require('../../gui/shortcuts');
        shortcut = resolveShortcut(app, 'export_as') || resolveShortcut(app, 'save_as') || 'ctrl+shift+e';
      }

      await mExport.step('shortcut', shortcut!, async () => {
        await run(`xdotool key ${shortcut}`);
        await wait(800);
        return `Triggered ${shortcut}`;
      });

      await mExport.step('fill_path', exportPath, async () => {
        await run('xdotool key ctrl+a');
        await wait(100);
        await run(`xdotool type --delay 10 -- "${exportPath.replace(/"/g, '\\"')}"`);
        await wait(200);
        return `Typed path: ${exportPath}`;
      });

      await mExport.step('confirm', 'Enter', async () => {
        await run('xdotool key Return');
        await wait(500);
        return 'Pressed Enter to confirm';
      });

      const afterExport = await postActionVerify(effectiveWindow);
      if (afterExport.includes('DIALOG') || afterExport.toLowerCase().includes('overwrite') || afterExport.toLowerCase().includes('replace')) {
        await mExport.step('confirm_overwrite', 'Enter', async () => {
          await wait(200);
          await run('xdotool key Return');
          await wait(300);
          return 'Confirmed overwrite dialog';
        });
      }

      const resolvedPath = exportPath.replace(/^~\//, os.homedir() + '/');
      await mExport.step('verify_file', resolvedPath, async () => {
        const fileCheck = await run(`stat --printf="%s bytes" "${resolvedPath}" 2>/dev/null`);
        return fileCheck.startsWith('[Error]') ? '[Error] File NOT found' : `File: ${fileCheck}`;
      });

      recordSuccess(guiState, 'export_file', exportPath);
      return `${mExport.finish()}${afterExport ? '\n' + afterExport : ''}`;
    }

    case 'click_and_type': {
      if (x == null || y == null) return '[Error] click_and_type requires x, y coordinates.';
      if (!text) return '[Error] click_and_type requires "text" to type.';
      if (!await cmdExists('xdotool')) return '[Error] xdotool not installed.';

      const m = createMacroTrace(`click_and_type(${x},${y},"${text.slice(0, 30)}")`);

      if (effectiveWindow) {
        await m.step('focus', effectiveWindow, async () => {
          const { skipped } = await smartFocus(effectiveWindow!);
          if (!skipped) await wait(100);
          return skipped ? `Focused "${effectiveWindow}" [cached]` : `Focused "${effectiveWindow}"`;
        });
      }

      const clickResult = await m.step('click', `(${x},${y})`, async () => {
        const r = await run(`xdotool mousemove ${x} ${y} click 1`);
        if (r.startsWith('[Error')) return r;
        await wait(100);
        recordSuccess(guiState, 'click', `(${x},${y})`);
        return `Clicked (${x}, ${y})`;
      });
      if (clickResult.startsWith('[Error')) {
        recordError(guiState, 'click_and_type', `click failed at (${x},${y})`);
        return `${m.finish()}\nFailed at click step.`;
      }

      await m.step('type', text.slice(0, 40), async () => {
        await run(`xdotool type --delay 15 -- "${text.replace(/"/g, '\\"')}"`);
        recordSuccess(guiState, 'type', text.slice(0, 30));
        return `Typed "${text.slice(0, 50)}"`;
      });

      recordSuccess(guiState, 'click_and_type', `(${x},${y}) "${text.slice(0, 20)}"`);
      return `${m.finish()}\n\nResult: Clicked (${x},${y}) and typed "${text.slice(0, 50)}"`;
    }

    default:
      return null;
  }
}
