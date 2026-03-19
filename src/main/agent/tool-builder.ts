/**
 * Tool Builder — Defines Anthropic tool schemas for each group
 * and provides the dispatch map (tool name → execute function).
 * 
 * Also provides filterTools() for the routing layer to remove
 * disallowed tools based on the ExecutionPlan.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ToolGroup } from './classifier';
import { executeShellExec, executeFileRead, executeFileWrite, executeFileEdit, executeDirectoryTree } from './executors/core-executors';
import { executeBrowserSearch, executeBrowserNavigate, executeBrowserReadPage, executeBrowserClick, executeBrowserType, executeBrowserExtract, executeBrowserScreenshot, executeBrowserScroll } from './executors/browser-executors';
import { executeCreateDocument, executeMemorySearch, executeMemoryStore, executeRecallContext } from './executors/extra-executors';
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
    description: 'Read file contents. Use startLine/endLine for large files.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
        startLine: { type: 'number', description: 'First line (1-indexed)' },
        endLine: { type: 'number', description: 'Last line (1-indexed)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_write',
    description: 'Create or overwrite a file. Parent directories created automatically.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute path' },
        content: { type: 'string', description: 'Complete file content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'file_edit',
    description: 'Edit a file by replacing one exact string. old_str must appear exactly once.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute path' },
        old_str: { type: 'string', description: 'Exact string to find (once)' },
        new_str: { type: 'string', description: 'Replacement' },
      },
      required: ['path', 'old_str', 'new_str'],
    },
  },
  {
    name: 'directory_tree',
    description: 'List files/dirs in tree structure. Ignores node_modules, .git, hidden files.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute path' },
        depth: { type: 'number', description: 'Max depth (default 3, max 10)' },
      },
      required: ['path'],
    },
  },
];

const BROWSER_TOOLS: Anthropic.Tool[] = [
  { name: 'browser_search', description: 'Web search via Google. Returns top 5 results.', input_schema: { type: 'object' as const, properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] } },
  { name: 'browser_navigate', description: 'Navigate to URL. Returns title, URL, visible text, AND a numbered list of interactive elements (buttons, links, inputs) with their types, labels, and aria attributes. Use element indices from this list for precise clicking.', input_schema: { type: 'object' as const, properties: { url: { type: 'string', description: 'URL' } }, required: ['url'] } },
  { name: 'browser_read_page', description: 'Re-read current page text + interactive elements. Use after SPA navigation or dynamic content changes. Returns the same format as browser_navigate (text + element list).', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'browser_click', description: 'Click element by index number (from element list), CSS selector, or visible text match. Returns click confirmation + updated interactive elements. Use index for precision: browser_click("3") clicks element [3]. Use CSS selector for specifics: browser_click("[aria-label=Compose]"). Use text for simple cases: browser_click("Submit").', input_schema: { type: 'object' as const, properties: { target: { type: 'string', description: 'Element index number, CSS selector, or text to match' } }, required: ['target'] } },
  { name: 'browser_type', description: 'Type text into input field.', input_schema: { type: 'object' as const, properties: { text: { type: 'string', description: 'Text to type' }, selector: { type: 'string', description: 'Optional CSS selector' } }, required: ['text'] } },
  { name: 'browser_extract', description: 'Extract targeted structured data from the current page. Supports: tables ("extract the pricing table"), lists ("list all menu items"), prices ("find all prices"), links ("extract navigation links"), forms ("list form fields"), headings ("page structure"), images ("list images with alt text"). More efficient than browser_read_page when you need specific data.', input_schema: { type: 'object' as const, properties: { instruction: { type: 'string', description: 'What to extract — be specific (e.g. "pricing table", "form fields", "navigation links")' } }, required: ['instruction'] } },
  { name: 'browser_screenshot', description: 'Screenshot browser viewport.', input_schema: { type: 'object' as const, properties: {} } },
  {
    name: 'browser_scroll',
    description: 'Scroll the browser page. Use to access content below the fold or return to the top. Returns visible text after scrolling plus scroll position (percentage, at-top/at-bottom indicators). Default scrolls ~80% of viewport height.',
    input_schema: {
      type: 'object' as const,
      properties: {
        direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'], description: 'Scroll direction. "down"/"up" scroll incrementally, "top"/"bottom" jump to page edges.' },
        amount: { type: 'number', description: 'Pixels to scroll (optional — defaults to 80% of viewport)' },
      },
      required: ['direction'],
    },
  },
];

const EXTRA_TOOLS: Anthropic.Tool[] = [
  {
    name: 'create_document',
    description: 'Create document (docx, pdf, xlsx, csv, md, html, json, txt).',
    input_schema: { type: 'object' as const, properties: { filename: { type: 'string' }, format: { type: 'string', enum: ['docx', 'pdf', 'xlsx', 'csv', 'md', 'html', 'json', 'txt'] }, content: { type: 'string' }, structured_data: { type: 'array' } }, required: ['filename', 'format'] },
  },
  {
    name: 'memory_search',
    description: 'Search persistent memory for stored facts about the user. Use proactively when: the user references a previous preference, project, or personal detail; you need context about their setup, stack, or habits; the user says "remember" or "you know". Keywords and short phrases work best.',
    input_schema: { type: 'object' as const, properties: { query: { type: 'string', description: 'Search keywords (e.g. "preferred editor", "home city", "current project")' }, limit: { type: 'number', description: 'Max results (default 5)' } }, required: ['query'] },
  },
  {
    name: 'memory_store',
    description: 'Store a fact about the user in persistent memory. Use when: the user shares a personal detail, preference, or workflow habit; the user explicitly asks to remember something; you learn something useful about their setup or projects. Do NOT store secrets, passwords, or API keys.',
    input_schema: { type: 'object' as const, properties: { category: { type: 'string', enum: ['preference', 'account', 'workflow', 'fact', 'context'], description: 'preference=editor/style, account=name/email/company, workflow=tools/processes, fact=location/skills, context=current task/goals' }, key: { type: 'string', description: 'Unique snake_case label (e.g. preferred_editor, home_city)' }, value: { type: 'string', description: 'The fact (one sentence max)' } }, required: ['category', 'key', 'value'] },
  },
  {
    name: 'recall_context',
    description: 'Search past conversations for relevant context. Use when: the user references something discussed before; you want to check if this topic was covered previously; you need context about their past requests or your past answers. Returns conversation snippets, not full transcripts.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search keywords for past conversations' },
        limit: { type: 'number', description: 'Max results (default 3)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'app_control',
    description: 'Control a desktop app via the best available surface. Automatically tries each control surface (DBus → CLI-Anything → native CLI) in priority order with fallback. Use for any structured app interaction. Returns guidance if the task should use shell_exec or gui_interact instead.',
    input_schema: { type: 'object' as const, properties: { app: { type: 'string', description: 'App name' }, command: { type: 'string', description: 'Command' }, json: { type: 'boolean' } }, required: ['app', 'command'] },
  },
  {
    name: 'gui_interact',
    description: 'GUI automation for DESKTOP applications — LAST RESORT. Only for native desktop apps (GIMP, Blender, LibreOffice, etc.) when no programmatic, DBus, or CLI surface works. NEVER use gui_interact for the browser — use browser_click, browser_type, browser_navigate instead. Primitive actions: batch_actions, click, type, key, wait, focus, screenshot, analyze_screenshot, verify_window_title, verify_file_exists, list_windows, find_window. GUI Macros (prefer these for common workflows): launch_and_focus (launch app + wait + focus + OCR), open_menu_path (navigate menus via keyboard), fill_dialog (tab through fields + type values + confirm), confirm_dialog (wait + Enter or click button), export_file (shortcut + fill path + confirm + verify).',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['batch_actions', 'screenshot_and_focus', 'analyze_screenshot', 'click', 'type', 'key', 'screenshot', 'find_window', 'focus', 'list_windows', 'wait', 'verify_window_title', 'verify_file_exists', 'screenshot_region', 'launch_and_focus', 'open_menu_path', 'fill_dialog', 'confirm_dialog', 'export_file'] },
        window: { type: 'string', description: 'Window title. For batch_actions, set here to apply to all steps.' },
        x: { type: 'number' }, y: { type: 'number' },
        text: { type: 'string', description: 'Text to type, key combo, or filepath' },
        path: { type: 'string', description: 'Filepath for verify_file_exists' },
        delay: { type: 'number' }, ms: { type: 'number' },
        app: { type: 'string', description: 'App binary name for launch_and_focus' },
        fields: { type: 'array', description: 'For fill_dialog: [{value, label?}] in tab order', items: { type: 'object', properties: { value: { type: 'string' }, label: { type: 'string' } }, required: ['value'] } },
        button: { type: 'string', description: 'For confirm_dialog: button label to click (default: Enter key)' },
        shortcut: { type: 'string', description: 'For export_file: override keyboard shortcut' },
        confirm: { type: 'boolean', description: 'For fill_dialog: press Enter after filling (default: true)' },
        settle_ms: { type: 'number', description: 'For confirm_dialog: ms to wait before confirming (default: 300)' },
        verify: { type: 'boolean', description: 'Force or skip post-action OCR verification' },
        rx: { type: 'number' }, ry: { type: 'number' }, rw: { type: 'number' }, rh: { type: 'number' },
        actions: { type: 'array', description: 'For batch_actions. Max 20 steps.', items: { type: 'object', properties: { action: { type: 'string', enum: ['click', 'type', 'key', 'focus', 'screenshot', 'wait', 'verify_window_title', 'verify_file_exists'] }, window: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, text: { type: 'string' }, path: { type: 'string' }, delay: { type: 'number' }, ms: { type: 'number' } }, required: ['action'] } },
      },
      required: ['action'],
    },
  },
  {
    name: 'dbus_control',
    description: 'Control apps via DBus — PREFERRED over gui_interact for any app with a DBus interface. Use for all media control (play/pause/next/volume). Actions: list_running, discover, call, get_property. For any MPRIS player: service="org.mpris.MediaPlayer2.{app}" path="/org/mpris/MediaPlayer2" interface="org.mpris.MediaPlayer2.Player". A void method return = SUCCESS.',
    input_schema: { type: 'object' as const, properties: { action: { type: 'string', enum: ['discover', 'call', 'get_property', 'list_running'] }, service: { type: 'string', description: 'DBus service (e.g. org.mpris.MediaPlayer2.spotify)' }, path: { type: 'string', description: 'Object path (e.g. /org/mpris/MediaPlayer2)' }, interface: { type: 'string', description: 'Interface (e.g. org.mpris.MediaPlayer2.Player)' }, method: { type: 'string', description: 'Method or property name' }, args: { type: 'array', items: { type: 'string' } } }, required: ['action'] },
  },
];

// ═══════════════════════════════════
// Group Builders
// ═══════════════════════════════════

export function getToolsForGroup(group: ToolGroup): Anthropic.Tool[] {
  switch (group) {
    case 'core': return [...CORE_TOOLS];
    case 'browser': return [...BROWSER_TOOLS];
    case 'full': return [...CORE_TOOLS, ...BROWSER_TOOLS, ...EXTRA_TOOLS];
  }
}

/**
 * Filter tools by removing disallowed tool names.
 * Used by the routing layer to constrain what the LLM can call.
 */
