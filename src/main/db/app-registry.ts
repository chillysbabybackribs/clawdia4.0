/**
 * App Registry — Control Surface Registry + Task Routing Layer.
 * 
 * Determines execution strategy BEFORE the LLM acts:
 *   1. Identifies target app from user message
 *   2. Loads AppProfile from SQLite registry
 *   3. Matches task type to routing rules
 *   4. Returns an ExecutionPlan that constrains the LLM
 * 
 * Control surfaces (order is task-dependent, see TASK_RULES):
 *   programmatic, cli_anything, native_cli, dbus, gui
 * CLI-Anything is auto-promoted to first when installed.
 */

import { getDb } from './database';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';

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
    skillPath?: string;
    skillContent?: string;
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
  // App-session interaction (list layers, show state, apply within running app)
  // These need the app itself, not just Pillow/ImageMagick on a file.
  {
    taskPattern: /(?:list|show|get|read).*(?:layer|channel|path|history|undo|selection)|(?:in|inside|within|from)\s+(?:gimp|blender|inkscape|libreoffice|audacity|obs)/i,
    preferredOrder: ['cli_anything', 'native_cli', 'gui'],
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
    appId: 'claude',
    displayName: 'Claude Code',
    binaryPath: 'claude',
    availableSurfaces: ['native_cli'],
    nativeCli: {
      command: 'claude',
      supportsBatch: true,
      helpSummary: 'Use non-interactive print mode: claude -p --dangerously-skip-permissions "<prompt>". Prefer direct prompts over interactive sessions.',
    },
    windowMatcher: 'Claude|claude',
    confidence: 0.95,
    lastScanned: new Date().toISOString(),
  },
  {
    appId: 'gimp',
    displayName: 'GIMP',
    binaryPath: 'gimp',
    availableSurfaces: ['programmatic', 'cli_anything', 'native_cli', 'gui'],
    nativeCli: {
      command: 'gimp',
      supportsBatch: true,
      helpSummary: 'gimp -i -b for batch/headless Script-Fu. WARNING: Script-Fu batch can hang — use 10s timeout. For interactive session tasks (list layers, apply filters on open image), prefer gui_interact or cli-anything-gimp over native batch.',
    },
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

  let inserted = 0;
  for (const profile of SEED_PROFILES) {
    const result = insert.run(profile.appId, JSON.stringify(profile), profile.lastScanned);
    inserted += Number(result.changes || 0);
  }

  const count = (db.prepare('SELECT COUNT(*) as cnt FROM app_registry').get() as any)?.cnt || 0;
  if (inserted > 0) {
    console.log(`[Registry] Seeded ${inserted} missing profile(s) (${count} total)`);
  } else {
    console.log(`[Registry] Already seeded (${count} profiles)`);
  }
}

