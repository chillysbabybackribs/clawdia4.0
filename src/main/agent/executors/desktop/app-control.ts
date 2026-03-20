import {
  getAppProfile,
  getHarnessGuidance,
  type AppProfile,
  type ControlSurface,
  recordFallback,
} from '../../../db/app-registry';
import { run, cmdExists } from './shared';

/** Best-effort mapping of command words to MPRIS method names. */
function guessDbusMethod(command: string): string {
  const lower = command.toLowerCase();
  if (/pause|resume|toggle/i.test(lower)) return 'PlayPause';
  if (/^play\b/i.test(lower)) return 'Play';
  if (/stop/i.test(lower)) return 'Stop';
  if (/next|skip/i.test(lower)) return 'Next';
  if (/prev/i.test(lower)) return 'Previous';
  if (/open|uri|url/i.test(lower)) return 'OpenUri';
  if (/what.*playing|now.*playing|status|metadata/i.test(lower)) return 'Metadata (via get_property)';
  return 'PlayPause';
}

async function tryControlSurface(
  surface: ControlSurface,
  profile: AppProfile,
  appName: string,
  command: string,
  json: boolean,
): Promise<{ ok: boolean; result: string }> {
  switch (surface) {
    case 'dbus': {
      if (!profile.dbusService) return { ok: false, result: '[Skip] No DBus service in profile' };
      if (!await cmdExists('dbus-send')) return { ok: false, result: '[Skip] dbus-send not installed' };

      const ping = await run(
        `dbus-send --session --dest=${profile.dbusService} --type=method_call --print-reply /org/mpris/MediaPlayer2 org.freedesktop.DBus.Properties.Get string:"org.mpris.MediaPlayer2" string:"Identity"`,
        5000,
      );
      if (ping.startsWith('[Error]')) {
        return { ok: false, result: `[Skip] DBus service "${profile.dbusService}" not running` };
      }
      return {
        ok: true,
        result: `[DBus available] Service "${profile.dbusService}" is running. Use dbus_control to send commands. For MPRIS media players: action="call", service="${profile.dbusService}", path="/org/mpris/MediaPlayer2", interface="org.mpris.MediaPlayer2.Player", method="${guessDbusMethod(command)}".`,
      };
    }

    case 'cli_anything': {
      const harness = profile.cliAnything?.command || `cli-anything-${appName}`;
      if (!await cmdExists(harness)) return { ok: false, result: `[Skip] Harness "${harness}" not installed` };
      const flag = json ? ' --json' : '';
      console.log(`[app_control] CLI-Anything: ${harness}${flag} ${command}`);
      const result = await run(`${harness}${flag} ${command}`, 60_000);
      if (result.startsWith('[Error]')) return { ok: false, result };
      return { ok: true, result };
    }

    case 'native_cli': {
      const bin = profile.nativeCli?.command || profile.binaryPath || appName;
      if (!await cmdExists(bin)) return { ok: false, result: `[Skip] Binary "${bin}" not found` };
      const helpHint = profile.nativeCli?.helpSummary || '';
      const timeout = /hang|block|timeout/i.test(helpHint) ? 15_000 : 60_000;
      console.log(`[app_control] Native CLI: ${bin} ${command} (timeout: ${timeout / 1000}s)`);
      const result = await run(`${bin} ${command}`, timeout);
      if (result.startsWith('[Error]')) return { ok: false, result };
      return { ok: true, result };
    }

    case 'programmatic': {
      const alts = profile.programmaticAlternatives?.join(', ') || 'python3';
      return {
        ok: false,
        result: `[Hint] For file-level operations (resize, convert, create), use shell_exec with ${alts} instead of app_control. Continuing fallback chain for app-level operations...`,
      };
    }

    case 'gui': {
      return {
        ok: false,
        result: `[Skip] GUI surface — not handled by app_control.`,
      };
    }

    default:
      return { ok: false, result: `[Skip] Unknown surface: ${surface}` };
  }
}

export async function executeAppControl(input: Record<string, any>): Promise<string> {
  const { app, command, json = true } = input;
  if (!app || !command) return '[Error] app and command are required.';

  const appName = app.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const profile = getAppProfile(appName);

  if (profile) {
    const tried: string[] = [];
    for (const surface of profile.availableSurfaces) {
      const attempt = await tryControlSurface(surface, profile, appName, command, json);
      tried.push(`${surface}: ${attempt.ok ? 'OK' : attempt.result}`);
      if (attempt.ok) {
        console.log(`[app_control] ${profile.displayName} → ${surface} succeeded`);
        return attempt.result;
      }
      console.log(`[app_control] ${profile.displayName} → ${surface} failed, trying next...`);
    }

    recordFallback();
    const guidance = getHarnessGuidance(appName);
    const harnessBlock = guidance.alreadySuggested
      ? ''
      : `\n\n${guidance.installSteps}`;
    return `[Error] All control surfaces failed for "${profile.displayName}".
Tried: ${tried.join(' → ')}

Fallback options:
- Use shell_exec to launch it: setsid ${profile.binaryPath || appName} >/dev/null 2>&1 &${harnessBlock}`;
  }

  const hasNative = await cmdExists(appName);
  if (!hasNative) {
    const guidance = getHarnessGuidance(appName);
    const harnessBlock = guidance.alreadySuggested ? '' : `\n\n${guidance.installSteps}`;
    return `[No profile or binary found for "${app}"]

This app is not in the registry and is not installed. Try:
- shell_exec to check: which ${appName}${harnessBlock}`;
  }

  console.log(`[app_control] No profile for ${app}, using raw native CLI`);
  return await run(`${appName} ${command}`, 60_000);
}
