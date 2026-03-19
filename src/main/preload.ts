import { contextBridge, ipcRenderer } from 'electron';

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
    send: (message: string, images?: any[]) => invoke('chat:send', message, images),
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
    newTab: (url?: string) => invoke('browser:tab:new', url),
    listTabs: () => invoke('browser:tab:list'),
    switchTab: (id: string) => invoke('browser:tab:switch', id),
    closeTab: (id: string) => invoke('browser:tab:close', id),
    matchHistory: (prefix: string) => invoke('browser:history-match', prefix),
    onUrlChanged: (cb: (url: string) => void) => on('browser:url-changed', cb),
    onTitleChanged: (cb: (title: string) => void) => on('browser:title-changed', cb),
    onLoading: (cb: (loading: boolean) => void) => on('browser:loading', cb),
    onTabsChanged: (cb: (tabs: any[]) => void) => on('browser:tabs-changed', cb),
  },
  settings: {
    get: (key: string) => invoke('settings:get', key),
    set: (key: string, value: any) => invoke('settings:set', key, value),
    getApiKey: () => invoke('api-key:get'),
    setApiKey: (key: string) => invoke('api-key:set', key),
    getModel: () => invoke('model:get'),
    setModel: (model: string) => invoke('model:set', model),
  },
  window: {
    minimize: () => invoke('window:minimize'),
    maximize: () => invoke('window:maximize'),
    close: () => invoke('window:close'),
  },
});
