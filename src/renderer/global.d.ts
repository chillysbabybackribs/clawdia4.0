import type { MessageAttachment } from '../shared/types';

declare global {
  interface ClawdiaAPI {
    chat: {
      send: (message: string, attachments?: MessageAttachment[]) => Promise<any>;
      openAttachment: (filePath: string) => Promise<any>;
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
      getExecutionMode: () => Promise<string>;
      onUrlChanged: (cb: (url: string) => void) => () => void;
      onTitleChanged: (cb: (title: string) => void) => () => void;
      onLoading: (cb: (loading: boolean) => void) => () => void;
      onModeChanged: (cb: (payload: { mode: string; reason: string }) => void) => () => void;
    };
    settings: {
      get: (key: string) => Promise<any>;
      set: (key: string, value: any) => Promise<any>;
      getApiKey: () => Promise<string>;
      setApiKey: (key: string) => Promise<any>;
      getModel: () => Promise<string>;
      setModel: (model: string) => Promise<any>;
      getUnrestrictedMode: () => Promise<boolean>;
      setUnrestrictedMode: (enabled: boolean) => Promise<any>;
      getPolicyProfile: () => Promise<string>;
      setPolicyProfile: (profileId: string) => Promise<any>;
      getPerformanceStance: () => Promise<'conservative' | 'standard' | 'aggressive'>;
      setPerformanceStance: (stance: 'conservative' | 'standard' | 'aggressive') => Promise<any>;
    };
    process: {
      list: () => Promise<any>;
      detach: () => Promise<any>;
      attach: (processId: string) => Promise<any>;
      cancel: (processId: string) => Promise<any>;
      dismiss: (processId: string) => Promise<any>;
      onListChanged: (cb: (processes: any[]) => void) => () => void;
    };
    run: {
      list: () => Promise<any>;
      get: (runId: string) => Promise<any>;
      events: (runId: string) => Promise<any>;
      changes: (runId: string) => Promise<any>;
      scorecard: () => Promise<any>;
      approvals: (runId: string) => Promise<any>;
      humanInterventions: (runId: string) => Promise<any>;
      approve: (approvalId: number) => Promise<any>;
      deny: (approvalId: number) => Promise<any>;
      resolveHumanIntervention: (interventionId: number) => Promise<any>;
    };
    swarm: {
      onStateChanged: (cb: (state: any) => void) => () => void;
    };
    policy: {
      list: () => Promise<any>;
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
}

export {};
