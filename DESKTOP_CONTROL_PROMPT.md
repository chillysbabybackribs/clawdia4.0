# Claude Code Prompt — Desktop Control System for Clawdia 4.0

## Context

Clawdia 4.0 is an Electron desktop AI agent at `~/Desktop/clawdia4.0`. It has a working agent loop with streaming, tool execution (filesystem, browser, memory), SQLite persistence, and multi-tab BrowserView. The agent controls the user's machine via `shell_exec` for commands and BrowserView for web browsing.

**Your task:** Build a 3-tier desktop application control system that lets Clawdia interact with ANY desktop application — open-source or proprietary, with or without CLI interfaces.

## The Three Tiers (Fallback Chain)

When the user asks Clawdia to interact with a desktop application, the agent should try these approaches in order:

### Tier 1: CLI-Anything Harness (Best — Structured, Deterministic)
For open-source apps where a CLI-Anything harness has been generated.
- Check: `which cli-anything-<appname>` 
- Use: `cli-anything-<appname> --json <command>`
- Returns structured JSON output the LLM can parse perfectly
- Supported apps: GIMP, Blender, Inkscape, LibreOffice, OBS, Kdenlive, Audacity, Shotcut, Zoom

### Tier 2: GUI Automation (Good — Works on Any Visible Window)
For apps without CLI harnesses but with visible windows.
- Uses: `xdotool` (keyboard/mouse), `wmctrl` (window management), `scrot` (screenshots)
- Supports: click coordinates, type text, send keystrokes, find/focus windows
- Can take screenshots for visual feedback (the LLM reads the image to find targets)
- Works on: ANY app with a GUI window on X11

### Tier 3: DBus / Accessibility (Advanced — Programmatic Control)
For apps that expose DBus interfaces or accessibility trees.
- Uses: `dbus-send`, `gdbus`, `python3 -c "import dbus..."` for DBus
- Uses: `python3` with `dogtail` or AT-SPI for accessibility tree inspection
- Examples: Spotify (MPRIS), media players, GNOME apps, Electron apps
- Can discover available methods/properties on running apps

## What to Build

### 1. New File: `src/main/agent/executors/desktop-executors.ts`

Create three new tool executors:

```typescript
// Tier 1: CLI-Anything integration
export async function executeAppControl(input: {
  app: string;       // e.g., "gimp", "blender", "libreoffice"
  command: string;    // e.g., "open-file /path/to/image.png", "export --format png"
  json?: boolean;     // default true — use --json flag
}): Promise<string>

// Tier 2: GUI automation  
export async function executeGuiInteract(input: {
  action: 'click' | 'type' | 'key' | 'screenshot' | 'find_window' | 'focus' | 'list_windows';
  window?: string;    // window title/class to target (for wmctrl)
  x?: number;         // click coordinates
  y?: number;
  text?: string;      // text to type or key combo to send
  delay?: number;     // delay in ms before action
}): Promise<string>

// Tier 3: DBus discovery and control
export async function executeDbusControl(input: {
  action: 'discover' | 'call' | 'get_property' | 'list_running';
  service?: string;   // e.g., "org.mpris.MediaPlayer2.spotify"
  path?: string;      // e.g., "/org/mpris/MediaPlayer2"
  interface?: string; // e.g., "org.mpris.MediaPlayer2.Player"
  method?: string;    // e.g., "PlayPause"
  args?: string[];    // method arguments
}): Promise<string>
```

#### Implementation Details for Each Executor:

**`executeAppControl` (CLI-Anything):**
```typescript
async function executeAppControl(input) {
  const { app, command, json = true } = input;
  const harness = `cli-anything-${app.toLowerCase()}`;
  
  // Check if harness is installed
  const { stdout: which } = await execAsync(`which ${harness} 2>/dev/null`);
  if (!which.trim()) {
    return `[No CLI-Anything harness for "${app}". Install: cd <source> && pip install -e .]
    
Falling back to native CLI. Try:
- ${app} --help
- ${app} --version
- For headless: ${app} --headless (LibreOffice) or ${app} -b (Blender)`;
  }
  
  // Execute with --json for structured output
  const flag = json ? ' --json' : '';
  const result = await execAsync(`${harness}${flag} ${command}`, { timeout: 60000 });
  return result.stdout;
}
```

