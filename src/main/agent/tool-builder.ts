/**
 * Tool Builder — Defines Anthropic tool schemas for each group
 * and provides the dispatch map (tool name → execute function).
 * 
 * Also provides filterTools() for the routing layer to remove
 * disallowed tools based on the ExecutionPlan.
 */

import type { ToolGroup } from './classifier';
import type { NormalizedToolDefinition } from './client';
import { executeShellExec, executeCalendarManage, executeFileRead, executeFileWrite, executeFileEdit, executeDirectoryTree, executeFsQuoteLookup, executeFsFolderSummary, executeFsReorgPlan, executeFsDuplicateScan, executeFsApplyPlan } from './executors/core-executors';
import { executeBrowserSearch, executeBrowserNavigate, executeBrowserReadPage, executeBrowserClick, executeBrowserType, executeBrowserExtract, executeBrowserExtractListings, executeBrowserExtractProductDetails, executeBrowserExtractReviewsSummary, executeBrowserScreenshot, executeBrowserScroll, executeBrowserFocusField, executeBrowserDetectForm, executeBrowserFillField, executeBrowserRunHarness, executeBrowserRegisterHarness, executeBrowserTabNew, executeBrowserTabSwitch, executeBrowserTabClose, executeBrowserTabList, executeBrowserEval, executeBrowserDomSnapshot, executeBrowserPageState, executeBrowserNetworkWatch, executeBrowserWait, executeBrowserBatch, executeBrowserCompareProducts } from './executors/browser-executors';
import { executeCreateDocument, executeMemorySearch, executeMemoryStore, executeRecallContext } from './executors/extra-executors';
import { executeAppControl, executeGuiInteract, executeDbusControl } from './executors/desktop-executors';
import { spawnSwarm } from './agent-spawn-executor';
import { executeSavedBloodhoundPlaybookById } from '../db/browser-playbooks';

const CORE_TOOLS: NormalizedToolDefinition[] = [
  {
    name: 'shell_exec',
    description: 'Execute a bash command in a persistent shell session. The shell retains cwd between calls. Returns stdout, stderr, and exit code. Use for: installing packages, running builds, launching apps, system queries, git operations. Background GUI processes with & so the command returns. Prefer dedicated structured tools like calendar_manage when available instead of hand-writing shell commands.',
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
    name: 'calendar_manage',
    description: 'Manage Clawdia calendar events directly without using shell_exec. Use this for reminders and local calendar scheduling. Actions: add, list, get, update, delete. Always confirm with the user before deleting events.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'get', 'update', 'delete'], description: 'Calendar action to perform' },
        id: { type: 'string', description: 'Event ID for get/update/delete' },
        title: { type: 'string', description: 'Event title for add/update' },
        date: { type: 'string', description: 'Event date in YYYY-MM-DD' },
        time: { type: 'string', description: 'Optional start time in HH:MM' },
        duration: { type: 'number', description: 'Optional duration in minutes' },
        notes: { type: 'string', description: 'Optional notes' },
        from: { type: 'string', description: 'Range start date in YYYY-MM-DD for list' },
        to: { type: 'string', description: 'Range end date in YYYY-MM-DD for list' },
      },
      required: ['action'],
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
  {
    name: 'fs_quote_lookup',
    description: 'Search local text-like files and PDFs under a root directory for a sentence, quote, or phrase. Returns ranked file matches with snippets and confidence. Use when you need to find which file contains a given sentence or fragment.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Sentence, quote fragment, or phrase to find' },
        rootPath: { type: 'string', description: 'Absolute directory path to search under' },
        maxResults: { type: 'number', description: 'Maximum ranked results to return (default 5, max 10)' },
        maxFiles: { type: 'number', description: 'Maximum candidate files to scan (default 300, max 1500)' },
      },
      required: ['query', 'rootPath'],
    },
  },
  {
    name: 'fs_folder_summary',
    description: 'Summarize a local folder quickly: file counts, dominant file types, largest files, busiest subdirectories, and recent activity. Use before planning reorganizations or when the user wants to understand a directory without dumping a raw tree.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute directory path to summarize' },
        depth: { type: 'number', description: 'Maximum traversal depth (default 2, max 6)' },
        maxEntries: { type: 'number', description: 'Maximum entries to inspect before capping traversal (default 500, max 5000)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'fs_reorg_plan',
    description: 'Create a planning-only folder reorganization proposal. Returns proposed category folders and explicit source-to-destination moves without changing any files. Use when the user wants to clean up, sort, or reorganize a directory safely before applying changes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute directory path to analyze and plan' },
        depth: { type: 'number', description: 'Maximum traversal depth (default 3, max 6)' },
        maxEntries: { type: 'number', description: 'Maximum entries to inspect before capping traversal (default 1000, max 10000)' },
        maxMoves: { type: 'number', description: 'Maximum proposed moves to return (default 40, max 200)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'fs_duplicate_scan',
    description: 'Scan a local folder for exact duplicate files using size and content hashes. Returns duplicate groups, keep candidates, and reclaimable bytes without deleting anything. Use before cleanup or archive decisions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute directory path to scan' },
        depth: { type: 'number', description: 'Maximum traversal depth (default 4, max 8)' },
        maxEntries: { type: 'number', description: 'Maximum entries to inspect before capping traversal (default 2000, max 20000)' },
        maxGroups: { type: 'number', description: 'Maximum duplicate groups to return (default 20, max 100)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'fs_apply_plan',
    description: 'Apply a reviewed filesystem move plan. Moves files from explicit source paths to explicit destination paths with overwrite protection by default. Use only after the user has reviewed and approved a concrete plan.',
    input_schema: {
      type: 'object' as const,
      properties: {
        moves: {
          type: 'array',
          description: 'Explicit move operations to apply',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string', description: 'Absolute source file path' },
              destination: { type: 'string', description: 'Absolute destination file path' },
            },
            required: ['source', 'destination'],
          },
        },
        overwrite: { type: 'boolean', description: 'Whether to replace destination files if they already exist (default false)' },
        createDirectories: { type: 'boolean', description: 'Whether to create destination directories automatically (default true)' },
      },
      required: ['moves'],
    },
  },
];

