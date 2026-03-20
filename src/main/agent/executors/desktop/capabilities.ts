import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isA11yAvailable } from '../../gui/a11y';
import { listProfiles } from '../../../db/app-registry';
import { cmdExists, execAsync } from './shared';

export interface DesktopCapabilityStatus {
  xdotool: boolean;
  dbus: boolean;
  a11y: boolean;
  cliAnythingPlugin: boolean;
}

let _capabilityStatus: DesktopCapabilityStatus | null = null;

export async function getCapabilityStatus(): Promise<DesktopCapabilityStatus> {
  if (_capabilityStatus) return _capabilityStatus;
  const [xdotool, dbus, a11yResult] = await Promise.all([
    cmdExists('xdotool'),
    cmdExists('dbus-send'),
    isA11yAvailable(),
  ]);
  const cliAnythingPlugin = fs.existsSync(
    path.join(os.homedir(), 'CLI-Anything', 'cli-anything-plugin', 'HARNESS.md')
  );
  _capabilityStatus = { xdotool, dbus, a11y: a11yResult, cliAnythingPlugin };
  return _capabilityStatus;
}

let cachedCapabilities: string | null = null;

export async function getDesktopCapabilities(): Promise<string> {
  if (cachedCapabilities) return cachedCapabilities;

  const [xdotool, wmctrl, scrot, dbus, python3, convert] = await Promise.all([
    cmdExists('xdotool'), cmdExists('wmctrl'), cmdExists('scrot'),
    cmdExists('dbus-send'), cmdExists('python3'), cmdExists('convert'),
  ]);

  let hasPillow = false;
  if (python3) {
    try {
      await execAsync('python3 -c "from PIL import Image" 2>/dev/null', { timeout: 3000 });
      hasPillow = true;
    } catch {}
  }

  let harnesses: string[] = [];
  try {
    const profiles = listProfiles();
    harnesses = profiles
      .filter(p => p.cliAnything?.installed)
      .map(p => p.appId);
  } catch {}

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

  let hasA11y = false;
  try {
    await execAsync('python3 -c "import gi; gi.require_version(\'Atspi\', \'2.0\')" 2>/dev/null', { timeout: 3000 });
    hasA11y = true;
  } catch {}
  lines.push(`Accessibility (AT-SPI): ${hasA11y ? 'available — use a11y_* actions for menus, dialogs, buttons, text fields' : 'not installed (sudo apt install gir1.2-atspi-2.0)'}`);

  if (!xdotool && !wmctrl) lines.push('Install GUI tools: sudo apt install xdotool wmctrl scrot');

  cachedCapabilities = lines.join('\n');
  console.log(`[Desktop] ${cachedCapabilities}`);
  return cachedCapabilities;
}