**`executeGuiInteract` (xdotool/wmctrl/scrot):**
```typescript
async function executeGuiInteract(input) {
  const { action, window, x, y, text, delay } = input;
  
  switch (action) {
    case 'list_windows':
      // wmctrl -l returns window list with IDs, desktop, class, title
      return await exec('wmctrl -l -p');
      
    case 'find_window':
      // xdotool search by name/class
      return await exec(`xdotool search --name "${window}" getwindowname %@`);
      
    case 'focus':
      // Activate and raise window
      await exec(`wmctrl -a "${window}"`);
      return `Focused: ${window}`;
      
    case 'click':
      if (window) await exec(`wmctrl -a "${window}"`);
      if (delay) await wait(delay);
      await exec(`xdotool mousemove ${x} ${y} click 1`);
      return `Clicked (${x}, ${y})`;
      
    case 'type':
      if (window) await exec(`wmctrl -a "${window}"`);
      if (delay) await wait(delay);
      await exec(`xdotool type --delay 20 "${text}"`);
      return `Typed: "${text}"`;
      
    case 'key':
      if (window) await exec(`wmctrl -a "${window}"`);
      await exec(`xdotool key ${text}`);  // text is the key combo, e.g., "ctrl+s"
      return `Sent key: ${text}`;
      
    case 'screenshot':
      // Capture specific window or full screen
      const filename = `/tmp/clawdia-screenshot-${Date.now()}.png`;
      if (window) {
        const wid = await exec(`xdotool search --name "${window}" | head -1`);
        await exec(`scrot -u ${filename}`); // -u = focused window
      } else {
        await exec(`scrot ${filename}`);
      }
      // Return base64 or just the path
      return `[Screenshot saved: ${filename}]`;
  }
}
```

**`executeDbusControl`:**
```typescript
async function executeDbusControl(input) {
  const { action, service, path, interface: iface, method, args = [] } = input;
  
  switch (action) {
    case 'list_running':
      // List all DBus services (session bus)
      const result = await exec(`dbus-send --session --dest=org.freedesktop.DBus --type=method_call --print-reply /org/freedesktop/DBus org.freedesktop.DBus.ListNames`);
      // Filter to interesting services (skip org.freedesktop internals)
      return filterInterestingServices(result);
      
    case 'discover':
      // Introspect a service to find methods/properties
      return await exec(`dbus-send --session --dest=${service} --type=method_call --print-reply ${path || '/'} org.freedesktop.DBus.Introspectable.Introspect`);
      
    case 'call':
      const argsStr = args.map(a => `string:"${a}"`).join(' ');
      return await exec(`dbus-send --session --dest=${service} --type=method_call --print-reply ${path} ${iface}.${method} ${argsStr}`);
      
    case 'get_property':
      return await exec(`dbus-send --session --dest=${service} --type=method_call --print-reply ${path} org.freedesktop.DBus.Properties.Get string:"${iface}" string:"${method}"`);
  }
}
```

### 2. Register Tools in `src/main/agent/tool-builder.ts`

Add three new tool schemas to the `EXTRA_TOOLS` array (they go in the "full" group):

```typescript
{
  name: 'app_control',
  description: 'Control a desktop application via CLI-Anything harness. Use for GIMP, Blender, LibreOffice, OBS, Inkscape, Audacity, Kdenlive. Returns structured JSON. Falls back to native CLI if no harness is installed.',
  input_schema: {
    type: 'object',
    properties: {
      app: { type: 'string', description: 'Application name (e.g., "gimp", "blender", "libreoffice")' },
      command: { type: 'string', description: 'Command to execute (e.g., "open-file /path", "export --format png")' },
      json: { type: 'boolean', description: 'Use --json flag (default true)' },
    },
    required: ['app', 'command'],
  },
},
{
  name: 'gui_interact',
  description: 'Interact with any visible GUI window. Use xdotool for mouse/keyboard, wmctrl for window management, scrot for screenshots. Works on ANY desktop app. Actions: list_windows, find_window, focus, click, type, key, screenshot.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['click', 'type', 'key', 'screenshot', 'find_window', 'focus', 'list_windows'], description: 'Action to perform' },
      window: { type: 'string', description: 'Window title/class to target' },
      x: { type: 'number', description: 'X coordinate for click' },
      y: { type: 'number', description: 'Y coordinate for click' },
      text: { type: 'string', description: 'Text to type, or key combo for "key" action (e.g., "ctrl+s")' },
      delay: { type: 'number', description: 'Delay in ms before action' },
    },
    required: ['action'],
  },
},
{
  name: 'dbus_control',
  description: 'Control desktop apps via DBus. Discover running services, introspect methods, call functions, get properties. Use for Spotify (MPRIS), media players, GNOME apps. Actions: list_running, discover, call, get_property.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['discover', 'call', 'get_property', 'list_running'], description: 'DBus action' },
      service: { type: 'string', description: 'DBus service name (e.g., "org.mpris.MediaPlayer2.spotify")' },
      path: { type: 'string', description: 'Object path (e.g., "/org/mpris/MediaPlayer2")' },
      interface: { type: 'string', description: 'Interface name' },
      method: { type: 'string', description: 'Method to call or property to get' },
      args: { type: 'array', items: { type: 'string' }, description: 'Method arguments' },
    },
    required: ['action'],
  },
},
```

### 3. Update `src/main/agent/prompt/modules/DESKTOP_APPS.md`

Replace the current content with a more comprehensive prompt module:

