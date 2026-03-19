interface ClawdiaAPI {
  chat: {
    send: (message: string, images?: any[]) => Promise<any>;
    stop: () => Promise<any>;
    new: () => Promise<any>;
    list: () => Promise<any>;
    load: (id: string) => Promise<any>;
    delete: (id: string) => Promise<any>;
    onStreamText: (cb: (text: string) => void) => () => void;
    onStreamEnd: (cb: (data: any) => void) => () => void;
    onThinking: (cb: (thought: string) => void) => () => void;
    onToolActivity: (cb: (activity: any) => void) => () => void;
  };
  browser: {
    navigate: (url: string) => Promise<any>;
    back: () => Promise<any>;
    forward: () => Promise<any>;
    refresh: () => Promise<any>;
    setBounds: (bounds: any) => Promise<any>;
    onUrlChanged: (cb: (url: string) => void) => () => void;
    onTitleChanged: (cb: (title: string) => void) => () => void;
    onLoading: (cb: (loading: boolean) => void) => () => void;
  };
  settings: {
    get: (key: string) => Promise<any>;
    set: (key: string, value: any) => Promise<any>;
    getApiKey: () => Promise<string>;
    setApiKey: (key: string) => Promise<any>;
    getModel: () => Promise<string>;
    setModel: (model: string) => Promise<any>;
  };
  window: {
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    close: () => Promise<void>;
  };
}

interface Window {
  clawdia: ClawdiaAPI;
}
