/**
 * App Registry — Control Surface Registry + Task Routing Layer.
 * 
 * Determines execution strategy BEFORE the LLM acts:
 *   1. Identifies target app from user message
 *   2. Loads AppProfile from SQLite registry
 *   3. Matches task type to routing rules
 *   4. Returns an ExecutionPlan that constrains the LLM
 * 
 * Control surfaces (in priority order):
 *   programmatic → cli_anything → native_cli → dbus → gui
 */

import { getDb } from './database';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ═══════════════════════════════════
// Types
// ═══════════════════════════════════

export type ControlSurface = 'programmatic' | 'cli_anything' | 'native_cli' | 'dbus' | 'gui';

export interface AppProfile {
  appId: string;
  displayName: string;
  binaryPath?: string;
  availableSurfaces: ControlSurface[];
  cliAnything?: {
    command: string;
    installed: boolean;
    commands?: string[];
  };
  nativeCli?: {
    command: string;
    supportsBatch: boolean;
    helpSummary?: string;
  };
  programmaticAlternatives?: string[];
  dbusService?: string;
  windowMatcher?: string;
  confidence: number;
  lastScanned: string;
}

export interface TaskRoutingRule {
  taskPattern: RegExp;
  preferredOrder: ControlSurface[];
  disallowed?: ControlSurface[];
}

export interface ExecutionPlan {
  appId?: string;
  appProfile?: AppProfile;
  selectedSurface: ControlSurface;
  allowedSurfaces: ControlSurface[];
  disallowedTools: string[];       // Anthropic tool names to REMOVE
  constraint: string;              // Injected into system prompt
  reasoning: string;
}

// ═══════════════════════════════════
// Task routing rules — task-aware, not just app-aware
// ═══════════════════════════════════

const TASK_RULES: TaskRoutingRule[] = [
  // Image CREATION from scratch → always programmatic
  {
    taskPattern: /create|make|generate|new.*(?:image|banner|graphic|icon|logo|thumbnail|avatar|wallpaper|poster)/i,
    preferredOrder: ['programmatic', 'cli_anything', 'native_cli', 'gui'],
    disallowed: [], // GUI allowed as last resort
  },
  // Image conversion/resize/crop → programmatic
  {
    taskPattern: /(?:convert|resize|crop|scale|compress|optimize|rotate|flip).*(?:image|photo|picture|png|jpg|jpeg|webp|gif)/i,
    preferredOrder: ['programmatic', 'native_cli', 'cli_anything', 'gui'],
  },
  // Document creation → programmatic
  {
    taskPattern: /create|make|generate|write.*(?:document|pdf|report|spreadsheet|csv|presentation)/i,
    preferredOrder: ['programmatic', 'native_cli', 'cli_anything', 'gui'],
  },
  // Audio/video conversion → programmatic
  {
    taskPattern: /(?:convert|encode|transcode|extract|trim|cut|merge).*(?:audio|video|mp3|mp4|wav|avi|mkv)/i,
    preferredOrder: ['programmatic', 'native_cli', 'cli_anything', 'gui'],
  },
  // Media playback control → dbus first
  {
    taskPattern: /(?:play|pause|stop|next|prev|skip|volume|mute|what.*playing|now playing)/i,
    preferredOrder: ['dbus', 'cli_anything', 'native_cli', 'gui'],
  },
  // Interactive GUI editing → GUI is appropriate
  {
    taskPattern: /(?:edit.*(?:layer|filter|brush|tool|selection|mask|effect))|(?:use.*(?:gimp|blender|inkscape).*(?:tool|filter|effect))/i,
    preferredOrder: ['cli_anything', 'gui', 'native_cli'],
  },
  // Launch/open app → native CLI
  {
    taskPattern: /(?:launch|open|start|run)\s+\w+/i,
    preferredOrder: ['native_cli', 'cli_anything', 'gui'],
  },
];

// ═══════════════════════════════════
// Seed data — known app profiles
// ═══════════════════════════════════