```markdown
## Desktop Application Control

You have three tools for controlling desktop applications, tried in this order:

### 1. app_control (CLI-Anything) — PREFERRED
For apps with CLI-Anything harnesses installed. Check first:
- Use `app_control` with the app name and command
- Returns structured JSON output
- Supported: GIMP, Blender, Inkscape, LibreOffice, OBS, Kdenlive, Audacity, Shotcut
- If not installed, falls back with instructions

### 2. gui_interact (xdotool/wmctrl) — ANY VISIBLE APP
For any app with a visible window:
- `list_windows` first to see what's running
- `focus` the target window
- `screenshot` to see the current state (you'll get the image path)
- `click` at specific coordinates
- `type` text or `key` combos (e.g., "ctrl+s", "alt+F4")
- Requires: xdotool, wmctrl, scrot (install via apt if missing)

### 3. dbus_control — PROGRAMMATIC CONTROL
For apps exposing DBus interfaces:
- `list_running` to discover available services
- `discover` to introspect a service's methods
- `call` to invoke methods (e.g., Spotify PlayPause)
- Common patterns:
  - Spotify: service=org.mpris.MediaPlayer2.spotify, path=/org/mpris/MediaPlayer2
  - Media players: org.mpris.MediaPlayer2.*

### Fallback Strategy
1. Try app_control first (structured, reliable)
2. If no harness, try dbus_control discover to see if DBus is available
3. If no DBus, use gui_interact (works on anything with a window)
4. If no window visible, launch the app with shell_exec first

### Important Rules
- Always background GUI launches: `shell_exec("gimp &")`
- Wait after launching before interacting: use delay parameter
- For gui_interact clicks, take a screenshot first to verify coordinates
- Never fabricate what an app showed — use screenshot or tool output
```

### 4. Update Classifier (`src/main/agent/classifier.ts`)

Expand the `DESKTOP_APP_RE` regex to catch more applications:

```typescript
const DESKTOP_APP_RE = /gimp|blender|inkscape|libreoffice|audacity|obs\b|kdenlive|shotcut|vlc|firefox|chrome|spotify|discord|slack|steam|figma|zoom|thunderbird|nautilus|thunar|dolphin|terminal|code\b|vscode|sublime|atom|(launch|open|start|run|control|interact).*app|play.*music|pause.*music|next.*track|screenshot|click.*button|type.*into/i;
```

Note the additions: spotify, discord, slack, steam, zoom, music control phrases, and GUI interaction phrases like "click", "type into".

### 5. Dependency Check on Startup

Add to `src/main/agent/executors/desktop-executors.ts` a helper that checks which tools are available:

```typescript
export async function checkDesktopCapabilities(): Promise<{
  xdotool: boolean;
  wmctrl: boolean;
  scrot: boolean;
  dbus: boolean;
  cliAnythingApps: string[];
}> {
  const check = async (cmd: string) => {
    try { await execAsync(`which ${cmd}`); return true; } catch { return false; }
  };
  
  const [xdotool, wmctrl, scrot, dbus] = await Promise.all([
    check('xdotool'), check('wmctrl'), check('scrot'), check('dbus-send'),
  ]);
  
  // Scan for installed CLI-Anything harnesses
  let cliAnythingApps: string[] = [];
  try {
    const { stdout } = await execAsync('compgen -c cli-anything- 2>/dev/null || ls /usr/local/bin/cli-anything-* 2>/dev/null');
    cliAnythingApps = stdout.trim().split('\n')
      .map(s => s.replace(/.*cli-anything-/, ''))
      .filter(Boolean);
  } catch { /* no harnesses installed */ }
  
  return { xdotool, wmctrl, scrot, dbus, cliAnythingApps };
}
```

This can be called once at startup and the results cached + injected into the dynamic prompt so the LLM knows what's available without probing every time.

## Testing

After implementation, test these scenarios:

1. **"Open GIMP and create a new 800x600 image"** → should try app_control first, fall back to shell_exec
2. **"List all open windows"** → gui_interact with action=list_windows
3. **"What's playing on Spotify?"** → dbus_control with MPRIS interface
4. **"Take a screenshot of the desktop"** → gui_interact with action=screenshot
5. **"Click the save button in LibreOffice"** → gui_interact with screenshot first, then click
6. **"Pause the music"** → dbus_control with MPRIS PlayPause

## Important Notes

- All three tools go through `shell_exec` under the hood — they're convenience wrappers that give the LLM structured interfaces instead of requiring it to compose raw bash commands
- `xdotool` only works on X11, NOT Wayland. If the user is on Wayland, the gui_interact tool should detect this and warn. Check with: `echo $XDG_SESSION_TYPE`
- `scrot` screenshots are saved to `/tmp/` and cleaned up periodically
- DBus service names vary between distros — the LLM should use `list_running` to discover rather than hardcoding
- CLI-Anything harnesses need to be installed separately by the user — Clawdia should offer to help install them if requested
