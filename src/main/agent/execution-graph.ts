import type { OutputContract } from './node-contracts';

export type GraphId = string;
export type NodeId = string;
export type EdgeId = string;

export type NodeKind =
  | 'planner'
  | 'worker'
  | 'merge'
  | 'verifier'
  | 'judge'
  | 'approval'
  | 'cleanup';

export type ExecutorKind =
  | 'llm_general'
  | 'browser_cdp'
  | 'app_cli_anything'
  | 'desktop_gui'
  | 'filesystem_core'
  | 'runtime_verifier';

export type EdgeKind =
  | 'serial'
  | 'parallel'
  | 'merge'
  | 'retry'
  | 'escalate'
  | 'approval_gate'
  | 'terminate';

export interface ExecutionGraph {
  id: GraphId;
  task: string;
  createdAt: string;
  budget: {
    maxNodes: number;
    maxParallel: number;
    maxToolCallsPerNode?: number;
    maxWallMs?: number;
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
  outputs: GraphOutputSpec[];
}

export interface GraphNode {
  id: NodeId;
  kind: NodeKind;
  label: string;
  objective: string;
  executor: ExecutorBinding;
  inputs: NodeInputBinding[];
  output: OutputContract;
  policy: NodePolicy;
  status?: 'pending' | 'ready' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled';
}

export interface GraphEdge {
  id: EdgeId;
  from: NodeId;
  to: NodeId;
  kind: EdgeKind;
  condition?: string;
}

export interface ExecutorBinding {
  kind: ExecutorKind;
  capabilities: string[];
  preferredSurface?: string;
  fallbackExecutors?: ExecutorKind[];
  toolScope: string[];
  contextScope: ContextScope;
  runtimeConfig?: Record<string, any>;
}

export interface ContextScope {
  inheritConversationHistory: boolean;
  inheritMemory: 'none' | 'read_only' | 'shared';
  browserScope?: {
    isolation: 'shared_session' | 'isolated_tab' | 'isolated_session';
    runIdBinding?: string;
    tabId?: string;
  };
  appScope?: {
    appId?: string;
    surface?: 'cli_anything' | 'dbus' | 'gui';
  };
  fileScope?: {
    roots: string[];
    writable: boolean;
  };
}

export interface NodeInputBinding {
  name: string;
  source: 'user_task' | 'planner' | 'node_output' | 'memory' | 'runtime_state';
  value?: any;
  fromNodeId?: NodeId;
  path?: string;
}

export interface NodePolicy {
  canSpawnChildren?: boolean;
  retryLimit: number;
  timeoutMs?: number;
  approvalRequired?: boolean;
  verifierNodeId?: string;
  judgeNodeId?: string;
}

export interface GraphOutputSpec {
  name: string;
  fromNodeId: NodeId;
  path?: string;
}

export interface PlannerOutput {
  summary: string;
  topology: {
    serialStages: number;
    parallelBranches: number;
  };
  graph: ExecutionGraph;
}

export function createGraphId(seed: string): GraphId {
  const normalized = seed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
  return `graph-${normalized}-${Date.now()}`;
}

export function createNodeId(label: string, index: number): NodeId {
  const normalized = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'node';
  return `${normalized}_${index}`;
}