const SEED_PROFILES: AppProfile[] = [
  {
    appId: 'gimp',
    displayName: 'GIMP',
    binaryPath: 'gimp',
    availableSurfaces: ['programmatic', 'cli_anything', 'native_cli', 'gui'],
    nativeCli: { command: 'gimp', supportsBatch: true, helpSummary: 'gimp -i -b for batch/headless' },
    programmaticAlternatives: ['python3+pillow', 'imagemagick'],
    windowMatcher: 'GIMP|GNU Image',
    confidence: 0.9,
    lastScanned: new Date().toISOString(),
  },
  {
    appId: 'blender',
    displayName: 'Blender',
    binaryPath: 'blender',
    availableSurfaces: ['cli_anything', 'native_cli', 'gui'],
    nativeCli: { command: 'blender', supportsBatch: true, helpSummary: 'blender -b for background rendering' },
    programmaticAlternatives: ['python3+bpy'],
    windowMatcher: 'Blender',
    confidence: 0.8,
    lastScanned: new Date().toISOString(),
  },
  {
    appId: 'inkscape',
    displayName: 'Inkscape',
    binaryPath: 'inkscape',
    availableSurfaces: ['programmatic', 'cli_anything', 'native_cli', 'gui'],
    nativeCli: { command: 'inkscape', supportsBatch: true, helpSummary: 'inkscape --export-type for CLI export' },
    programmaticAlternatives: ['python3+svgwrite', 'imagemagick'],
    windowMatcher: 'Inkscape',
    confidence: 0.8,
    lastScanned: new Date().toISOString(),
  },
  {
    appId: 'libreoffice',
    displayName: 'LibreOffice',
    binaryPath: 'libreoffice',
    availableSurfaces: ['programmatic', 'cli_anything', 'native_cli', 'gui'],
    nativeCli: { command: 'libreoffice', supportsBatch: true, helpSummary: '--headless --convert-to for format conversion' },
    programmaticAlternatives: ['python3+openpyxl', 'python3+python-docx', 'python3+reportlab'],
    windowMatcher: 'LibreOffice',
    confidence: 0.9,
    lastScanned: new Date().toISOString(),
  },
  {
    appId: 'spotify',
    displayName: 'Spotify',
    binaryPath: 'spotify',
    availableSurfaces: ['dbus', 'gui'],
    dbusService: 'org.mpris.MediaPlayer2.spotify',
    windowMatcher: 'Spotify',
    confidence: 0.9,
    lastScanned: new Date().toISOString(),
  },
  {
    appId: 'vlc',
    displayName: 'VLC',
    binaryPath: 'vlc',
    availableSurfaces: ['dbus', 'native_cli', 'gui'],
    nativeCli: { command: 'vlc', supportsBatch: true, helpSummary: 'cvlc for headless, --play-and-exit' },
    dbusService: 'org.mpris.MediaPlayer2.vlc',
    windowMatcher: 'VLC',
    confidence: 0.8,
    lastScanned: new Date().toISOString(),
  },
  {
    appId: 'audacity',
    displayName: 'Audacity',
    binaryPath: 'audacity',
    availableSurfaces: ['programmatic', 'cli_anything', 'gui'],
    programmaticAlternatives: ['python3+pydub', 'ffmpeg', 'sox'],
    windowMatcher: 'Audacity',
    confidence: 0.7,
    lastScanned: new Date().toISOString(),
  },
  {
    appId: 'obs',
    displayName: 'OBS Studio',
    binaryPath: 'obs',
    availableSurfaces: ['cli_anything', 'native_cli', 'gui'],
    nativeCli: { command: 'obs', supportsBatch: false },
    windowMatcher: 'OBS',
    confidence: 0.6,
    lastScanned: new Date().toISOString(),
  },
  {
    appId: 'ffmpeg',
    displayName: 'FFmpeg',
    binaryPath: 'ffmpeg',
    availableSurfaces: ['programmatic', 'native_cli'],
    nativeCli: { command: 'ffmpeg', supportsBatch: true, helpSummary: 'Universal audio/video converter' },
    confidence: 1.0,
    lastScanned: new Date().toISOString(),
  },
  {
    appId: 'imagemagick',
    displayName: 'ImageMagick',
    binaryPath: 'convert',
    availableSurfaces: ['programmatic', 'native_cli'],
    nativeCli: { command: 'convert', supportsBatch: true, helpSummary: 'Image conversion, resize, composite' },
    confidence: 1.0,
    lastScanned: new Date().toISOString(),
  },
];

// ═══════════════════════════════════
// Registry Operations
// ═══════════════════════════════════

