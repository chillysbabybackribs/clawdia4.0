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
import { getCurrentUrl, getHarnessContextForUrl } from '../browser/manager';
import { getDesktopCapabilities, getGuiState, warmCoordinatesForApp } from './executors/desktop-executors';
import { getStateSummary } from './gui/ui-state';
import { getShortcutPromptBlock } from './gui/shortcuts';
import {
  compileBrowserExecutionSketch,
  compileTaskExecutionGraphScaffold,
  formatBrowserExecutionSketch,
  type BrowserExecutionSketch,
  type TaskExecutionGraphScaffold,
} from './task-compiler';
import {
  extractAppName, discoverApps, routeTask, scanHarnesses,
  recordSurfaceUsage, autoInstallHarness, getAppProfile,
} from '../db/app-registry';
import { buildCapabilitySnapshot, formatSnapshotLog } from './capability-snapshot';
import { installApp } from './loop-app-install';
import { runHarnessPipeline } from './loop-harness';
import { registerNestedCancel, clearNestedCancel } from './loop-cancel';
import type { ProviderClient } from './provider/base';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// One-time warning flags — prevent repeating the same notice every desktop task
let _degradedWarningEmitted = false;
let _nonAnthropicHarnessWarningEmitted = false;

export function isExplicitHarnessRequest(message: string): boolean {
  return /\b(?:cli-anything|cli anything|agent-harness|agent harness|build (?:a )?harness|generate (?:a )?harness|create (?:a )?harness|install (?:a )?harness|\/cli-anything)\b/i.test(message);
}

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
  harnessContext: string;
  desktopContext: string;
  executionSketchContext: string;
  browserExecutionSketch: BrowserExecutionSketch | null;
  executionGraphContext: string;
  executionGraphScaffold: TaskExecutionGraphScaffold | null;
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
  client: ProviderClient,
  onProgress?: (text: string) => void,
  options: { enableExecutionGraphScaffold?: boolean; allowedTools?: string[] } = {},
): Promise<SetupResult> {
  const result: SetupResult = {
    memoryContext: '',
    recallContext: '',
    siteContext: '',
    playbookContext: '',
    harnessContext: '',
    desktopContext: '',
    executionSketchContext: '',
    browserExecutionSketch: null,
    executionGraphContext: '',
    executionGraphScaffold: null,
    executionPlan: null,
    shortcutContext: '',
    guiStateContext: '',
  };

  const allowedToolSet = new Set(options.allowedTools || []);
  const hasScopedAllowedTools = allowedToolSet.size > 0;
  const desktopToolNames = ['app_control', 'gui_interact', 'dbus_control'];
  const desktopSetupAllowedByTools = !hasScopedAllowedTools || desktopToolNames.some((toolName) => allowedToolSet.has(toolName));
  const isDesktopTask = profile.promptModules.has('desktop_apps') && desktopSetupAllowedByTools;
  const explicitHarnessRequest = isExplicitHarnessRequest(userMessage);
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
        if (profile.promptModules.has('browser')) {
          try {
            const currentUrl = getCurrentUrl();
            if (currentUrl) {
              result.harnessContext = getHarnessContextForUrl(currentUrl);
              if (result.harnessContext) {
                console.log('[Harness] Injecting site harness context for current page');
              }
            }
          } catch {}
        }
        if (profile.promptModules.has('browser')) {
          try {
            const sketch = compileBrowserExecutionSketch(userMessage);
            result.browserExecutionSketch = sketch;
            result.executionSketchContext = formatBrowserExecutionSketch(sketch);
            if (result.executionSketchContext) {
              console.log('[TaskCompiler] Injecting browser execution sketch for compound task');
            }
          } catch {}
        }
        if (options.enableExecutionGraphScaffold !== false) {
          try {
            const scaffold = compileTaskExecutionGraphScaffold(userMessage);
            result.executionGraphScaffold = scaffold;
            result.executionGraphContext = [
              '[EXECUTION GRAPH SCAFFOLD]',
              `Summary: ${scaffold.planner.summary}`,
              `Topology: serial_stages=${scaffold.planner.topology.serialStages}, parallel_branches=${scaffold.planner.topology.parallelBranches}`,
              `Nodes: ${scaffold.planner.graph.nodes.map((node) => `${node.id}:${node.executor.kind}`).join(', ')}`,
            ].join('\n');
            console.log('[TaskCompiler] Generated execution graph scaffold');
          } catch {}
        }
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

        // ── Generate harness only when the user explicitly asks for one ──
        if (appAvailable && explicitHarnessRequest && client.supportsHarnessGeneration) {
          const existingProfile = getAppProfile(targetApp);
          const hasHarness = existingProfile?.cliAnything?.installed === true;
          if (!hasHarness) {
            onProgress?.(`No CLI harness found for ${targetApp} — building one now. This takes a few minutes...`);
            let built = false;
            try {
              built = await runHarnessPipeline(targetApp, {
                client,
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
        } else if (appAvailable && explicitHarnessRequest && !client.supportsHarnessGeneration && !_nonAnthropicHarnessWarningEmitted) {
          _nonAnthropicHarnessWarningEmitted = true;
          onProgress?.(`Skipping automatic CLI harness generation for ${targetApp} — not supported by the active provider (${client.provider}).`);
        }
        // Note: clearNestedCancel() not needed here — registerNestedCancel was never called
        // because we skipped the harness pipeline due to install failure.

        // ── EXISTING: Route (now reads updated profile from SQLite) ──
        result.executionPlan = routeTask(userMessage, targetApp);
        console.log(`[Router] App: ${targetApp} → surface: ${result.executionPlan.selectedSurface} | reasoning: ${result.executionPlan.reasoning}`);

        // Auto-install a pre-built CLI-Anything harness only on explicit request
        if (explicitHarnessRequest && result.executionPlan.selectedSurface !== 'cli_anything') {
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
    // ── Degraded-mode notifications ──
    try {
      const { getCapabilityStatus } = await import('./executors/desktop-executors');
      const caps = await getCapabilityStatus();

      const missing: string[] = [];
      if (!caps.xdotool) missing.push('xdotool (install: sudo apt install xdotool)');
      if (!caps.cliAnythingPlugin) missing.push('CLI-Anything plugin (clone to ~/CLI-Anything/cli-anything-plugin/)');
      // AT-SPI only flagged when xdotool is also missing (xdotool is the primary fallback)
      if (!caps.a11y && !caps.xdotool) missing.push('AT-SPI (install: sudo apt install gir1.2-atspi-2.0)');

      if (missing.length > 0 && !_degradedWarningEmitted) {
        _degradedWarningEmitted = true;
        const notice = `[Desktop] Running in degraded mode — missing: ${missing.join(', ')}. Some desktop automation capabilities are reduced.`;
        console.warn(notice);
        onProgress?.(notice);
      }
    } catch { /* non-fatal */ }

    // ── Capability snapshot ──
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
