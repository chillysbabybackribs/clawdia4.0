/**
 * Shortcut Registry — App-specific keyboard shortcuts.
 *
 * Provides known shortcuts to the LLM via the dynamic prompt so it can
 * use keyboard shortcuts instead of menu clicks. Also used by playbooks
 * (Phase 3) for macro expansion.
 *
 * Keys use xdotool format: ctrl+n, ctrl+shift+e, alt+F4, Return, etc.
 */

// ═══════════════════════════════════
// Types
// ═══════════════════════════════════

export interface AppShortcuts {
  app: string;
  displayName: string;
  shortcuts: Record<string, string>;  // intent → xdotool key combo
}

// ═══════════════════════════════════
// Registry
// ═══════════════════════════════════

const SHORTCUT_REGISTRY: Record<string, AppShortcuts> = {
  gimp: {
    app: 'gimp',
    displayName: 'GIMP',
    shortcuts: {
      // File operations
      'new_image':     'ctrl+n',
      'open_file':     'ctrl+o',
      'save':          'ctrl+s',
      'save_as':       'ctrl+shift+s',
      'export_as':     'ctrl+shift+e',
      'overwrite':     'ctrl+e',
      'close':         'ctrl+w',
      'quit':          'ctrl+q',

      // Edit
      'undo':          'ctrl+z',
      'redo':          'ctrl+y',
      'copy':          'ctrl+c',
      'paste':         'ctrl+v',
      'paste_as_new':  'ctrl+shift+v',
      'select_all':    'ctrl+a',
      'select_none':   'ctrl+shift+a',

      // Tools
      'text_tool':     't',
      'move_tool':     'm',
      'paintbrush':    'p',
      'pencil':        'n',
      'eraser':        'shift+e',
      'bucket_fill':   'shift+b',
      'gradient':      'g',
      'color_picker':  'o',
      'crop_tool':     'shift+c',
      'scale_tool':    'shift+t',
      'rectangle_select': 'r',
      'ellipse_select':   'e',
      'free_select':      'f',
      'fuzzy_select':     'u',
      'paths_tool':       'b',
      'clone_tool':       'c',
      'measure_tool':     'shift+m',

      // View
      'zoom_fit':      'shift+ctrl+j',
      'zoom_100':      '1',
      'zoom_in':       'plus',
      'zoom_out':      'minus',
      'fullscreen':    'F11',

      // Image
      'flatten_image': 'alt+i f',
      'canvas_size':   'alt+i v',
      'scale_image':   'alt+i l',

      // Layers
      'new_layer':     'ctrl+shift+n',
      'merge_down':    'ctrl+shift+m',

      // Filters menu
      'repeat_filter': 'ctrl+f',

      // Dialogs
      'confirm_dialog':  'Return',
      'cancel_dialog':   'Escape',
      'tab_next_field':  'Tab',
    },
  },

  libreoffice: {
    app: 'libreoffice',
    displayName: 'LibreOffice',
    shortcuts: {
      // File
      'new':           'ctrl+n',
      'open':          'ctrl+o',
      'save':          'ctrl+s',
      'save_as':       'ctrl+shift+s',
      'close':         'ctrl+w',
      'quit':          'ctrl+q',
      'print':         'ctrl+p',
      'export_pdf':    'ctrl+shift+s',  // then select PDF in dialog

      // Edit
      'undo':          'ctrl+z',
      'redo':          'ctrl+y',
      'copy':          'ctrl+c',
      'paste':         'ctrl+v',
      'cut':           'ctrl+x',
      'select_all':    'ctrl+a',
      'find_replace':  'ctrl+h',
      'find':          'ctrl+f',

      // Format (Writer)
      'bold':          'ctrl+b',
      'italic':        'ctrl+i',
      'underline':     'ctrl+u',
      'align_left':    'ctrl+l',
      'align_center':  'ctrl+e',
      'align_right':   'ctrl+r',
      'font_size_up':  'ctrl+bracketright',
      'font_size_down':'ctrl+bracketleft',

      // Navigation
      'go_to_start':   'ctrl+Home',
      'go_to_end':     'ctrl+End',
      'page_down':     'Page_Down',
      'page_up':       'Page_Up',

      // Dialogs
      'confirm_dialog':  'Return',
      'cancel_dialog':   'Escape',
      'tab_next_field':  'Tab',
    },
  },

  blender: {
    app: 'blender',
    displayName: 'Blender',
    shortcuts: {
      'new':           'ctrl+n',
      'open':          'ctrl+o',
      'save':          'ctrl+s',
      'save_as':       'ctrl+shift+s',
      'undo':          'ctrl+z',
      'redo':          'ctrl+shift+z',
      'render':        'F12',
      'render_animation': 'ctrl+F12',
      'quit':          'ctrl+q',
      'search':        'F3',
      'delete':        'x',
      'grab_move':     'g',
      'rotate':        'r',
      'scale':         's',
      'confirm_dialog':  'Return',
      'cancel_dialog':   'Escape',
    },
  },

  inkscape: {
    app: 'inkscape',
    displayName: 'Inkscape',
    shortcuts: {
      'new':           'ctrl+n',
      'open':          'ctrl+o',
      'save':          'ctrl+s',
      'save_as':       'ctrl+shift+s',
      'export_png':    'ctrl+shift+e',
      'undo':          'ctrl+z',
      'redo':          'ctrl+shift+z',
      'copy':          'ctrl+c',
      'paste':         'ctrl+v',
      'select_all':    'ctrl+a',
      'group':         'ctrl+g',
      'ungroup':       'ctrl+shift+g',
      'raise':         'Page_Up',
      'lower':         'Page_Down',
      'zoom_fit':      '3',
      'zoom_100':      '1',
      'text_tool':     't',
      'rectangle_tool':'r',
      'ellipse_tool':  'e',
      'pen_tool':      'b',
      'node_tool':     'n',
      'quit':          'ctrl+q',
      'confirm_dialog':  'Return',
      'cancel_dialog':   'Escape',
    },
  },

  // Universal shortcuts that work in most apps
  _universal: {
    app: '_universal',
    displayName: 'Universal',
    shortcuts: {
      'undo':            'ctrl+z',
      'redo':            'ctrl+y',
      'copy':            'ctrl+c',
      'paste':           'ctrl+v',
      'cut':             'ctrl+x',
      'select_all':      'ctrl+a',
      'save':            'ctrl+s',
      'close':           'ctrl+w',
      'quit':            'ctrl+q',
      'fullscreen':      'F11',
      'confirm_dialog':  'Return',
      'cancel_dialog':   'Escape',
      'tab_next_field':  'Tab',
      'tab_prev_field':  'shift+Tab',
      'context_menu':    'shift+F10',
    },
  },
};