export function seedRegistry(): void {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO app_registry (id, profile_json, last_scanned)
    VALUES (?, ?, ?)
  `);

  for (const profile of SEED_PROFILES) {
    insert.run(profile.appId, JSON.stringify(profile), profile.lastScanned);
  }
  console.log(`[Registry] Seeded ${SEED_PROFILES.length} app profiles`);
}

export function getAppProfile(appId: string): AppProfile | null {
  const db = getDb();
  const row = db.prepare('SELECT profile_json FROM app_registry WHERE id = ?').get(appId) as any;
  if (!row) return null;
  try { return JSON.parse(row.profile_json); } catch { return null; }
}

export function updateAppProfile(profile: AppProfile): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO app_registry (id, profile_json, last_scanned) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET profile_json = excluded.profile_json, last_scanned = excluded.last_scanned
  `).run(profile.appId, JSON.stringify(profile), profile.lastScanned);
}

export function listProfiles(): AppProfile[] {
  const db = getDb();
  const rows = db.prepare('SELECT profile_json FROM app_registry ORDER BY id').all() as any[];
  return rows.map(r => { try { return JSON.parse(r.profile_json); } catch { return null; } }).filter(Boolean);
}

/**
 * Scan for CLI-Anything harnesses and update profiles accordingly.
 * Called once per session on first desktop task.
 */
let harnessScanned = false;
export async function scanHarnesses(): Promise<void> {
  if (harnessScanned) return;
  harnessScanned = true;

  try {
    const { stdout } = await execAsync('bash -c "compgen -c cli-anything-" 2>/dev/null || echo ""', { timeout: 3000 });
    const harnesses = stdout.trim().split('\n').map(s => s.replace(/.*cli-anything-/, '').trim()).filter(Boolean);

    for (const appName of harnesses) {
      // Try to discover available commands via --help (once per harness)
      let commands: string[] | undefined;
      try {
        const { stdout: helpOut } = await execAsync(
          `cli-anything-${appName} --help 2>/dev/null | grep -E '^  [a-z]' | awk '{print $1}'`,
          { timeout: 3000 },
        );
        const parsed = helpOut.trim().split('\n').filter(Boolean);
        if (parsed.length > 0) commands = parsed;
      } catch { /* --help parse failed, non-fatal */ }

      // Try to find SKILL.md for this harness
      let skillPath: string | undefined;
      try {
        const { stdout: pipShow } = await execAsync(
          `python3 -c "import cli_anything.${appName}; import os; print(os.path.dirname(cli_anything.${appName}.__file__))" 2>/dev/null`,
          { timeout: 3000 },
        );
        const pkgDir = pipShow.trim();
        if (pkgDir) {
          const candidatePath = `${pkgDir}/skills/SKILL.md`;
          try {
            await execAsync(`test -f "${candidatePath}"`, { timeout: 1000 });
            skillPath = candidatePath;
          } catch { /* no SKILL.md */ }
        }
      } catch { /* package not importable */ }

      const existing = getAppProfile(appName);
      if (existing) {
        existing.cliAnything = {
          command: `cli-anything-${appName}`,
          installed: true,
          commands,
        };
        if (skillPath) (existing as any).skillPath = skillPath;
        if (!existing.availableSurfaces.includes('cli_anything')) {
          existing.availableSurfaces.unshift('cli_anything');
        }
        existing.lastScanned = new Date().toISOString();
        updateAppProfile(existing);
        console.log(`[Registry] Updated ${appName} with CLI-Anything harness (${commands?.length || '?'} commands${skillPath ? ', SKILL.md found' : ''})`);
      } else {
        const newProfile: AppProfile = {
          appId: appName,
          displayName: appName.charAt(0).toUpperCase() + appName.slice(1),
          binaryPath: appName,
          availableSurfaces: ['cli_anything', 'gui'],
          cliAnything: {
            command: `cli-anything-${appName}`,
            installed: true,
            commands,
          },
          windowMatcher: appName,
          confidence: 0.7,
          lastScanned: new Date().toISOString(),
        };
        if (skillPath) (newProfile as any).skillPath = skillPath;
        updateAppProfile(newProfile);
        console.log(`[Registry] Discovered new CLI-Anything app: ${appName} (${commands?.length || '?'} commands)`);
      }
    }
  } catch { /* no harnesses */ }
}

