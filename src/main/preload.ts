import { contextBridge, ipcRenderer } from 'electron';
import type { MessageAttachment } from '../shared/types';

function invoke<T = any>(channel: string, ...args: any[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args);
}

function on(channel: string, callback: (...args: any[]) => void): () => void {
  const handler = (_event: any, ...args: any[]) => callback(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('clawdia', {
  chat: {
    send: (message: string, attachments?: MessageAttachment[]) => invoke('chat:send', message, attachments),
    openAttachment: (filePath: string) => invoke('chat:open-attachment', filePath),
    stop: () => invoke('chat:stop'),
    pause: () => invoke('chat:pause'),
    resume: () => invoke('chat:resume'),
    addContext: (text: string) => invoke('chat:add-context', text),
    rateTool: (messageId: string, toolId: string, rating: 'up' | 'down' | null, note?: string) => invoke('chat:rate-tool', messageId, toolId, rating, note),
    new: () => invoke('chat:new'),
    list: () => invoke('chat:list'),
    load: (id: string) => invoke('chat:load', id),
    delete: (id: string) => invoke('chat:delete', id),
    onStreamText: (cb: (text: string) => void) => on('chat:stream:text', cb),
    onStreamEnd: (cb: (data: any) => void) => on('chat:stream:end', cb),
    onWorkflowPlanReset: (cb: () => void) => on('chat:workflow-plan:reset', cb),
    onWorkflowPlanText: (cb: (text: string) => void) => on('chat:workflow-plan:text', cb),
    onWorkflowPlanEnd: (cb: () => void) => on('chat:workflow-plan:end', cb),
    onThinking: (cb: (thought: string) => void) => on('chat:thinking', cb),
    onToolActivity: (cb: (activity: any) => void) => on('chat:tool-activity', cb),
    onToolStream: (cb: (payload: { toolId: string; toolName: string; chunk: string }) => void) => on('chat:tool-stream', cb),
  },
  browser: {
    navigate: (url: string) => invoke('browser:navigate', url),
    back: () => invoke('browser:back'),
    forward: () => invoke('browser:forward'),
    refresh: () => invoke('browser:refresh'),
    setBounds: (bounds: any) => invoke('browser:set-bounds', bounds),
    getExecutionMode: () => invoke('browser:get-execution-mode'),
    newTab: (url?: string) => invoke('browser:tab:new', url),
    listTabs: () => invoke('browser:tab:list'),
    switchTab: (id: string) => invoke('browser:tab:switch', id),
    closeTab: (id: string) => invoke('browser:tab:close', id),
    matchHistory: (prefix: string) => invoke('browser:history-match', prefix),
    hide: () => invoke('browser:hide'),
    show: () => invoke('browser:show'),
    listSessions: () => invoke('browser:list-sessions'),
    clearSession: (domain: string) => invoke('browser:clear-session', domain),
    onUrlChanged: (cb: (url: string) => void) => on('browser:url-changed', cb),
    onTitleChanged: (cb: (title: string) => void) => on('browser:title-changed', cb),
    onLoading: (cb: (loading: boolean) => void) => on('browser:loading', cb),
    onTabsChanged: (cb: (tabs: any[]) => void) => on('browser:tabs-changed', cb),
    onModeChanged: (cb: (payload: { mode: string; reason: string }) => void) => on('browser:mode-changed', cb),
  },
  settings: {
    get: (key: string) => invoke('settings:get', key),
    set: (key: string, value: any) => invoke('settings:set', key, value),
    getApiKey: (provider?: string) => invoke('api-key:get', provider),
    setApiKey: (provider: string, key: string) => invoke('api-key:set', provider, key),
    getModel: (provider?: string) => invoke('model:get', provider),
    setModel: (provider: string, model: string) => invoke('model:set', provider, model),
    getProvider: () => invoke('settings:get', 'selectedProvider'),
    setProvider: (provider: string) => invoke('settings:set', 'selectedProvider', provider),
    getProviderKeys: () => invoke('settings:get', 'providerKeys'),
    getUnrestrictedMode: () => invoke('settings:get', 'unrestrictedMode'),
    setUnrestrictedMode: (enabled: boolean) => invoke('settings:set', 'unrestrictedMode', enabled),
    getPolicyProfile: () => invoke('settings:get', 'policyProfile'),
    setPolicyProfile: (profileId: string) => invoke('settings:set', 'policyProfile', profileId),
    getPerformanceStance: () => invoke('settings:get', 'performanceStance'),
    setPerformanceStance: (stance: string) => invoke('settings:set', 'performanceStance', stance),
  },
  process: {
    list: () => invoke('process:list'),
    detach: () => invoke('process:detach'),
    attach: (processId: string) => invoke('process:attach', processId),
    cancel: (processId: string) => invoke('process:cancel', processId),
    dismiss: (processId: string) => invoke('process:dismiss', processId),
    onListChanged: (cb: (processes: any[]) => void) => on('process:list', cb),
  },
  run: {
    list: () => invoke('run:list'),
    get: (runId: string) => invoke('run:get', runId),
    events: (runId: string) => invoke('run:events', runId),
    artifacts: (runId: string) => invoke('run:artifacts', runId),
    changes: (runId: string) => invoke('run:changes', runId),
    approvals: (runId: string) => invoke('run:approvals', runId),
    humanInterventions: (runId: string) => invoke('run:human-interventions', runId),
    approve: (approvalId: number) => invoke('run:approve', approvalId),
    revise: (approvalId: number) => invoke('run:revise', approvalId),
    deny: (approvalId: number) => invoke('run:deny', approvalId),
    resolveHumanIntervention: (interventionId: number) => invoke('run:human-intervention:resolve', interventionId),
  },
  calendar: {
    list: (from?: string, to?: string) => invoke('calendar:list', from, to),
    onEventsChanged: (cb: (events: any[]) => void) => on('calendar:events-changed', cb),
  },
  swarm: {
    onStateChanged: (cb: (state: any) => void) => on('swarm:state-changed', cb),
  },
  identity: {
    getProfile: () => invoke('identity:profile:get'),
    setProfile: (input: any) => invoke('identity:profile:set', input),
    listAccounts: () => invoke('identity:accounts:list'),
    addAccount: (input: any) => invoke('identity:account:add', input),
    deleteAccount: (serviceName: string) => invoke('identity:account:delete', serviceName),
    listCredentials: () => invoke('identity:credentials:list'),
    addCredential: (label: string, type: string, service: string, valuePlain: string) =>
      invoke('identity:credential:add', label, type, service, valuePlain),
    deleteCredential: (label: string, service: string) =>
      invoke('identity:credential:delete', label, service),
    onAccountsChanged: (cb: () => void) => on('identity:accounts-changed', cb),
  },
  policy: {
    list: () => invoke('policy:list'),
  },
  window: {
    minimize: () => invoke('window:minimize'),
    maximize: () => invoke('window:maximize'),
    close: () => invoke('window:close'),
  },
  fs: {
    readDir: (dirPath: string) => invoke('fs:read-dir', dirPath),
    readFile: (filePath: string) => invoke('fs:read-file', filePath),
  },
  desktop: {
    listApps: () => invoke('desktop:list-apps'),
    focusApp: (windowId: string) => invoke('desktop:focus-app', windowId),
    killApp: (pid: number) => invoke('desktop:kill-app', pid),
  },
  wallet: {
    getPaymentMethods: () => invoke('wallet:get-payment-methods'),
    addManualCard: (input: any) => invoke('wallet:add-manual-card', input),
    importBrowserCards: () => invoke('wallet:import-browser-cards'),
    confirmImport: (candidates: any[]) => invoke('wallet:confirm-import', candidates),
    setPreferred: (id: number) => invoke('wallet:set-preferred', id),
    setBackup: (id: number) => invoke('wallet:set-backup', id),
    removeCard: (id: number) => invoke('wallet:remove-card', id),
    getBudgets: () => invoke('wallet:get-budgets'),
    setBudget: (input: any) => invoke('wallet:set-budget', input),
    disableBudget: (period: string) => invoke('wallet:disable-budget', period),
    getTransactions: (args?: { limit?: number }) => invoke('wallet:get-transactions', args),
    getRemainingBudgets: () => invoke('wallet:get-remaining-budgets'),
    onPurchaseComplete: (cb: (payload: any) => void) => on('spending:purchase-complete', cb),
    onLowBalance: (cb: (payload: any) => void) => on('spending:low-balance', cb),
    onBudgetExceeded: (cb: (payload: any) => void) => on('spending:budget-exceeded', cb),
  },
});