const BROWSER_TOOLS: NormalizedToolDefinition[] = [
  { name: 'browser_search', description: 'Web search via Google. Returns top 5 results.', input_schema: { type: 'object' as const, properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] } },
  { name: 'browser_navigate', description: 'Navigate to URL. Returns title, URL, visible text, AND a numbered list of interactive elements (buttons, links, inputs) with their types, labels, and aria attributes. Use element indices from this list for precise clicking.', input_schema: { type: 'object' as const, properties: { url: { type: 'string', description: 'URL' } }, required: ['url'] } },
  { name: 'browser_read_page', description: 'Re-read current page text + interactive elements. Use after SPA navigation or dynamic content changes. Returns the same format as browser_navigate (text + element list).', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'browser_click', description: 'Click element by index number (from element list), CSS selector, or visible text match. Returns click confirmation + updated interactive elements. Use index for precision: browser_click("3") clicks element [3]. Use CSS selector for specifics: browser_click("[aria-label=Compose]"). Use text for simple cases: browser_click("Submit").', input_schema: { type: 'object' as const, properties: { target: { type: 'string', description: 'Element index number, CSS selector, or text to match' } }, required: ['target'] } },
  { name: 'browser_type', description: 'Type text into input field.', input_schema: { type: 'object' as const, properties: { text: { type: 'string', description: 'Text to type' }, selector: { type: 'string', description: 'Optional CSS selector' } }, required: ['text'] } },
  { name: 'browser_extract', description: 'Extract targeted structured data from the current page. For commerce pages, this now returns typed structured extraction for listings, product details, pricing, ratings, review counts, delivery, seller, and similar product links before falling back to generic extraction.', input_schema: { type: 'object' as const, properties: { instruction: { type: 'string', description: 'What to extract — be specific (e.g. "pricing table", "product details", "reviews summary", "navigation links")' } }, required: ['instruction'] } },
  { name: 'browser_extract_listings', description: 'Extract structured candidate listings from the current results page. Returns bounded JSON-like listing objects with title, URL, price, rating, review count, delivery info, and seller when available.', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'browser_extract_product_details', description: 'Extract structured product-detail data from the current page. Returns title, URL, price, rating, review count, delivery info, seller, ships-from info, key bullets, and selected product links.', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'browser_extract_reviews_summary', description: 'Extract a bounded structured review summary from the current page. Returns rating, review count, highlights, and a compact histogram when present.', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'browser_screenshot', description: 'Screenshot browser viewport.', input_schema: { type: 'object' as const, properties: {} } },
  {
    name: 'browser_eval',
    description: 'Evaluate a bounded JavaScript expression in the current tab via the Electron debugger runtime. Returns structured JSON-safe output, current URL, type, and truncation state. Use for targeted reads or simple page-side computation, not for dumping huge objects.',
    input_schema: {
      type: 'object' as const,
      properties: {
        expression: { type: 'string', description: 'JavaScript expression to evaluate in the page context' },
        timeout_ms: { type: 'number', description: 'Execution timeout in milliseconds (default 5000, max 15000)' },
        await_promise: { type: 'boolean', description: 'Whether to await promise results (default true)' },
        max_result_chars: { type: 'number', description: 'Maximum serialized result size before truncation (default 6000, max 20000)' },
        frame_id: { type: 'string', description: 'Optional frame ID to target. Use a frame ID returned by browser_dom_snapshot when the data lives inside an iframe.' },
      },
      required: ['expression'],
    },
  },
  {
    name: 'browser_dom_snapshot',
    description: 'Return a bounded structured snapshot of the current page: URL, title, visible text summary, interactive elements with indices, form summary, and frame summary. Use this when you need a semantic page snapshot instead of a raw screenshot or full text dump.',
    input_schema: {
      type: 'object' as const,
      properties: {
        frame_id: { type: 'string', description: 'Optional frame ID to snapshot instead of the top document. Use a frame ID from a prior snapshot.' },
      },
      required: [],
    },
  },
  {
    name: 'browser_page_state',
    description: 'Return the current lightweight page-state model: URL, title, page type, visible interactive elements, extracted entities, recent extraction results, recent network activity, and the last action result.',
    input_schema: {
      type: 'object' as const,
      properties: {
        frame_id: { type: 'string', description: 'Optional frame ID to inspect instead of the top document.' },
      },
      required: [],
    },
  },
  {
    name: 'browser_network_watch',
    description: 'Start, read, or stop recent network activity tracking for the current tab using the Electron debugger Network domain. Returns a bounded rolling buffer of recent requests and responses.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['start', 'read', 'stop'], description: 'Whether to start tracking, read current activity, or stop tracking and return the buffer.' },
        limit: { type: 'number', description: 'Maximum buffered entries to keep/return (default 50, max 500)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_wait',
    description: 'Wait explicitly for selector, text, URL, or page readiness. Use this instead of implicit settle guesses when a flow depends on a specific page state transition.',
    input_schema: {
      type: 'object' as const,
      properties: {
        kind: { type: 'string', enum: ['selector', 'text', 'url', 'ready'], description: 'What condition to wait for.' },
        selector: { type: 'string', description: 'Selector to wait for when kind=selector.' },
        text: { type: 'string', description: 'Text to wait for when kind=text.' },
        url: { type: 'string', description: 'URL fragment, exact URL, or regex pattern to wait for when kind=url.' },
        match: { type: 'string', enum: ['includes', 'equals', 'regex'], description: 'URL match mode when kind=url (default includes).' },
        timeout_ms: { type: 'number', description: 'Max wait time in milliseconds.' },
        settle_ms: { type: 'number', description: 'Optional post-condition settle delay.' },
      },
      required: ['kind'],
    },
  },
  {
    name: 'browser_batch',
    description: 'Execute a bounded sequence of browser actions in one call. Supports sequential steps, stop-on-failure semantics, per-step summaries, and optional explicit waits between actions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        steps: {
          type: 'array',
          description: 'Ordered browser steps to execute.',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', enum: ['navigate', 'click', 'type', 'extract', 'extract_listings', 'extract_product_details', 'extract_reviews_summary', 'read_page', 'scroll', 'wait'] },
              input: { type: 'object', description: 'Arguments for the step tool.' },
            },
            required: ['tool'],
          },
        },
      },
      required: ['steps'],
    },
  },
  {
    name: 'browser_compare_products',
    description: 'Compare a bounded set of product URLs using structured product-detail extraction. Returns a compact comparison table for repeated commerce evaluation flows.',
    input_schema: {
      type: 'object' as const,
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to five product URLs to compare.',
        },
      },
      required: ['urls'],
    },
  },
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
  {
    name: 'browser_focus_field',
    description: 'Explicitly focus a form field by CSS selector, scrolling it into view first. Use before browser_type when you need to guarantee the correct field is active. Returns focus confirmation or error. More reliable than clicking for form fields.',
    input_schema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'CSS selector of the field to focus (e.g. "#email", "input[name=username]", "[aria-label=Search]")' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_detect_form',
    description: 'Detect forms on the current page and return their structure with stable CSS selectors for each field. Use before filling complex forms — returns field names, types, placeholders, and reliable selectors (by id/name/aria-label) instead of fragile element indices. Also returns the submit button selector.',
    input_schema: {
      type: 'object' as const,
      properties: {
        instruction: { type: 'string', description: 'Optional hint to match a specific form (e.g. "login", "search", "signup"). Leave empty to detect all forms.' },
      },
      required: [],
    },
  },
  {
    name: 'browser_fill_field',
    description: 'Fill a single form field using native browser input events. This is the most reliable way to type into React inputs, Web Components, rich text editors, and contenteditable divs. Automatically handles scrolling into view, focusing, clearing existing text, typing, and verification. Prefer this over browser_click + browser_type for form filling.',
    input_schema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'CSS selector for the field (e.g. "input[name=email]", "[aria-label=Title]", "div[name=body]"). For Web Components, use the outer element selector — shadow DOM drilling is automatic.' },
        text: { type: 'string', description: 'Text to type into the field' },
      },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'browser_run_harness',
    description: 'Execute a stored site harness for deterministic, zero-cost form filling. Harnesses are pre-compiled form definitions with exact CSS selectors for each field. They execute via native browser input without any LLM calls. Check the dynamic prompt for available harnesses on the current site. If no harness exists, use browser_detect_form + browser_fill_field to fill the form manually, then call browser_register_harness to save it for next time.',
    input_schema: {
      type: 'object' as const,
      properties: {
        domain: { type: 'string', description: 'Domain of the site (e.g. "reddit.com", "github.com")' },
        action: { type: 'string', description: 'Action name of the harness (e.g. "create-post", "create-issue")' },
        fields: { type: 'object', description: 'Map of field name to value (e.g. {"title": "My post", "body": "Hello world"})' },
        submit: { type: 'boolean', description: 'Whether to click the submit button after filling (default: false)' },
      },
      required: ['domain', 'action', 'fields'],
    },
  },
  {
    name: 'browser_register_harness',
    description: 'Register a new site harness after successfully filling a form. This saves the form structure (field selectors, types, submit button) so that next time the same form can be filled deterministically via browser_run_harness with zero LLM cost. Call this after you\'ve successfully filled and submitted a form using browser_detect_form + browser_fill_field.',
    input_schema: {
      type: 'object' as const,
      properties: {
        harness: {
          type: 'object',
          description: 'The harness definition',
          properties: {
            domain: { type: 'string', description: 'Domain (e.g. "reddit.com")' },
            actionName: { type: 'string', description: 'Action name (e.g. "create-post")' },
            urlPattern: { type: 'string', description: 'URL pattern with {param} placeholders (e.g. "https://reddit.com/r/{subreddit}/submit")' },
            fields: {
              type: 'array',
              description: 'Ordered list of form fields',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  selector: { type: 'string' },
                  fieldType: { type: 'string', description: 'input | textarea | contenteditable | shadow-input | shadow-textarea' },
                  required: { type: 'boolean' },
                },
              },
            },
            submit: {
              type: 'object',
              properties: {
                selector: { type: 'string' },
                text: { type: 'string' },
              },
            },
            verify: {
              type: 'object',
              properties: {
                successUrlPattern: { type: 'string' },
                errorSelector: { type: 'string' },
              },
            },
          },
        },
      },
      required: ['harness'],
    },
  },
  {
    name: 'browser_tab_new',
    description: 'Open a new browser tab, optionally navigating to a URL. Returns the new tab ID. Use for parallel browsing in agent swarms — each agent works in its own tab.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Optional URL to load in the new tab' },
      },
      required: [],
    },
  },
  {
    name: 'browser_tab_switch',
    description: 'Switch the active browser tab by ID. Use browser_tab_list to get IDs.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Tab ID to switch to' },
      },
      required: ['id'],
    },
  },
  {
    name: 'browser_tab_close',
    description: 'Close a browser tab by ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Tab ID to close' },
      },
      required: ['id'],
    },
  },
  {
    name: 'browser_tab_list',
    description: 'List all open browser tabs with their IDs, titles, URLs, and which is active.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'browser_run_playbook',
    description: 'Replay a saved browser playbook by ID. Use when the prompt context already identified a matching Bloodhound executor and you want to reuse that validated route instead of rediscovering the navigation path with primitive browser actions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        playbook_id: { type: 'number', description: 'Saved browser playbook ID from prompt context or planner output' },
      },
      required: ['playbook_id'],
    },
  },
];