// ═══════════════════════════════════
// App Detection — Dynamic app name extraction
// ═══════════════════════════════════

// Common non-app words to skip during binary-existence checks.
// These appear in user messages but are NOT app names.
const SKIP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'my', 'me', 'i', 'you', 'we',
  'can', 'do', 'not', 'this', 'that', 'some', 'all', 'any', 'no', 'so',
  'if', 'then', 'else', 'when', 'how', 'what', 'why', 'where', 'which',
  'will', 'just', 'now', 'please', 'help', 'want', 'need', 'use', 'get',
  'make', 'take', 'open', 'close', 'start', 'stop', 'run', 'set', 'new',
  'file', 'image', 'video', 'audio', 'text', 'data', 'app', 'window',
  'play', 'pause', 'next', 'volume', 'track', 'song', 'music',
  'create', 'edit', 'delete', 'save', 'export', 'import', 'convert',
  'resize', 'crop', 'scale', 'rotate', 'flip', 'merge', 'split',
  'launch', 'quit', 'click', 'type', 'press', 'key', 'button',
  'screenshot', 'desktop', 'screen', 'display', 'brightness',
  'notification', 'alert', 'notify', 'sound', 'mute', 'unmute',
  'louder', 'quieter', 'up', 'down', 'left', 'right',
  // Common shell/system commands that aren't "apps" to route
  'ls', 'cd', 'cat', 'grep', 'find', 'mkdir', 'rm', 'cp', 'mv',
  'sudo', 'apt', 'pip', 'npm', 'git', 'ssh', 'curl', 'wget',
  'echo', 'sed', 'awk', 'head', 'tail', 'sort', 'wc', 'chmod',
  'python3', 'python', 'node', 'bash', 'sh',
]);

// Programmatic tool aliases — these route to their tool profile, not as apps
const PROGRAMMATIC_ALIASES: Record<string, string> = {
  'pillow': 'imagemagick',
  'pil': 'imagemagick',
  'convert': 'imagemagick',
  'magick': 'imagemagick',
};

/**
 * Extract candidate app words from a user message.
 * Returns lowercase words that could plausibly be app/binary names.
 */
function extractCandidateWords(message: string): string[] {
  // Pull out words 2-30 chars, lowercase, alphabetic or with hyphens
  const words = message.toLowerCase().match(/\b[a-z][a-z0-9-]{1,29}\b/g) || [];
  return [...new Set(words)].filter(w => !SKIP_WORDS.has(w));
}

/** Cache of binary-existence checks (populated by discoverApps). */
const binaryCache: Record<string, boolean> = {};

/**
 * Synchronous extraction — checks registry DB + programmatic aliases.
 * This is the fast path called on every desktop-classified message.
 */
export function extractAppName(message: string): string | null {
  const candidates = extractCandidateWords(message);

  // 1. Check programmatic aliases first
  for (const word of candidates) {
    if (PROGRAMMATIC_ALIASES[word]) return PROGRAMMATIC_ALIASES[word];
  }

  // 2. Check the registry database (covers seed profiles + discovered apps)
  const db = getDb();
  const registeredIds = new Set(
    (db.prepare('SELECT id FROM app_registry').all() as { id: string }[])
      .map(r => r.id),
  );
  for (const word of candidates) {
    if (registeredIds.has(word)) return word;
  }

  // 3. Check the binary cache (populated by discoverApps)
  for (const word of candidates) {
    if (binaryCache[word] === true) return word;
  }

  return null;
}

/**
 * Async discovery — runs `which` on candidate words and checks wmctrl.
 * Called once per desktop task (alongside scanHarnesses). Populates
 * binaryCache and auto-registers newly discovered apps in the registry.
 */
