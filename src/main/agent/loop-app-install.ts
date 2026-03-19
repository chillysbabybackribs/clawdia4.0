/**
 * App Installer — install system apps before harness generation.
 *
 * Strategy (no bare sudo — blocks on stdin in Electron main process):
 *   1. flatpak install --user  (no auth, user-space)
 *   2. pkexec apt install      (GUI PolicyKit dialog)
 *   3. pkexec snap install     (GUI PolicyKit dialog)
 *
 * All PM calls have 120s timeouts. Failures are non-fatal.
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const INSTALL_TIMEOUT = 120_000;

// One-time availability check cache
const pmCache: Record<string, boolean> = {};

async function hasBin(cmd: string): Promise<boolean> {
  if (cmd in pmCache) return pmCache[cmd];
  try {
    await execAsync(`which ${cmd} 2>/dev/null`, { timeout: 3000 });
    pmCache[cmd] = true;
  } catch {
    pmCache[cmd] = false;
  }
  return pmCache[cmd];
}

async function binaryOnPath(appId: string): Promise<boolean> {
  try {
    await execAsync(`which ${appId} 2>/dev/null`, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export async function installApp(
  appId: string,
  onProgress: (text: string) => void,
): Promise<boolean> {
  // Sanitise appId — only allow lowercase alphanumeric and hyphens
  const safeId = appId.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!safeId) {
    onProgress(`[Install] Invalid app identifier: ${appId}`);
    return false;
  }

  // Already installed — fast path
  if (await binaryOnPath(safeId)) return true;

  // 1. Try flatpak --user (no auth needed)
  if (await hasBin('flatpak')) {
    onProgress(`Installing ${appId} via flatpak (user install, no password needed)...`);
    try {
      await execAsync(
        `flatpak install --user -y flathub ${safeId} 2>&1`,
        { timeout: INSTALL_TIMEOUT },
      );
      // Check if flatpak app is now available
      const { stdout: listOut } = await execAsync(`flatpak list --app --columns=name 2>/dev/null`, { timeout: 5000 });
      const isListed = listOut.toLowerCase().includes(safeId.toLowerCase());
      if (isListed || await binaryOnPath(safeId)) {
        onProgress(`✓ Installed ${appId} via flatpak.`);
        return true;
      }
    } catch (e: any) {
      console.log(`[Install] flatpak failed for ${appId}: ${e.message?.slice(0, 100)}`);
    }
  }

  // 2. Try pkexec apt-get (GUI password dialog)
  if (await hasBin('pkexec') && await hasBin('apt-get')) {
    onProgress(`Installing ${appId} via apt (a password dialog will appear)...`);
    try {
      await execAsync(
        `DEBIAN_FRONTEND=noninteractive pkexec apt-get install -y ${safeId} 2>&1`,
        { timeout: INSTALL_TIMEOUT },
      );
      if (await binaryOnPath(safeId)) {
        onProgress(`✓ Installed ${appId} via apt.`);
        return true;
      }
    } catch (e: any) {
      console.log(`[Install] pkexec apt-get failed for ${appId}: ${e.message?.slice(0, 100)}`);
    }
  }

  // 3. Try pkexec snap (GUI password dialog)
  if (await hasBin('pkexec') && await hasBin('snap')) {
    onProgress(`Installing ${appId} via snap (a password dialog will appear)...`);
    try {
      await execAsync(
        `pkexec snap install ${safeId} 2>&1`,
        { timeout: INSTALL_TIMEOUT },
      );
      if (await binaryOnPath(safeId)) {
        onProgress(`✓ Installed ${appId} via snap.`);
        return true;
      }
    } catch (e: any) {
      console.log(`[Install] pkexec snap failed for ${appId}: ${e.message?.slice(0, 100)}`);
    }
  }

  // All methods failed
  onProgress(
    `Could not install ${appId} automatically. Please run one of:\n` +
    `  sudo apt-get install ${safeId}\n` +
    `  sudo snap install ${safeId}\n` +
    `  flatpak install flathub ${safeId}\n` +
    `Then try your request again.`,
  );
  return false;
}
