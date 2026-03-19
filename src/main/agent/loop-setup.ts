/**
 * Loop Setup — Pre-LLM parallel setup phase.
 *
 * Runs all independent setup tasks in parallel before the first LLM call:
 *   - Memory context (sync SQLite)
 *   - Conversation recall (sync SQLite FTS)
 *   - Site context + playbook injection
 *   - Desktop: scanHarnesses + getCapabilities + discoverApps + routing
 *   - Capability snapshot logging
 *
 * Returns a SetupResult that the loop orchestrator consumes.
 */

import type { TaskProfile, ToolGroup } from './classifier';
import type { ExecutionPlan } from '../db/app-registry';
import { getPromptContext } from '../db/memory';
import { checkRecall } from '../db/conversation-recall';
import { getSiteContextPrompt } from '../db/site-profiles';
import { getPlaybookPrompt } from '../db/browser-playbooks';
import { getDesktopCapabilities, getGuiState, warmCoordinatesForApp } from './executors/desktop-executors';
import { getStateSummary } from './gui/ui-state';
import { getShortcutPromptBlock } from './gui/shortcuts';
import {
  extractAppName, discoverApps, routeTask, scanHarnesses,
  recordSurfaceUsage, autoInstallHarness, getAppProfile,
} from '../db/app-registry';
import { buildCapabilitySnapshot, formatSnapshotLog } from './capability-snapshot';
import { installApp } from './loop-app-install';
import { runHarnessPipeline } from './loop-harness';
import { registerNestedCancel, clearNestedCancel } from './loop-cancel';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function cmdExists(cmd: string): Promise<boolean> {
  const safeCmd = cmd.replace(/[^a-z0-9-]/gi, '');
  if (!safeCmd) return false;
  try {
    await execAsync(`which ${safeCmd} 2>/dev/null`, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export interface SetupResult {
  memoryContext: string;
  recallContext: string;
  siteContext: string;
  playbookContext: string;
  desktopContext: string;
  executionPlan: ExecutionPlan | null;
  shortcutContext: string;
  guiStateContext: string;
}

/**
 * Run all pre-LLM setup tasks in parallel.
 *
 * Memory/recall and desktop setup are independent branches
 * that execute concurrently via Promise.all.
 */
export async function runPreLLMSetup(
  userMessage: string,
  profile: TaskProfile,
  apiKey: string,
  onProgress?: (text: string) => void,
): Promise<SetupResult> {
  const result: SetupResult = {
    memoryContext: '',
    recallContext: '',
    siteContext: '',
    playbookContext: '',
    desktopContext: '',
    executionPlan: null,
    shortcutContext: '',
    guiStateContext: '',
  };

  const isDesktopTask = profile.promptModules.has('desktop_apps');
  const needsMemory = !profile.isGreeting && userMessage.length > 10;

  const tasks: Promise<void>[] = [];

  // ── Memory + recall (sync SQLite, wrapped in async) ──
  if (needsMemory) {
    tasks.push((async () => {
      try { result.memoryContext = getPromptContext(300, undefined); } catch {}
      try {
        const recall = checkRecall(userMessage, null);
        if (recall.triggered) {
          result.recallContext = recall.promptBlock;
          console.log(`[Recall] ${recall.reason}: ${recall.exchanges.length} exchange(s) from past conversations`);
        }
      } catch {}
      try { result.siteContext = getSiteContextPrompt(); } catch {}
      if (profile.toolGroup !== 'core') {
        try {
          result.playbookContext = getPlaybookPrompt(userMessage);
          if (result.playbookContext) {
            console.log(`[Playbook] Injecting learned navigation for this task`);
          }
        } catch {}
      }
    })());
  }

  // ── Desktop setup: harness scan + capabilities + app discovery ──
  if (isDesktopTask) {
    tasks.push((async () => {
      const t0 = Date.now();

      const [, , targetApp] = await Promise.all([
        scanHarnesses().catch(() => {}),
        getDesktopCapabilities().then(c => { result.desktopContext = c; }).catch(() => {}),
        Promise.resolve(extractAppName(userMessage)).then(sync =>
          sync || discoverApps(userMessage),
        ),
      ]);

      if (targetApp) {
        // ── NEW: Install app if binary is missing ──
        const binaryMissing = !(await cmdExists(targetApp));
        let appAvailable = !binaryMissing;
        if (binaryMissing) {
          try {
            appAvailable = await installApp(targetApp, onProgress ?? (() => {}));
          } catch (e: any) {
            console.warn(`[Install] installApp threw unexpectedly: ${e.message}`);
            appAvailable = false;
          }
        }

        // ── NEW: Generate harness if none exists (only when app is available) ──
        if (appAvailable) {
          const existingProfile = getAppProfile(targetApp);
          const hasHarness = existingProfile?.cliAnything?.installed === true;
          if (!hasHarness) {
            onProgress?.(`No CLI harness found for ${targetApp} — building one now. This takes a few minutes...`);
            let built = false;
            try {
              built = await runHarnessPipeline(targetApp, {
                apiKey,
                onProgress: onProgress ?? (() => {}),
                onRegisterCancel: registerNestedCancel,
              });
            } finally {
              clearNestedCancel();
            }
            if (!built) {
              onProgress?.(`Harness generation failed — falling back to available surfaces.`);
            }
          }
        }
        // Note: clearNestedCancel() not needed here — registerNestedCancel was never called
        // because we skipped the harness pipeline due to install failure.

        // ── EXISTING: Route (now reads updated profile from SQLite) ──
        result.executionPlan = routeTask(userMessage, targetApp);
        console.log(`[Router] App: ${targetApp} → surface: ${result.executionPlan.selectedSurface} | reasoning: ${result.executionPlan.reasoning}`);

        // Auto-install CLI-Anything harness if available but not installed
        if (result.executionPlan.selectedSurface !== 'cli_anything') {
          try {
            const installed = await autoInstallHarness(targetApp);
            if (installed) {
              result.executionPlan = routeTask(userMessage, targetApp);
              console.log(`[Router] Re-routed after auto-install: ${targetApp} → surface: ${result.executionPlan.selectedSurface}`);
            }
          } catch (err: any) {
            console.warn(`[CLI-Anything] Auto-install error for ${targetApp}: ${err.message}`);
          }
        }

        recordSurfaceUsage(result.executionPlan.selectedSurface);
        result.shortcutContext = getShortcutPromptBlock(targetApp);
        warmCoordinatesForApp(targetApp);
      }

      const guiState = getGuiState();
      result.guiStateContext = getStateSummary(guiState);
      console.log(`[Setup] Desktop setup: ${Date.now() - t0}ms`);
    })());
  }

  // Run all tasks in parallel
  if (tasks.length > 0) {
    const t0 = Date.now();
    await Promise.all(tasks);
    console.log(`[Agent] Pre-LLM setup: ${Date.now() - t0}ms (${tasks.length} parallel task(s))`);
  }

  // Capability snapshot logging
  if (isDesktopTask) {
    const appProfile = result.executionPlan?.appProfile || null;
    const appId = result.executionPlan?.appId || null;
    const capStr = result.desktopContext || '';
    const sysCaps = {
      xdotool: capStr.includes('xdotool'),
      dbus: capStr.includes('DBus: available'),
      a11y: capStr.includes('AT-SPI') && !capStr.includes('not installed'),
    };
    const snapshot = buildCapabilitySnapshot(appId, result.executionPlan, appProfile, sysCaps);
    console.log(formatSnapshotLog(snapshot));
  }

  return result;
}
