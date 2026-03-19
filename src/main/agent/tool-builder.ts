/**
 * Tool Builder — Defines Anthropic tool schemas for each group
 * and provides the dispatch map (tool name → execute function).
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ToolGroup } from './classifier';
import { executeShellExec, executeFileRead, executeFileWrite, executeFileEdit, executeDirectoryTree } from './executors/core-executors';
import { executeBrowserSearch, executeBrowserNavigate, executeBrowserReadPage, executeBrowserClick, executeBrowserType, executeBrowserExtract, executeBrowserScreenshot } from './executors/browser-executors';
import { executeCreateDocument, executeMemorySearch, executeMemoryStore } from './executors/extra-executors';
import { executeAppControl, executeGuiInteract, executeDbusControl } from './executors/desktop-executors';

const CORE_TOOLS: Anthropic.Tool[] = [
  {
    name: 'shell_exec',
    description: 'Execute a bash command in a persistent shell session. The shell retains cwd between calls. Returns stdout, stderr, and exit code. Use for: installing packages, running builds, launching apps, system queries, git operations. Background GUI processes with & so the command returns.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
        timeout: { type: 'number', description: 'Timeout in seconds (default 30, max 300)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'file_read',
    description: 'Read file contents. Use startLine/endLine for large files. Prefer grep via shell_exec when searching for patterns across many files.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
        startLine: { type: 'number', description: 'First line to read (1-indexed)' },
        endLine: { type: 'number', description: 'Last line to read (1-indexed)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_write',
    description: 'Create a new file or overwrite an existing file. For modifying existing files, prefer file_edit. Parent directories are created automatically.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute path for the file' },
        content: { type: 'string', description: 'Complete file content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'file_edit',
    description: 'Edit an existing file by replacing one exact string with another. old_str must appear exactly once. Read the file first to get exact text.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
        old_str: { type: 'string', description: 'Exact string to find (must appear once)' },
        new_str: { type: 'string', description: 'Replacement string' },
      },
      required: ['path', 'old_str', 'new_str'],
    },
  },
  {
    name: 'directory_tree',
    description: 'List files and directories in a tree structure. Use depth to limit recursion. Ignores node_modules, .git, and hidden files by default.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute path to the directory' },
        depth: { type: 'number', description: 'Max recursion depth (default 3, max 10)' },
      },
      required: ['path'],
    },
  },
];

const BROWSER_TOOLS: Anthropic.Tool[] = [
  {
    name: 'browser_search',
    description: 'Web search via Google. Returns top 5 results with titles, URLs, and snippets.',
    input_schema: {
      type: 'object' as const,
      properties: { query: { type: 'string', description: 'The search query' } },
      required: ['query'],
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate to a URL in the visible browser panel. Returns page title, URL, and visible text.',
    input_schema: {
      type: 'object' as const,
      properties: { url: { type: 'string', description: 'The URL to navigate to' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_read_page',
    description: 'Re-read current page text. Only needed if page changed since last navigation.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'browser_click',
    description: 'Click an element on the current page. Use element index (preferred), CSS selector, or visible text.',
    input_schema: {
      type: 'object' as const,
      properties: { target: { type: 'string', description: 'Element index, CSS selector, or visible text' } },
      required: ['target'],
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into an input field. Does NOT submit — click submit separately.',
    input_schema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Text to type' },
        selector: { type: 'string', description: 'Optional CSS selector for target input' },
      },
      required: ['text'],
    },
  },
  {
    name: 'browser_extract',
    description: 'Extract structured data from current page.',
    input_schema: {
      type: 'object' as const,
      properties: {
        instruction: { type: 'string', description: 'What to extract' },
        schema: { type: 'object', description: 'JSON schema for extraction shape' },
      },
      required: ['instruction'],
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Capture screenshot of browser viewport.',
    input_schema: { type: 'object' as const, properties: {} },
  },
];

const EXTRA_TOOLS: Anthropic.Tool[] = [
  {
    name: 'create_document',
    description: 'Create a document file (docx, pdf, xlsx, csv, md, html, json, txt). Saves to ~/Documents/Clawdia/ by default.',
    input_schema: {
      type: 'object' as const,
      properties: {
        filename: { type: 'string', description: 'Filename with extension' },
        format: { type: 'string', enum: ['docx', 'pdf', 'xlsx', 'csv', 'md', 'html', 'json', 'txt'], description: 'Output format' },
        content: { type: 'string', description: 'Markdown content (for text formats)' },
        structured_data: { type: 'array', description: 'Array of objects (for xlsx, csv, json)' },
      },
      required: ['filename', 'format'],
    },
  },
  {
    name: 'memory_search',
    description: 'Search persistent memory for stored facts and context.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search terms' },
        limit: { type: 'number', description: 'Max results (default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_store',
    description: 'Store a fact in persistent memory. Use ONLY when user explicitly asks to remember something.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: { type: 'string', enum: ['preference', 'account', 'workflow', 'fact', 'context'] },
        key: { type: 'string', description: 'Short label' },
        value: { type: 'string', description: 'The fact to remember' },
      },
      required: ['category', 'key', 'value'],
    },
  },
  // ── Desktop Control ──
  {
    name: 'app_control',
    description: 'Control a desktop application via CLI-Anything harness. For GIMP, Blender, LibreOffice, OBS, Inkscape, Audacity, Kdenlive, Shotcut. Returns structured JSON. Falls back to native CLI if no harness installed. Try this FIRST before gui_interact.',
    input_schema: {
      type: 'object' as const,
      properties: {
        app: { type: 'string', description: 'Application name (e.g., "gimp", "blender")' },
        command: { type: 'string', description: 'Command (e.g., "open-file /path", "--help")' },
        json: { type: 'boolean', description: 'Use --json flag (default true)' },
      },
      required: ['app', 'command'],
    },
  },
  {
    name: 'gui_interact',
    description: `Interact with any visible GUI window. Works on ANY desktop app.

ACTIONS:
- batch_actions: Execute multiple steps in ONE call. Pass "actions" array. STRONGLY PREFERRED for 2+ step sequences — each step can be click/type/key/focus/screenshot with optional delay. Eliminates round-trips.
- screenshot_and_focus: Focus a window AND take screenshot in one call. Use instead of separate focus+screenshot.
- list_windows: See all open windows (wmctrl).
- find_window: Search windows by title.
- focus: Bring window to front.
- click: Click at (x, y) coordinates.
- type: Type text into focused input.
- key: Send keyboard shortcut (e.g., "ctrl+s", "Return").
- screenshot: Capture window or full screen.

ALWAYS prefer batch_actions for multi-step GUI sequences and screenshot_and_focus for initial orientation.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['batch_actions', 'screenshot_and_focus', 'click', 'type', 'key', 'screenshot', 'find_window', 'focus', 'list_windows'],
          description: 'Action to perform. Use batch_actions for multi-step sequences.',
        },
        window: { type: 'string', description: 'Window title to target' },
        x: { type: 'number', description: 'X coordinate for click' },
        y: { type: 'number', description: 'Y coordinate for click' },
        text: { type: 'string', description: 'Text to type or key combo (e.g., "ctrl+s")' },
        delay: { type: 'number', description: 'Delay in ms before action' },
        actions: {
          type: 'array',
          description: 'For batch_actions: array of step objects. Each step: {action, window?, x?, y?, text?, delay?}. Max 20 steps.',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['click', 'type', 'key', 'focus', 'screenshot'] },
              window: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
              text: { type: 'string' },
              delay: { type: 'number' },
            },
            required: ['action'],
          },
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'dbus_control',
    description: 'Control desktop apps via DBus. For Spotify (MPRIS), media players, GNOME apps. Actions: list_running, discover, call, get_property.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['discover', 'call', 'get_property', 'list_running'] },
        service: { type: 'string', description: 'DBus service name' },
        path: { type: 'string', description: 'Object path' },
        interface: { type: 'string', description: 'Interface name' },
        method: { type: 'string', description: 'Method or property name' },
        args: { type: 'array', items: { type: 'string' }, description: 'Method arguments' },
      },
      required: ['action'],
    },
  },
];

export function getToolsForGroup(group: ToolGroup): Anthropic.Tool[] {
  switch (group) {
    case 'core': return [...CORE_TOOLS];
    case 'browser': return [...BROWSER_TOOLS];
    case 'full': return [...CORE_TOOLS, ...BROWSER_TOOLS, ...EXTRA_TOOLS];
  }
}

export type ToolExecutor = (input: Record<string, any>) => Promise<string>;

const DISPATCH: Record<string, ToolExecutor> = {
  shell_exec: executeShellExec,
  file_read: executeFileRead,
  file_write: executeFileWrite,
  file_edit: executeFileEdit,
  directory_tree: executeDirectoryTree,
  browser_search: executeBrowserSearch,
  browser_navigate: executeBrowserNavigate,
  browser_read_page: executeBrowserReadPage,
  browser_click: executeBrowserClick,
  browser_type: executeBrowserType,
  browser_extract: executeBrowserExtract,
  browser_screenshot: executeBrowserScreenshot,
  create_document: executeCreateDocument,
  memory_search: executeMemorySearch,
  memory_store: executeMemoryStore,
  app_control: executeAppControl,
  gui_interact: executeGuiInteract,
  dbus_control: executeDbusControl,
};

export function executeTool(name: string, input: Record<string, any>): Promise<string> {
  const executor = DISPATCH[name];
  if (!executor) return Promise.resolve(`[Error] Unknown tool: ${name}`);
  return executor(input);
}
