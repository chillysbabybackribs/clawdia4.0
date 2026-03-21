import type { ExecutorBinding, ExecutorKind } from './execution-graph';

function freeze<T>(value: T): T {
  return Object.freeze(value);
}

const EXECUTOR_REGISTRY: Record<ExecutorKind, ExecutorBinding> = {
  llm_general: freeze({
    kind: 'llm_general',
    capabilities: ['reasoning', 'planning', 'synthesis'],
    toolScope: [],
    contextScope: {
      inheritConversationHistory: true,
      inheritMemory: 'read_only',
    },
  }),
  browser_cdp: freeze({
    kind: 'browser_cdp',
    capabilities: ['navigate', 'dom_snapshot', 'network_watch', 'structured_extract', 'page_state', 'compare_products'],
    preferredSurface: 'browser_cdp',
    fallbackExecutors: ['desktop_gui'],
    toolScope: [
      'browser_navigate',
      'browser_read_page',
      'browser_extract',
      'browser_extract_listings',
      'browser_extract_product_details',
      'browser_extract_reviews_summary',
      'browser_page_state',
      'browser_wait',
      'browser_batch',
      'browser_compare_products',
      'browser_network_watch',
      'browser_dom_snapshot',
    ],
    contextScope: {
      inheritConversationHistory: false,
      inheritMemory: 'read_only',
      browserScope: {
        isolation: 'isolated_tab',
        runIdBinding: 'node.runId',
      },
    },
    runtimeConfig: {
      maxTabsPerGraph: 4,
      allowRawEval: false,
    },
  }),
  app_cli_anything: freeze({
    kind: 'app_cli_anything',
    capabilities: ['app_control', 'structured_app_actions', 'export', 'query_app_state'],
    preferredSurface: 'cli_anything',
    fallbackExecutors: ['desktop_gui'],
    toolScope: ['app_control', 'dbus_control', 'gui_interact', 'file_read', 'file_write'],
    contextScope: {
      inheritConversationHistory: false,
      inheritMemory: 'read_only',
      appScope: {
        surface: 'cli_anything',
      },
      fileScope: {
        roots: ['project_root', 'output_dir'],
        writable: true,
      },
    },
    runtimeConfig: {
      requireHarnessIfAvailable: true,
      fallbackToGuiOnMiss: true,
    },
  }),
  desktop_gui: freeze({
    kind: 'desktop_gui',
    capabilities: ['gui_actions', 'window_focus', 'ocr_verification'],
    preferredSurface: 'gui',
    toolScope: ['gui_interact', 'app_control'],
    contextScope: {
      inheritConversationHistory: false,
      inheritMemory: 'read_only',
      appScope: {
        surface: 'gui',
      },
    },
  }),
  filesystem_core: freeze({
    kind: 'filesystem_core',
    capabilities: ['read_files', 'write_files', 'edit_files', 'shell'],
    preferredSurface: 'filesystem',
    toolScope: [
      'file_read',
      'file_write',
      'file_edit',
      'directory_tree',
      'fs_quote_lookup',
      'fs_folder_summary',
      'fs_reorg_plan',
      'fs_duplicate_scan',
      'fs_apply_plan',
      'shell_exec',
    ],
    contextScope: {
      inheritConversationHistory: false,
      inheritMemory: 'read_only',
      fileScope: {
        roots: ['project_root'],
        writable: true,
      },
    },
  }),
  runtime_verifier: freeze({
    kind: 'runtime_verifier',
    capabilities: ['tool_verification', 'artifact_validation', 'judge_output'],
    preferredSurface: 'runtime_verifier',
    toolScope: [],
    contextScope: {
      inheritConversationHistory: false,
      inheritMemory: 'none',
    },
  }),
};

export function getExecutorBinding(kind: ExecutorKind): ExecutorBinding {
  return EXECUTOR_REGISTRY[kind];
}

export function listExecutorBindings(): ExecutorBinding[] {
  return Object.values(EXECUTOR_REGISTRY);
}

export function resolveExecutorForCapabilities(capabilities: string[]): ExecutorKind | null {
  const wanted = new Set(capabilities);
  for (const binding of Object.values(EXECUTOR_REGISTRY)) {
    if ([...wanted].every((capability) => binding.capabilities.includes(capability))) {
      return binding.kind;
    }
  }
  return null;
}