const EXTRA_TOOLS: NormalizedToolDefinition[] = [
  {
    name: 'create_document',
    description: 'Create document (docx, pdf, xlsx, csv, md, html, json, txt).',
    input_schema: {
      type: 'object' as const,
      properties: {
        filename: { type: 'string' },
        format: { type: 'string', enum: ['docx', 'pdf', 'xlsx', 'csv', 'md', 'html', 'json', 'txt'] },
        content: { type: 'string' },
        structured_data: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
          },
        },
      },
      required: ['filename', 'format'],
    },
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
    description: 'GUI automation for DESKTOP applications. NEVER use for the browser. PREFER structured accessibility (a11y_*) actions for menus, buttons, dialogs, text fields — they use semantic element identity instead of coordinates. Use a11y_get_tree to inspect an app\'s UI structure, a11y_find to locate elements by role+name, a11y_do_action to click/activate buttons and menu items, a11y_set_value to type into text fields and spin buttons, a11y_get_state to read back values. Scope with "scope" param to target a specific dialog (e.g. scope="Scale Image"). Fall back to raw primitives (click/type/key) or macros (open_menu_path, fill_dialog, export_file, click_and_type) only when a11y is unavailable or the task requires canvas/pixel interaction. Primitives: batch_actions, click, type, key, wait, focus, screenshot, analyze_screenshot, verify_window_title, verify_file_exists, list_windows, find_window. Macros: launch_and_focus, open_menu_path, fill_dialog, confirm_dialog, export_file, click_and_type.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['batch_actions', 'screenshot_and_focus', 'analyze_screenshot', 'click', 'type', 'key', 'screenshot', 'find_window', 'focus', 'list_windows', 'wait', 'verify_window_title', 'verify_file_exists', 'screenshot_region', 'launch_and_focus', 'open_menu_path', 'fill_dialog', 'confirm_dialog', 'export_file', 'click_and_type', 'a11y_get_tree', 'a11y_find', 'a11y_do_action', 'a11y_set_value', 'a11y_get_state', 'a11y_list_apps'] },
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
        scope: { type: 'string', description: 'For a11y_* actions: dialog/window name to scope search into (e.g. "Scale Image", "Export Image")' },
        a11y_action: { type: 'string', enum: ['click', 'activate', 'press', 'toggle'], description: 'For a11y_do_action: semantic action to perform' },
        role: { type: 'string', description: 'For a11y_* actions: accessibility role (e.g. "push button", "spin button", "menu item", "text")' },
        name: { type: 'string', description: 'For a11y_* actions: accessible element name (e.g. "OK", "Width", "File")' },
        value: { type: 'string', description: 'For a11y_set_value: value to set on the element' },
        depth: { type: 'number', description: 'For a11y_get_tree: max tree depth (default 6)' },
        rx: { type: 'number' }, ry: { type: 'number' }, rw: { type: 'number' }, rh: { type: 'number' },
        actions: { type: 'array', description: 'For batch_actions. Max 20 steps.', items: { type: 'object', properties: { action: { type: 'string', enum: ['click', 'type', 'key', 'focus', 'screenshot', 'wait', 'verify_window_title', 'verify_file_exists'] }, window: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, text: { type: 'string' }, path: { type: 'string' }, delay: { type: 'number' }, ms: { type: 'number' } }, required: ['action'] } },
      },
      required: ['action'],
    },
  },
  {
    name: 'agent_spawn',
    description: 'Spawn a swarm of specialized sub-agents to work on tasks in parallel. Use when a task can be broken into independent parallel workstreams. Each agent gets a role (scout, builder, analyst, writer, reviewer, data, devops, security, synthesizer) and a focused goal. All agents run simultaneously and their results are returned together. Use this to dramatically speed up research, code audits, content generation, and data pipelines.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tasks: {
          type: 'array',
          description: 'List of parallel tasks to spawn agents for. Max 20.',
          items: {
            type: 'object',
            properties: {
              role: {
                type: 'string',
                enum: ['scout', 'builder', 'analyst', 'writer', 'reviewer', 'data', 'devops', 'security', 'synthesizer', 'general'],
                description: 'The agent role — determines tool access and model tier',
              },
              goal: {
                type: 'string',
                description: 'The focused goal for this agent. Be specific and self-contained.',
              },
              context: {
                type: 'string',
                description: 'Optional extra context to pass to this agent from the coordinator',
              },
            },
            required: ['role', 'goal'],
          },
        },
      },
      required: ['tasks'],
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