export function filterTools(tools: Anthropic.Tool[], disallowed: string[]): Anthropic.Tool[] {
  if (disallowed.length === 0) return tools;
  const blocked = new Set(disallowed);
  const filtered = tools.filter(t => !blocked.has(t.name));
  if (filtered.length < tools.length) {
    console.log(`[Tools] Filtered out: ${disallowed.join(', ')} (${tools.length} → ${filtered.length} tools)`);
  }
  return filtered;
}

// ═══════════════════════════════════
// Dispatch Map
// ═══════════════════════════════════

export type ToolExecutor = (input: Record<string, any>) => Promise<string>;
export type StreamingToolExecutor = (input: Record<string, any>, onChunk?: (chunk: string) => void) => Promise<string>;

// Streaming-capable executors (accept optional onChunk callback)
const STREAMING_DISPATCH: Record<string, StreamingToolExecutor> = {
  shell_exec: executeShellExec,
};

// Standard executors (no streaming)
const DISPATCH: Record<string, ToolExecutor> = {
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
  browser_scroll: executeBrowserScroll,
  create_document: executeCreateDocument,
  memory_search: executeMemorySearch,
  memory_store: executeMemoryStore,
  recall_context: executeRecallContext,
  app_control: executeAppControl,
  gui_interact: executeGuiInteract,
  dbus_control: executeDbusControl,
};

/**
 * Check whether a tool name exists in any dispatch table.
 * Used by the agent loop to distinguish classifier under-routing
 * (tool exists but wasn't included) from hallucinated tool names.
 */
export function isKnownTool(name: string): boolean {
  return name in STREAMING_DISPATCH || name in DISPATCH;
}

export function executeTool(
  name: string,
  input: Record<string, any>,
  onChunk?: (toolName: string, chunk: string) => void,
): Promise<string> {
  // Check streaming-capable tools first
  const streamingExecutor = STREAMING_DISPATCH[name];
  if (streamingExecutor) {
    const chunkCb = onChunk ? (chunk: string) => onChunk(name, chunk) : undefined;
    return streamingExecutor(input, chunkCb);
  }
  const executor = DISPATCH[name];
  if (!executor) return Promise.resolve(`[Error] Unknown tool: ${name}`);
  return executor(input);
}