// ═══════════════════════════════════
// Public API
// ═══════════════════════════════════

/**
 * Get shortcuts for a specific app. Returns app-specific shortcuts
 * merged with universal fallbacks (app-specific takes priority).
 */
export function getShortcuts(app: string): AppShortcuts | null {
  const appMap = SHORTCUT_REGISTRY[app.toLowerCase()];
  if (!appMap) return null;

  // Merge with universal (app-specific wins on conflict)
  const universal = SHORTCUT_REGISTRY._universal;
  return {
    ...appMap,
    shortcuts: { ...universal.shortcuts, ...appMap.shortcuts },
  };
}

/**
 * Resolve an intent to a keyboard shortcut for the given app.
 * Returns the xdotool key combo, or null if unknown.
 */
export function resolveShortcut(app: string, intent: string): string | null {
  const appMap = SHORTCUT_REGISTRY[app.toLowerCase()];
  if (appMap?.shortcuts[intent]) return appMap.shortcuts[intent];

  const universal = SHORTCUT_REGISTRY._universal;
  return universal.shortcuts[intent] || null;
}

/**
 * Get a compact shortcut reference for injection into the dynamic prompt.
 * Only includes the most commonly needed shortcuts to save tokens.
 */
export function getShortcutPromptBlock(app: string): string {
  const shortcuts = getShortcuts(app);
  if (!shortcuts) return '';

  // Select the most useful shortcuts (not all of them)
  const PRIORITY_INTENTS = [
    'new_image', 'new', 'open_file', 'open', 'save', 'save_as',
    'export_as', 'export_png', 'export_pdf',
    'undo', 'redo', 'copy', 'paste', 'select_all',
    'text_tool', 'confirm_dialog', 'cancel_dialog', 'tab_next_field',
    'close', 'quit',
  ];

  const entries: string[] = [];
  for (const intent of PRIORITY_INTENTS) {
    if (shortcuts.shortcuts[intent]) {
      entries.push(`${intent}: ${shortcuts.shortcuts[intent]}`);
    }
  }

  if (entries.length === 0) return '';

  return `[Keyboard shortcuts for ${shortcuts.displayName}]\n${entries.join(' | ')}`;
}

/**
 * List all apps that have registered shortcuts.
 */
export function listRegisteredApps(): string[] {
  return Object.keys(SHORTCUT_REGISTRY).filter(k => k !== '_universal');
}