let discoveryRan = false;
export async function discoverApps(message: string): Promise<string | null> {
  const candidates = extractCandidateWords(message);

  // Try sync extraction first (covers registry + cache)
  const syncResult = extractAppName(message);
  if (syncResult) return syncResult;

  // 4. Binary existence check via `which` for uncached candidates
  const unchecked = candidates.filter(w => !(w in binaryCache));
  if (unchecked.length > 0) {
    // Batch check: run `which` for up to 10 candidates
    const toCheck = unchecked.slice(0, 10);
    const results = await Promise.allSettled(
      toCheck.map(async (word) => {
        try {
          await execAsync(`which ${word} 2>/dev/null`, { timeout: 2000 });
          binaryCache[word] = true;
          return word;
        } catch {
          binaryCache[word] = false;
          return null;
        }
      }),
    );

    // Return first found binary that's not a system command
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        const appId = r.value;
        // Auto-register in the registry with minimal profile
        if (!getAppProfile(appId)) {
          const newProfile: AppProfile = {
            appId,
            displayName: appId.charAt(0).toUpperCase() + appId.slice(1),
            binaryPath: appId,
            availableSurfaces: ['native_cli', 'gui'],
            nativeCli: { command: appId, supportsBatch: false },
            windowMatcher: appId,
            confidence: 0.5,
            lastScanned: new Date().toISOString(),
          };
          updateAppProfile(newProfile);
          console.log(`[Registry] Auto-discovered app: ${appId}`);
        }
        return appId;
      }
    }
  }

  // 5. For media-intent messages, check running MPRIS services via DBus
  const isMediaIntent = /\b(?:play|pause|stop|next|prev|skip|volume|mute|what.*playing|now playing|music|song|track)\b/i.test(message);
  if (isMediaIntent) {
    try {
      const { stdout } = await execAsync(
        `dbus-send --session --dest=org.freedesktop.DBus --type=method_call --print-reply /org/freedesktop/DBus org.freedesktop.DBus.ListNames 2>/dev/null`,
        { timeout: 2000 },
      );
      // Find MPRIS services: org.mpris.MediaPlayer2.{appName}
      const mprisApps = stdout.split('\n')
        .map(l => l.match(/org\.mpris\.MediaPlayer2\.(\w+)/)?.[1])
        .filter((s): s is string => !!s);
      if (mprisApps.length > 0) {
        const appId = mprisApps[0].toLowerCase();
        console.log(`[Registry] MPRIS auto-detected: ${appId} (from ${mprisApps.length} player(s))`);
        // Ensure it's in the registry
        if (!getAppProfile(appId)) {
          const newProfile: AppProfile = {
            appId,
            displayName: appId.charAt(0).toUpperCase() + appId.slice(1),
            binaryPath: appId,
            availableSurfaces: ['dbus', 'gui'],
            dbusService: `org.mpris.MediaPlayer2.${mprisApps[0]}`,
            windowMatcher: appId,
            confidence: 0.8,
            lastScanned: new Date().toISOString(),
          };
          updateAppProfile(newProfile);
          console.log(`[Registry] Auto-registered MPRIS app: ${appId}`);
        }
        return appId;
      }
    } catch { /* dbus-send not available */ }
  }

  // 6. Check running windows via wmctrl as last resort
  if (!discoveryRan) {
    discoveryRan = true;
    try {
      const { stdout } = await execAsync('wmctrl -l 2>/dev/null', { timeout: 2000 });
      const windowTitles = stdout.split('\n').map(l => l.trim()).filter(Boolean);
      for (const word of candidates) {
        const re = new RegExp(`\\b${word}\\b`, 'i');
        if (windowTitles.some(t => re.test(t))) {
          console.log(`[Registry] Matched "${word}" to running window`);
          binaryCache[word] = true;
          return word;
        }
      }
    } catch { /* wmctrl not available or no display */ }
  }

  return null;
}

// ═══════════════════════════════════
// Task Routing — The Core Decision Engine
// ═══════════════════════════════════

/**
 * Route a task to the best control surface.
 * Called BEFORE the LLM executes — returns an ExecutionPlan that
 * constrains which tools the LLM can use.
 */
