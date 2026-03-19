/**
 * Desktop Tool Executors — 3-tier application control.
 * 
 * Tier 1: app_control — CLI-Anything harness (structured JSON)
 * Tier 2: gui_interact — xdotool/wmctrl/scrot (any visible window)
 *         Includes batch_actions and screenshot_and_focus for efficiency
 * Tier 3: dbus_control — DBus interfaces (programmatic control)
 *
 * Optimizations:
 *   - cmdExists() cached at module level (no repeated `which` forks)
 *   - batch_actions default delay 100ms
 *   - screenshot_and_focus wait 250ms
 *   - Display layout detected once via xrandr (prevents coordinate probing loops)
 *   - Python imaging tools detected (Pillow, ImageMagick) for programmatic routing
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';

const execAsync = promisify(exec);
const TIMEOUT = 30_000;

// ═══════════════════════════════════
// Helpers
// ═══════════════════════════════════

async function run(command: string, timeout = TIMEOUT): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout,
      cwd: os.homedir(),
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
      maxBuffer: 1024 * 1024 * 2,
    });
    let result = stdout.trim();
    if (stderr.trim()) result += (result ? '\n[stderr] ' : '[stderr] ') + stderr.trim();
    return result || '[No output]';
  } catch (err: any) {
    const out = err.stdout?.trim() || '';
    const se = err.stderr?.trim() || '';
    return `[Error] ${se || out || err.message}`;
  }
}

const toolCache: Record<string, boolean> = {};
async function cmdExists(cmd: string): Promise<boolean> {
  if (cmd in toolCache) return toolCache[cmd];
  try { await execAsync(`which ${cmd} 2>/dev/null`); toolCache[cmd] = true; }
  catch { toolCache[cmd] = false; }
  return toolCache[cmd];
}

function wait(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ═══════════════════════════════════
// Tier 1: CLI-Anything Harness
// ═══════════════════════════════════

export async function executeAppControl(input: Record<string, any>): Promise<string> {
  const { app, command, json = true } = input;
  if (!app || !command) return '[Error] app and command are required.';

  const appName = app.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const harness = `cli-anything-${appName}`;
  const hasHarness = await cmdExists(harness);

  if (!hasHarness) {
    const hasNative = await cmdExists(appName);
    if (!hasNative) {
      return `[No CLI-Anything harness or native CLI found for "${app}"]

To install: git clone https://github.com/HKUDS/CLI-Anything.git
Or launch: shell_exec("${appName} &")`;
    }
    console.log(`[Desktop] No harness for ${app}, using native CLI`);
    return await run(`${appName} ${command}`, 60_000);
  }

  const flag = json ? ' --json' : '';
  console.log(`[Desktop] CLI-Anything: ${harness}${flag} ${command}`);
  return await run(`${harness}${flag} ${command}`, 60_000);
}

// ═══════════════════════════════════
// Tier 2: GUI Automation
// ═══════════════════════════════════

async function execSingleAction(input: Record<string, any>): Promise<string> {
  const { action, window: winName, x, y, text, delay: inputDelay } = input;
  const delayMs = inputDelay || 0;

  switch (action) {
    case 'list_windows': {
      if (!await cmdExists('wmctrl')) return '[Error] wmctrl not installed. Run: sudo apt install wmctrl';
      return await run('wmctrl -l -p');
    }

    case 'find_window': {
      if (!winName) return '[Error] window name required.';
      if (!await cmdExists('xdotool')) return '[Error] xdotool not installed.';
      const ids = await run(`xdotool search --name "${winName}" 2>/dev/null`);
      if (ids.startsWith('[Error]') || ids === '[No output]') return `No windows matching "${winName}".`;
      const wids = ids.split('\n').filter(Boolean).slice(0, 5);
      const details: string[] = [];
      for (const wid of wids) {
        details.push(`  ${wid}: ${await run(`xdotool getwindowname ${wid} 2>/dev/null`)}`);
      }
      return `Found ${wids.length} window(s):\n${details.join('\n')}`;
    }

    case 'focus': {
      if (!winName) return '[Error] window name required.';
      if (await cmdExists('wmctrl')) {
        await run(`wmctrl -a "${winName}" 2>&1`);
        if (delayMs) await wait(delayMs);
        return `Focused: "${winName}"`;
      }
      if (!await cmdExists('xdotool')) return '[Error] Neither wmctrl nor xdotool installed.';
      const wid = await run(`xdotool search --name "${winName}" | head -1`);
      if (!wid || wid.startsWith('[Error]')) return `Window "${winName}" not found.`;
      await run(`xdotool windowactivate ${wid.trim()}`);
      if (delayMs) await wait(delayMs);
      return `Focused: "${winName}"`;
    }

    case 'click': {
      if (x == null || y == null) return '[Error] x and y coordinates required.';
      if (!await cmdExists('xdotool')) return '[Error] xdotool not installed.';
      if (winName) { await run(`wmctrl -a "${winName}" 2>/dev/null`); await wait(100); }
      if (delayMs) await wait(delayMs);
      await run(`xdotool mousemove ${x} ${y} click 1`);
      return `Clicked (${x}, ${y})`;
    }

    case 'type': {
      if (!text) return '[Error] text required.';
      if (!await cmdExists('xdotool')) return '[Error] xdotool not installed.';
      if (winName) { await run(`wmctrl -a "${winName}" 2>/dev/null`); await wait(100); }
      if (delayMs) await wait(delayMs);
      await run(`xdotool type --delay 15 -- "${text.replace(/"/g, '\\"')}"`);
      return `Typed "${text.slice(0, 50)}"`;
    }

    case 'key': {
      if (!text) return '[Error] key combo required.';
      if (!await cmdExists('xdotool')) return '[Error] xdotool not installed.';
      if (winName) { await run(`wmctrl -a "${winName}" 2>/dev/null`); await wait(100); }
      if (delayMs) await wait(delayMs);
      await run(`xdotool key ${text}`);
      return `Key: ${text}`;
    }

    case 'screenshot': {
      const filename = `/tmp/clawdia-screenshot-${Date.now()}.png`;
      if (winName) { await run(`wmctrl -a "${winName}" 2>/dev/null`); await wait(200); }
      if (delayMs) await wait(delayMs);
      if (await cmdExists('scrot')) { await run(`scrot ${winName ? '-u ' : ''}${filename}`); }
      else if (await cmdExists('gnome-screenshot')) { await run(`gnome-screenshot -f ${filename}`); }
      else if (await cmdExists('import')) { await run(`import -window root ${filename}`); }
      else { return '[Error] No screenshot tool. Install: sudo apt install scrot'; }
      return `[Screenshot: ${filename}]`;
    }

    case 'screenshot_and_focus': {
      if (!winName) return '[Error] window name required.';
      await run(`wmctrl -a "${winName}" 2>/dev/null`);
      await wait(250);
      const filename = `/tmp/clawdia-screenshot-${Date.now()}.png`;
      if (await cmdExists('scrot')) { await run(`scrot -u ${filename}`); }
      else if (await cmdExists('gnome-screenshot')) { await run(`gnome-screenshot -f ${filename}`); }
      else { return `Focused: "${winName}" [No screenshot tool]`; }
      const windows = await run('wmctrl -l 2>/dev/null');
      return `Focused: "${winName}"\n[Screenshot: ${filename}]\n\nOpen windows:\n${windows}`;
    }

    default:
      return `[Error] Unknown action: "${action}"`;
  }
}

export async function executeGuiInteract(input: Record<string, any>): Promise<string> {
  const { action } = input;
  if (!action) return '[Error] action is required.';

  const sessionType = process.env.XDG_SESSION_TYPE || '';
  if (sessionType === 'wayland' && action !== 'list_windows') {
    return `[Warning] GUI automation requires X11. Detected: Wayland.`;
  }

  if (action === 'batch_actions') {
    const actions = input.actions as Record<string, any>[];
    if (!actions || !Array.isArray(actions) || actions.length === 0) {
      return '[Error] batch_actions requires an "actions" array.';
    }
    if (actions.length > 20) return '[Error] Max 20 steps per batch.';

    const results: string[] = [];
    for (let i = 0; i < actions.length; i++) {
      const step = actions[i];
      if (!step.action) { results.push(`[Step ${i + 1}] [Error] Missing action`); continue; }
      if (!step.delay && (step.action === 'click' || step.action === 'key')) step.delay = 100;

      const stepResult = await execSingleAction(step);
      results.push(`[Step ${i + 1}: ${step.action}] ${stepResult}`);
      if (stepResult.startsWith('[Error]')) console.warn(`[Desktop] Batch step ${i + 1} failed: ${stepResult}`);
    }
    return results.join('\n');
  }

  return await execSingleAction(input);
}

// ═══════════════════════════════════
// Tier 3: DBus Control
// ═══════════════════════════════════

export async function executeDbusControl(input: Record<string, any>): Promise<string> {
  const { action, service, path: objPath, interface: iface, method, args = [] } = input;
  if (!action) return '[Error] action is required.';
  if (!await cmdExists('dbus-send')) return '[Error] dbus-send not found.';

  switch (action) {
    case 'list_running': {
      const raw = await run(`dbus-send --session --dest=org.freedesktop.DBus --type=method_call --print-reply /org/freedesktop/DBus org.freedesktop.DBus.ListNames`);
      const lines = raw.split('\n').filter(l => l.includes('string "')).map(l => l.match(/string "(.+)"/)?.[1])
        .filter((s): s is string => !!s && !s.startsWith(':') && !s.startsWith('org.freedesktop.') && s.includes('.')).sort();
      if (lines.length === 0) return 'No interesting DBus services found.';
      return `Active DBus services (${lines.length}):\n${lines.map(s => `  ${s}`).join('\n')}`;
    }
    case 'discover': {
      if (!service) return '[Error] service name required.';
      const path = objPath || '/';
      const result = await run(`dbus-send --session --dest=${service} --type=method_call --print-reply ${path} org.freedesktop.DBus.Introspectable.Introspect`);
      const xmlMatch = result.match(/<node[\s\S]*<\/node>/);
      if (xmlMatch) {
        const ifaces = xmlMatch[0].match(/<interface name="([^"]+)">/g)?.map(m => m.match(/name="([^"]+)"/)?.[1]).filter((s): s is string => !!s && !s.startsWith('org.freedesktop.DBus.')) || [];
        const methods = xmlMatch[0].match(/<method name="([^"]+)">/g)?.map(m => m.match(/name="([^"]+)"/)?.[1]).filter(Boolean) || [];
        const props = xmlMatch[0].match(/<property name="([^"]+)"/g)?.map(m => m.match(/name="([^"]+)"/)?.[1]).filter(Boolean) || [];
        let s = `Service: ${service}\nPath: ${path}\n`;
        if (ifaces.length) s += `\nInterfaces:\n${ifaces.map(i => `  ${i}`).join('\n')}`;
        if (methods.length) s += `\nMethods:\n${methods.map(m => `  ${m}()`).join('\n')}`;
        if (props.length) s += `\nProperties:\n${props.map(p => `  ${p}`).join('\n')}`;
        return s;
      }
      return result;
    }
    case 'call': {
      if (!service || !objPath || !iface || !method) return '[Error] service, path, interface, method required.';
      const argsStr = (args as string[]).map(a => `string:"${a}"`).join(' ');
      return await run(`dbus-send --session --dest=${service} --type=method_call --print-reply ${objPath} ${iface}.${method} ${argsStr}`);
    }
    case 'get_property': {
      if (!service || !objPath || !iface || !method) return '[Error] service, path, interface, property required.';
      return await run(`dbus-send --session --dest=${service} --type=method_call --print-reply ${objPath} org.freedesktop.DBus.Properties.Get string:"${iface}" string:"${method}"`);
    }
    default: return `[Error] Unknown action: "${action}".`;
  }
}

// ═══════════════════════════════════
// Capability Discovery — runs once, cached
// ═══════════════════════════════════

let cachedCapabilities: string | null = null;

export async function getDesktopCapabilities(): Promise<string> {
  if (cachedCapabilities) return cachedCapabilities;

  // Check all tools in parallel
  const [xdotool, wmctrl, scrot, dbus, python3, convert] = await Promise.all([
    cmdExists('xdotool'), cmdExists('wmctrl'), cmdExists('scrot'),
    cmdExists('dbus-send'), cmdExists('python3'), cmdExists('convert'),
  ]);

  // Check Python imaging libraries
  let hasPillow = false;
  if (python3) {
    try {
      await execAsync('python3 -c "from PIL import Image" 2>/dev/null', { timeout: 3000 });
      hasPillow = true;
    } catch {}
  }

  // CLI-Anything harnesses
  let harnesses: string[] = [];
  try {
    const { stdout } = await execAsync('bash -c "compgen -c cli-anything-" 2>/dev/null || echo ""', { timeout: 3000 });
    harnesses = stdout.trim().split('\n').map(s => s.replace(/.*cli-anything-/, '').trim()).filter(Boolean);
  } catch {}

  // Display layout via xrandr — critical for multi-monitor coordinate translation
  let displayLayout = '';
  try {
    const { stdout: xrandr } = await execAsync('xrandr --current 2>/dev/null', { timeout: 3000 });
    const monitors = xrandr.split('\n')
      .filter(l => / connected/.test(l))
      .map(l => {
        const name = l.split(' ')[0];
        const primary = l.includes('primary');
        const geom = l.match(/(\d+x\d+\+\d+\+\d+)/)?.[1] || '';
        return `  ${name}: ${geom}${primary ? ' (primary)' : ''}`;
      });
    if (monitors.length > 0) {
      displayLayout = `Monitors (${monitors.length}):\n${monitors.join('\n')}`;
    }
  } catch {}

  const sessionType = process.env.XDG_SESSION_TYPE || 'unknown';

  const lines: string[] = ['[Desktop capabilities]'];
  lines.push(`Display: ${sessionType}${sessionType === 'wayland' ? ' (⚠ xdotool limited)' : ''}`);
  if (displayLayout) lines.push(displayLayout);
  lines.push(`GUI tools: ${[xdotool && 'xdotool', wmctrl && 'wmctrl', scrot && 'scrot'].filter(Boolean).join(', ') || 'none'}`);
  lines.push(`DBus: ${dbus ? 'available' : 'not installed'}`);
  lines.push(`Imaging: ${[hasPillow && 'python3+Pillow', convert && 'ImageMagick'].filter(Boolean).join(', ') || 'none'}`);
  if (harnesses.length > 0) lines.push(`CLI-Anything: ${harnesses.join(', ')}`);
  if (!xdotool && !wmctrl) lines.push('Install GUI tools: sudo apt install xdotool wmctrl scrot');

  cachedCapabilities = lines.join('\n');
  console.log(`[Desktop] ${cachedCapabilities}`);
  return cachedCapabilities;
}