export function getToolsForGroup(group: ToolGroup): NormalizedToolDefinition[] {
  switch (group) {
    case 'core': return [...CORE_TOOLS, ...EXTRA_TOOLS.filter(t => t.name === 'agent_spawn')];
    case 'browser': return [...BROWSER_TOOLS];
    case 'full': return [...CORE_TOOLS, ...BROWSER_TOOLS, ...EXTRA_TOOLS];
  }
}

/**
 * Filter tools by removing disallowed tool names.
 * Used by the routing layer to constrain what the LLM can call.
 */
export function filterTools(tools: NormalizedToolDefinition[], disallowed: string[]): NormalizedToolDefinition[] {
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
  calendar_manage: executeCalendarManage,
  file_read: executeFileRead,
  file_write: executeFileWrite,
  file_edit: executeFileEdit,
  directory_tree: executeDirectoryTree,
  fs_quote_lookup: executeFsQuoteLookup,
  fs_folder_summary: executeFsFolderSummary,
  fs_reorg_plan: executeFsReorgPlan,
  fs_duplicate_scan: executeFsDuplicateScan,
  fs_apply_plan: executeFsApplyPlan,
  browser_search: executeBrowserSearch,
  browser_navigate: executeBrowserNavigate,
  browser_read_page: executeBrowserReadPage,
  browser_click: executeBrowserClick,
  browser_type: executeBrowserType,
  browser_extract: executeBrowserExtract,
  browser_extract_listings: executeBrowserExtractListings,
  browser_extract_product_details: executeBrowserExtractProductDetails,
  browser_extract_reviews_summary: executeBrowserExtractReviewsSummary,
  browser_screenshot: executeBrowserScreenshot,
  browser_eval: executeBrowserEval,
  browser_dom_snapshot: executeBrowserDomSnapshot,
  browser_page_state: executeBrowserPageState,
  browser_network_watch: executeBrowserNetworkWatch,
  browser_wait: executeBrowserWait,
  browser_batch: executeBrowserBatch,
  browser_compare_products: executeBrowserCompareProducts,
  browser_scroll:     executeBrowserScroll,
  browser_focus_field: executeBrowserFocusField,
  browser_detect_form: executeBrowserDetectForm,
  browser_fill_field:  executeBrowserFillField,
  browser_run_harness: executeBrowserRunHarness,
  browser_register_harness: executeBrowserRegisterHarness,
  browser_tab_new:    executeBrowserTabNew,
  browser_tab_switch: executeBrowserTabSwitch,
  browser_tab_close:  executeBrowserTabClose,
  browser_tab_list:   executeBrowserTabList,
  browser_run_playbook: async (input) => {
    const playbookId = Number(input.playbook_id);
    if (!Number.isFinite(playbookId) || playbookId <= 0) {
      return '[Error] browser_run_playbook requires a positive numeric playbook_id';
    }
    const target = (typeof input.__runId === 'string' || typeof input.tabId === 'string')
      ? {
          runId: typeof input.__runId === 'string' ? input.__runId : undefined,
          tabId: typeof input.tabId === 'string' ? input.tabId : undefined,
        }
      : undefined;
    const result = await executeSavedBloodhoundPlaybookById(playbookId, { target });
    if (!result) return `[Error] No saved Bloodhound playbook found for ID ${playbookId}`;
    return result.response;
  },
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