export function routeTask(userMessage: string, appId: string | null): ExecutionPlan {
  // Default plan — no constraints, LLM decides
  const defaultPlan: ExecutionPlan = {
    selectedSurface: 'gui',
    allowedSurfaces: ['programmatic', 'cli_anything', 'native_cli', 'dbus', 'gui'],
    disallowedTools: [],
    constraint: '',
    reasoning: 'No app detected or no profile available. LLM decides.',
  };

  if (!appId) return defaultPlan;

  const profile = getAppProfile(appId);
  if (!profile) return { ...defaultPlan, appId, reasoning: `No profile for "${appId}". LLM decides.` };

  // Match task type against routing rules
  let matchedRule: TaskRoutingRule | null = null;
  for (const rule of TASK_RULES) {
    if (rule.taskPattern.test(userMessage)) {
      matchedRule = rule;
      break;
    }
  }

  // Compute available surfaces (intersection of profile + rule)
  const profileSurfaces = new Set(profile.availableSurfaces);
  const orderedSurfaces = matchedRule
    ? matchedRule.preferredOrder.filter(s => profileSurfaces.has(s))
    : profile.availableSurfaces;

  if (orderedSurfaces.length === 0) {
    return { ...defaultPlan, appId, appProfile: profile, reasoning: 'No compatible surfaces. Falling back to GUI.' };
  }

  const selected = orderedSurfaces[0];
  const disallowed = matchedRule?.disallowed || [];

  // Map control surfaces to Anthropic tool names that should be REMOVED
  const disallowedTools: string[] = [];
  if (selected === 'programmatic' && !orderedSurfaces.includes('gui')) {
    // Don't remove GUI tools entirely — just deprioritize via constraint
  }

  // Build the constraint string for the system prompt
  let constraint = '';
  let reasoning = '';

  switch (selected) {
    case 'programmatic': {
      const alts = profile.programmaticAlternatives?.join(', ') || 'python3';
      constraint = `[EXECUTION PLAN] Task: "${appId}" operation. Use shell_exec with ${alts} — this is a programmatic task. Do NOT open ${profile.displayName}'s GUI. Do NOT use gui_interact or app_control. Write a Python/CLI script to accomplish this directly.`;
      reasoning = `${profile.displayName} task routed to programmatic (${alts}). GUI is unnecessary.`;
      disallowedTools.push('gui_interact', 'app_control');
      break;
    }
    case 'cli_anything': {
      const cmd = profile.cliAnything?.command || `cli-anything-${appId}`;
      const isInstalled = profile.cliAnything?.installed === true;
      const cmds = profile.cliAnything?.commands?.join(', ') || 'use --help to discover';
      if (isInstalled) {
        constraint = `[EXECUTION PLAN] Use app_control with app="${appId}" — CLI-Anything harness is installed (${cmd}). Available commands: ${cmds}. Do NOT use gui_interact unless app_control fails.`;
        reasoning = `${profile.displayName} has CLI-Anything harness. Using structured CLI.`;
      } else {
        // Profile says cli_anything is an option but it's not actually installed
        // Fall through to next surface instead of giving a plan that will fail
        const nextSurfaces = orderedSurfaces.filter(s => s !== 'cli_anything');
        if (nextSurfaces.length > 0) {
          // Recursive-like: just pick the next surface
          const fallbackSurface = nextSurfaces[0];
          constraint = `[EXECUTION PLAN] CLI-Anything harness for ${profile.displayName} is not installed. Falling back to ${fallbackSurface} surface.`;
          reasoning = `${profile.displayName} cli_anything not installed, falling back to ${fallbackSurface}.`;
        } else {
          constraint = `[EXECUTION PLAN] Use app_control with app="${appId}" — app_control will attempt fallback surfaces automatically.`;
          reasoning = `${profile.displayName} cli_anything not installed, app_control will try fallback chain.`;
        }
      }
      disallowedTools.push('gui_interact');
      break;
    }
    case 'native_cli': {
      const help = profile.nativeCli?.helpSummary || '';
      constraint = `[EXECUTION PLAN] Use shell_exec with "${profile.nativeCli?.command || appId}" CLI. ${help}. Prefer headless/batch mode. Do NOT open the GUI unless CLI cannot accomplish the task.`;
      reasoning = `${profile.displayName} has native CLI. Using headless mode.`;
      disallowedTools.push('gui_interact');
      break;
    }
    case 'dbus': {
      const svc = profile.dbusService || '';
      const bin = profile.binaryPath || appId;
      constraint = `[EXECUTION PLAN] Use dbus_control to interact with ${profile.displayName} via DBus service "${svc}". Use MPRIS interface for media control. If the DBus call fails with ServiceUnknown, launch with shell_exec("setsid ${bin} >/dev/null 2>&1 &"), wait 5s, then retry. IMPORTANT: After sending a play/OpenUri command, the DBus response is a void return (no data) — this means SUCCESS. Do NOT call PlayPause after OpenUri — the track is already playing. To verify, use dbus_control get_property with method="Metadata" to read the current track. A void "method return" means the command worked.`;
      reasoning = `${profile.displayName} has DBus interface. Using programmatic control.`;
      disallowedTools.push('gui_interact');
      break;
    }
    case 'gui': {
      constraint = `[EXECUTION PLAN] Use gui_interact for ${profile.displayName}. Window matcher: "${profile.windowMatcher || appId}". Use batch_actions for multi-step sequences. Use keyboard shortcuts when possible.`;
      reasoning = `${profile.displayName} requires GUI interaction. No structured control surface available.`;
      break;
    }
  }

  return {
    appId,
    appProfile: profile,
    selectedSurface: selected,
    allowedSurfaces: orderedSurfaces,
    disallowedTools,
    constraint,
    reasoning,
  };
}