export function getAppProfile(appId: string): AppProfile | null {
  const db = getDb();
  const row = db.prepare('SELECT profile_json FROM app_registry WHERE id = ?').get(appId) as any;
  if (row) {
    try { return JSON.parse(row.profile_json); } catch { return null; }
  }

  const seeded = SEED_PROFILES.find((profile) => profile.appId === appId) || null;
  if (seeded) {
    updateAppProfile(seeded);
    return seeded;
  }

  return null;
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
    const harnesses = [...new Set(stdout.trim().split('\n').map(s => s.replace(/.*cli-anything-/, '').trim()).filter(Boolean))];

    // Discover all harnesses in parallel (each runs --help + SKILL.md check)
    await Promise.all(harnesses.map(async (appName) => {
      // Try to discover available commands via --help
      let commands: string[] | undefined;
      try {
        const { stdout: helpOut } = await execAsync(
          `cli-anything-${appName} --help 2>/dev/null | grep -E '^  [a-z]' | awk '{print $1}'`,
          { timeout: 3000 },
        );
        const parsed = helpOut.trim().split('\n').filter(Boolean);
        if (parsed.length > 0) commands = parsed;
      } catch { /* --help parse failed, non-fatal */ }

      // Try to find and read SKILL.md for this harness
      let skillPath: string | undefined;
      let skillContent: string | undefined;
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
            // Read the SKILL.md content for prompt injection
            const { stdout: rawSkill } = await execAsync(`cat "${candidatePath}"`, { timeout: 3000 });
            if (rawSkill.trim()) skillContent = rawSkill.trim();
          } catch { /* no SKILL.md */ }
        }
      } catch { /* package not importable */ }

      const existing = getAppProfile(appName);
      if (existing) {
        existing.cliAnything = {
          command: `cli-anything-${appName}`,
          installed: true,
          commands,
          skillPath,
          skillContent,
        };
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
            skillPath,
            skillContent,
          },
          windowMatcher: appName,
          confidence: 0.7,
          lastScanned: new Date().toISOString(),
        };
        updateAppProfile(newProfile);
        console.log(`[Registry] Discovered new CLI-Anything app: ${appName} (${commands?.length || '?'} commands)`);
      }
    }));
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
  const normalized = message.toLowerCase();
  if (/\bclaude(?:\s+code|-code)\b/.test(normalized)) return 'claude';

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
  let orderedSurfaces = matchedRule
    ? matchedRule.preferredOrder.filter(s => profileSurfaces.has(s))
    : profile.availableSurfaces;

  // CLI-Anything override: when an installed harness exists, it ALWAYS wins over
  // programmatic/native_cli. The user has a dedicated CLI for this app — use it.
  // This prevents task rules like "create image" from routing to Pillow when
  // cli-anything-inkscape is installed and ready.
  if (profile.cliAnything?.installed && orderedSurfaces.includes('cli_anything') && orderedSurfaces[0] !== 'cli_anything') {
    orderedSurfaces = ['cli_anything', ...orderedSurfaces.filter(s => s !== 'cli_anything')];
    console.log(`[Router] CLI-Anything installed for ${appId} — promoted to first surface`);
  }

  if (orderedSurfaces.length === 0) {
    return { ...defaultPlan, appId, appProfile: profile, reasoning: 'No compatible surfaces. Falling back to GUI.' };
  }

  const selected = orderedSurfaces[0];

  // Map control surfaces to Anthropic tool names that should be REMOVED
  //
  // gui_interact is only filtered when cli_anything is the selected surface AND the harness
  // is installed. In that case, the CLI is strictly better than GUI — the LLM ignores
  // prompt constraints when it sees a visible window, so we must remove the tool entirely.
  // For all other surfaces, gui_interact remains available as a fallback.
  const disallowedTools: string[] = [];

  // Build the constraint string for the system prompt
  let constraint = '';
  let reasoning = '';

  switch (selected) {
    case 'programmatic': {
      const alts = profile.programmaticAlternatives?.join(', ') || 'python3';
      constraint = `[EXECUTION PLAN] Task: "${appId}" operation. Use shell_exec with ${alts} — this is a programmatic task. Do NOT open ${profile.displayName}'s GUI unless the task specifically requires interacting with a running window. Write a Python/CLI script to accomplish this directly. If the task requires window interaction (menus, dialogs, typing into the app), use gui_interact macros instead.`;
      reasoning = `${profile.displayName} task routed to programmatic (${alts}). GUI available as fallback.`;
      break;
    }
    case 'cli_anything': {
      const cmd = profile.cliAnything?.command || `cli-anything-${appId}`;
      const isInstalled = profile.cliAnything?.installed === true;
      const cmds = profile.cliAnything?.commands?.join(', ') || 'use --help to discover';
      const skillMd = profile.cliAnything?.skillContent;
      if (isInstalled) {
        // If we have SKILL.md content, inject it directly — eliminates the --help discovery step
        const skillBlock = skillMd
          ? `\n\n--- CLI SKILL REFERENCE ---\n${skillMd}\n--- END SKILL REFERENCE ---`
          : `\n\nWorkflow:\n1. shell_exec("${cmd} --help") to see all commands\n2. shell_exec("${cmd} --json <command>") for each step\n3. All output is structured JSON when using --json flag`;

        constraint = `[EXECUTION PLAN — MANDATORY] You MUST use shell_exec to run "${cmd}" commands for this task. Do NOT use gui_interact, do NOT take screenshots, do NOT use app_control. Run the CLI directly via shell_exec.

CLI: ${cmd}
Available command groups: ${cmds}
Always use --json flag for machine-readable output.

This CLI controls ${profile.displayName} WITHOUT the GUI. It is faster, more reliable, and deterministic. Do NOT interact with any visible ${profile.displayName} window — use the CLI instead.${skillBlock}`;
        reasoning = `${profile.displayName} has CLI-Anything harness (${cmd})${skillMd ? ' + SKILL.md' : ''}. Using structured CLI.`;
        // Hard filter: remove gui_interact AND app_control so the LLM can only use shell_exec
        // with the CLI-Anything command. app_control's fallback chain can route to GUI internally.
        disallowedTools.push('gui_interact', 'app_control', 'dbus_control');
      } else {
        const nextSurfaces = orderedSurfaces.filter(s => s !== 'cli_anything');
        if (nextSurfaces.length > 0) {
          const fallbackSurface = nextSurfaces[0];
          constraint = `[EXECUTION PLAN] CLI-Anything harness for ${profile.displayName} is not installed. Falling back to ${fallbackSurface} surface.`;
          reasoning = `${profile.displayName} cli_anything not installed, falling back to ${fallbackSurface}.`;
        } else {
          constraint = `[EXECUTION PLAN] Use app_control with app="${appId}" — app_control will attempt fallback surfaces automatically.`;
          reasoning = `${profile.displayName} cli_anything not installed, app_control will try fallback chain.`;
        }
      }
      break;
    }
    case 'native_cli': {
      const help = profile.nativeCli?.helpSummary || '';
      if (appId === 'claude') {
        constraint = `[EXECUTION PLAN — MANDATORY] Use shell_exec to invoke Claude Code in non-interactive unrestricted mode. Do NOT use app_control, gui_interact, or dbus_control for this task.

Required command pattern:
- claude -p --dangerously-skip-permissions "<prompt>"

Rules:
- Treat the user's request as the Claude prompt payload.
- Run Claude from the relevant repo directory before asking it to inspect or edit code.
- Default to read-only analysis unless the prompt explicitly says "Mode: write-enabled" or the user used /claude-code-edit.
- In read-only mode, do not ask Claude to edit files, apply patches, commit, or launch long-running processes.
- Never ask Claude to start Vite, Electron, nodemon, watch mode, dev servers, or background processes unless the user explicitly asks for that exact behavior.
- Keep prompts explicit about scope: read-only review, explanation, patch, or fix.
- After Claude finishes, independently verify the result yourself with file inspection, diffs, or tests.
- Do not interrupt the user with approval requests for Claude Code during this testing path unless the command itself fails.
- If you need a machine-readable answer, prefer: claude -p --output-format json --dangerously-skip-permissions "<prompt>"`;
        reasoning = 'Claude Code task routed to native CLI with read-only default and explicit write mode.';
        disallowedTools.push('gui_interact', 'app_control', 'dbus_control');
      } else {
        constraint = `[EXECUTION PLAN] Use shell_exec with "${profile.nativeCli?.command || appId}" CLI. ${help}. Prefer headless/batch mode. If the task requires interacting with a running window (menus, dialogs, typing), use gui_interact macros instead of raw xdotool.`;
        reasoning = `${profile.displayName} has native CLI. Using headless mode. GUI available as fallback.`;
      }
      break;
    }
    case 'dbus': {
      const svc = profile.dbusService || '';
      const bin = profile.binaryPath || appId;
      constraint = `[EXECUTION PLAN] Use dbus_control to interact with ${profile.displayName} via DBus service "${svc}". Use MPRIS interface for media control. If the DBus call fails with ServiceUnknown, launch with shell_exec("setsid ${bin} >/dev/null 2>&1 &"), wait 5s, then retry. IMPORTANT: After sending a play/OpenUri command, the DBus response is a void return (no data) — this means SUCCESS. Do NOT call PlayPause after OpenUri — the track is already playing. To verify, use dbus_control get_property with method="Metadata" to read the current track. A void "method return" means the command worked.`;
      reasoning = `${profile.displayName} has DBus interface. Using programmatic control.`;
      break;
    }
    case 'gui': {
      constraint = `[EXECUTION PLAN] Use gui_interact for ${profile.displayName}. Window matcher: "${profile.windowMatcher || appId}". PREFER gui_interact macros (launch_and_focus, open_menu_path, fill_dialog, confirm_dialog, export_file, click_and_type) over raw primitives — each macro replaces 3-5 primitive calls. Use batch_actions for any remaining multi-step sequences. Use keyboard shortcuts when possible.`;
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
  return { ...metrics, deviations: [...surfaceDeviations] };
}

// ═══════════════════════════════════
// Surface Deviation Tracking
//
// Records when the LLM uses a different tool than the
// execution plan recommended. Feeds back into routing
// quality assessment without blocking execution.
// ═══════════════════════════════════

export interface SurfaceDeviation {
  appId: string;
  expectedSurface: ControlSurface;
  expectedTool: string;
  actualTool: string;
  timestamp: number;
}

const surfaceDeviations: SurfaceDeviation[] = [];

/** Map a control surface to the Anthropic tool name the LLM should use. */
export function expectedToolForSurface(surface: ControlSurface): string {
  switch (surface) {
    case 'programmatic': return 'shell_exec';
    case 'dbus':         return 'dbus_control';
    case 'cli_anything': return 'shell_exec';  // CLI-Anything harnesses are called via shell_exec, not app_control
    case 'native_cli':   return 'shell_exec';
    case 'gui':          return 'gui_interact';
  }
}

/**
 * Record a surface deviation.
 * Called by the agent loop when the LLM uses a tool that
 * doesn't match the execution plan's recommended surface.
 */
export function recordSurfaceDeviation(
  appId: string,
  expectedSurface: ControlSurface,
  actualTool: string,
): void {
  const expected = expectedToolForSurface(expectedSurface);
  // Not a deviation if the tool matches
  if (actualTool === expected) return;
  // app_control is always acceptable — it's the unified dispatcher
  if (actualTool === 'app_control') return;
  // shell_exec used for programmatic or native_cli is expected
  if (actualTool === 'shell_exec' && (expectedSurface === 'programmatic' || expectedSurface === 'native_cli')) return;

  const deviation: SurfaceDeviation = {
    appId,
    expectedSurface,
    expectedTool: expected,
    actualTool,
    timestamp: Date.now(),
  };
  surfaceDeviations.push(deviation);
  // Cap at 100 entries
  if (surfaceDeviations.length > 100) surfaceDeviations.shift();

  console.warn(
    `[Deviation] App: ${appId} | Expected: ${expected} (${expectedSurface}) | Actual: ${actualTool}`,
  );
}

/** Get deviation summary for diagnostics. */
export function getDeviationSummary(): {
  total: number;
  byApp: Record<string, number>;
  byActualTool: Record<string, number>;
  recent: SurfaceDeviation[];
} {
  const byApp: Record<string, number> = {};
  const byActualTool: Record<string, number> = {};
  for (const d of surfaceDeviations) {
    byApp[d.appId] = (byApp[d.appId] || 0) + 1;
    byActualTool[d.actualTool] = (byActualTool[d.actualTool] || 0) + 1;
  }
  return {
    total: surfaceDeviations.length,
    byApp,
    byActualTool,
    recent: surfaceDeviations.slice(-10),
  };
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
      `Harness generation is disabled unless the user explicitly asks for a CLI-Anything harness.`,
      `If requested later, the explicit build path is:`,
      `  /plugin marketplace add HKUDS/CLI-Anything`,
      `  /plugin install cli-anything`,
      `  /cli-anything ${normalizedId}`,
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

// ═══════════════════════════════════
// Auto-Install CLI-Anything Harness
//
// When a task targets an app that:
//   1. Has no CLI-Anything harness installed
//   2. Has a pre-built harness in ~/CLI-Anything/<app>/agent-harness
//   3. The app binary is installed on the system
//
// Automatically install the harness, update the profile, and
// re-route to cli_anything — all before the LLM starts.
// ═══════════════════════════════════

/** Track apps we've already attempted auto-install for (per-session). */
const autoInstallAttempted = new Set<string>();

/**
 * Attempt to auto-install a CLI-Anything harness for an app.
 * 
 * Returns true if a harness was installed (profile updated, ready to use).
 * Returns false if no harness could be installed (no pre-built, install failed, etc.).
 * 
 * Called by the agent loop during pre-LLM setup when an app is detected
 * but has no cli_anything surface available.
 */
export async function autoInstallHarness(appId: string): Promise<boolean> {
  const normalizedId = appId.toLowerCase().replace(/[^a-z0-9-]/g, '');
  
  // Don't retry within the same session
  if (autoInstallAttempted.has(normalizedId)) return false;
  autoInstallAttempted.add(normalizedId);

  // Check if already installed
  try {
    await execAsync(`which cli-anything-${normalizedId} 2>/dev/null`, { timeout: 2000 });
    console.log(`[CLI-Anything] cli-anything-${normalizedId} already on PATH`);
    return false; // Already installed, scanHarnesses should have caught it
  } catch {
    // Not installed — proceed
  }

  // Check if pre-built harness exists in the repo
  const homedir = os.homedir();
  const repoPaths = [
    `${homedir}/CLI-Anything/${normalizedId}/agent-harness/setup.py`,
    `${homedir}/cli-anything/${normalizedId}/agent-harness/setup.py`,
    `${homedir}/Desktop/CLI-Anything/${normalizedId}/agent-harness/setup.py`,
  ];

  let harnessDir: string | null = null;
  for (const setupPath of repoPaths) {
    try {
      await execAsync(`test -f "${setupPath}"`, { timeout: 1000 });
      harnessDir = setupPath.replace('/setup.py', '');
      break;
    } catch { /* not found */ }
  }

  if (!harnessDir) {
    // No local repo — try to clone it
    if (!PREBUILT_HARNESSES.has(normalizedId)) {
      console.log(`[CLI-Anything] No pre-built harness for "${normalizedId}" and no local repo found`);
      return false;
    }

    console.log(`[CLI-Anything] Pre-built harness available for "${normalizedId}". Cloning repo...`);
    const cloneDir = `${homedir}/CLI-Anything`;
    try {
      await execAsync(`test -d "${cloneDir}/.git"`, { timeout: 1000 });
      // Repo exists, just check if the specific harness dir is there
      try {
        await execAsync(`test -f "${cloneDir}/${normalizedId}/agent-harness/setup.py"`, { timeout: 1000 });
        harnessDir = `${cloneDir}/${normalizedId}/agent-harness`;
      } catch {
        console.log(`[CLI-Anything] Repo exists but no harness for "${normalizedId}" found. Pulling latest...`);
        try {
          await execAsync(`cd "${cloneDir}" && git pull --ff-only 2>/dev/null`, { timeout: 15000 });
          await execAsync(`test -f "${cloneDir}/${normalizedId}/agent-harness/setup.py"`, { timeout: 1000 });
          harnessDir = `${cloneDir}/${normalizedId}/agent-harness`;
        } catch {
          console.warn(`[CLI-Anything] Still no harness for "${normalizedId}" after pull`);
          return false;
        }
      }
    } catch {
      // No repo at all — clone it
      try {
        console.log(`[CLI-Anything] Cloning CLI-Anything repo to ${cloneDir}...`);
        await execAsync(
          `git clone --depth 1 https://github.com/HKUDS/CLI-Anything.git "${cloneDir}"`,
          { timeout: 60000 },
        );
        harnessDir = `${cloneDir}/${normalizedId}/agent-harness`;
        // Verify it exists
        await execAsync(`test -f "${harnessDir}/setup.py"`, { timeout: 1000 });
      } catch (err: any) {
        console.warn(`[CLI-Anything] Failed to clone repo: ${err.message?.slice(0, 100)}`);
        return false;
      }
    }
  }

  if (!harnessDir) return false;

  // Install the harness
  console.log(`[CLI-Anything] Auto-installing harness from ${harnessDir}...`);
  try {
    const { stdout, stderr } = await execAsync(
      `cd "${harnessDir}" && pip install -e . --break-system-packages 2>&1`,
      { timeout: 60000 },
    );
    console.log(`[CLI-Anything] Install output: ${(stdout || stderr).trim().split('\n').slice(-2).join(' | ')}`);
  } catch (err: any) {
    console.warn(`[CLI-Anything] pip install failed: ${err.message?.slice(0, 200)}`);
    return false;
  }

  // Verify it's on PATH
  try {
    const { stdout } = await execAsync(`which cli-anything-${normalizedId} 2>/dev/null`, { timeout: 2000 });
    if (!stdout.trim()) throw new Error('not on PATH');
  } catch {
    console.warn(`[CLI-Anything] Installed but cli-anything-${normalizedId} not on PATH`);
    return false;
  }

  // Discover commands
  let commands: string[] | undefined;
  try {
    const { stdout } = await execAsync(
      `cli-anything-${normalizedId} --help 2>/dev/null | grep -E '^  [a-z]' | awk '{print $1}'`,
      { timeout: 5000 },
    );
    const parsed = stdout.trim().split('\n').filter(Boolean);
    if (parsed.length > 0) commands = parsed;
  } catch { /* non-fatal */ }

  // Check for and read SKILL.md
  let skillPath: string | undefined;
  let skillContent: string | undefined;
  try {
    const { stdout } = await execAsync(
      `python3 -c "import cli_anything.${normalizedId}; import os; print(os.path.dirname(cli_anything.${normalizedId}.__file__))" 2>/dev/null`,
      { timeout: 3000 },
    );
    const pkgDir = stdout.trim();
    if (pkgDir) {
      const candidatePath = `${pkgDir}/skills/SKILL.md`;
      try {
        await execAsync(`test -f "${candidatePath}"`, { timeout: 1000 });
        skillPath = candidatePath;
        const { stdout: rawSkill } = await execAsync(`cat "${candidatePath}"`, { timeout: 3000 });
        if (rawSkill.trim()) skillContent = rawSkill.trim();
      } catch { /* no SKILL.md */ }
    }
  } catch { /* non-fatal */ }

  // Update the profile in the registry
  const profile = getAppProfile(normalizedId);
  if (profile) {
    profile.cliAnything = {
      command: `cli-anything-${normalizedId}`,
      installed: true,
      commands,
      skillPath,
      skillContent,
    };
    if (!profile.availableSurfaces.includes('cli_anything')) {
      // Insert cli_anything right after programmatic (or at the front)
      const progIdx = profile.availableSurfaces.indexOf('programmatic');
      profile.availableSurfaces.splice(progIdx + 1, 0, 'cli_anything');
    }
    profile.lastScanned = new Date().toISOString();
    updateAppProfile(profile);
  } else {
    // Create a new profile for this app
    const newProfile: AppProfile = {
      appId: normalizedId,
      displayName: normalizedId.charAt(0).toUpperCase() + normalizedId.slice(1),
      binaryPath: normalizedId,
      availableSurfaces: ['cli_anything', 'gui'],
      cliAnything: { command: `cli-anything-${normalizedId}`, installed: true, commands, skillPath, skillContent },
      windowMatcher: normalizedId,
      confidence: 0.8,
      lastScanned: new Date().toISOString(),
    };
    updateAppProfile(newProfile);
  }

  console.log(`[CLI-Anything] ✓ Auto-installed cli-anything-${normalizedId} (${commands?.length || '?'} commands${skillPath ? ', SKILL.md found' : ''})`);
  return true;
}