// ═══════════════════════════════════
// Execution Metrics (simple counters)
// ═══════════════════════════════════

const metrics: {
  surfaceUsed: Record<string, number>;
  fallbackCount: number;
  totalDesktopTasks: number;
} = {
  surfaceUsed: {},
  fallbackCount: 0,
  totalDesktopTasks: 0,
};

export function recordSurfaceUsage(surface: ControlSurface): void {
  metrics.surfaceUsed[surface] = (metrics.surfaceUsed[surface] || 0) + 1;
  metrics.totalDesktopTasks++;
}

export function recordFallback(): void {
  metrics.fallbackCount++;
}

export function getMetrics() {
  return { ...metrics };
}

// ═══════════════════════════════════
// CLI-Anything Harness Guidance
//
// When all control surfaces fail, provide actionable guidance
// on how to get a CLI-Anything harness for the app.
// ═══════════════════════════════════

// Apps with pre-built harnesses in the CLI-Anything repo.
// This avoids a network call — just a lightweight lookup.
// Kept in sync with https://github.com/HKUDS/CLI-Anything
const PREBUILT_HARNESSES = new Set([
  'gimp', 'blender', 'inkscape', 'libreoffice', 'audacity',
  'obs', 'kdenlive', 'shotcut', 'vlc', 'zoom', 'drawio',
  'adguardhome',
]);

// Track which apps we've already suggested harness install for
// (per-session, so we don't spam the same guidance)
const harnessGuidanceSent = new Set<string>();

export interface HarnessGuidance {
  available: boolean;      // true if a pre-built harness exists
  prebuilt: boolean;       // true if it's in PREBUILT_HARNESSES
  installSteps: string;    // actionable instructions
  alreadySuggested: boolean; // true if we already told the user about this
}

/**
 * Get harness installation guidance for an app.
 * Called by app_control when all surfaces fail.
 */
export function getHarnessGuidance(appId: string): HarnessGuidance {
  const normalizedId = appId.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const alreadySuggested = harnessGuidanceSent.has(normalizedId);
  harnessGuidanceSent.add(normalizedId);

  if (PREBUILT_HARNESSES.has(normalizedId)) {
    return {
      available: true,
      prebuilt: true,
      alreadySuggested,
      installSteps: [
        `[CLI-Anything] A pre-built harness exists for "${appId}".`,
        `To install:`,
        `  git clone https://github.com/HKUDS/CLI-Anything.git`,
        `  cd CLI-Anything/${normalizedId}/agent-harness`,
        `  pip install -e .`,
        `After install, cli-anything-${normalizedId} will be on PATH.`,
        `Then app_control will use it automatically on next call.`,
      ].join('\n'),
    };
  }

  return {
    available: false,
    prebuilt: false,
    alreadySuggested,
    installSteps: [
      `[CLI-Anything] No pre-built harness for "${appId}".`,
      `To build one (requires Claude Code + CLI-Anything plugin):`,
      `  /plugin marketplace add HKUDS/CLI-Anything`,
      `  /plugin install cli-anything`,
      `  /cli-anything ${normalizedId}`,
      `This analyzes the app's source and generates a structured CLI.`,
      `After build: cd ${normalizedId}/agent-harness && pip install -e .`,
    ].join('\n'),
  };
}

/**
 * Check if CLI-Anything plugin is installed in Claude Code.
 * Returns the install path or null.
 */
export async function checkCliAnythingInstalled(): Promise<boolean> {
  try {
    const { stdout } = await execAsync(
      'ls ~/.claude/plugins/cache/*/cli-anything 2>/dev/null || echo ""',
      { timeout: 2000 },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
