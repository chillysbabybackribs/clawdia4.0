import type { ProviderId } from './model-registry';

export interface MessageIteration {
  text: string;          // LLM narration for this iteration (may be '')
  toolCalls: ToolCall[]; // tool calls dispatched after this text (may be [])
}

// Flat append-only feed item — renderer-only, NOT persisted to DB
export type FeedItem =
  | { kind: 'tool'; tool: ToolCall }
  | { kind: 'text'; text: string; isStreaming?: boolean };

export interface MessageAttachment {
  id: string;
  kind: 'image' | 'file';
  name: string;
  size: number;
  mimeType: string;
  path?: string;
  dataUrl?: string;
  textContent?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  attachments?: MessageAttachment[];
  toolCalls?: ToolCall[];
  iterations?: MessageIteration[];   // legacy, kept for DB-loaded messages
  feed?: FeedItem[];                 // renderer-only — NOT persisted to DB
  isStreaming?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  status: 'running' | 'success' | 'error';
  detail?: string;
  durationMs?: number;
  rating?: 'up' | 'down' | null;
  ratingNote?: string;  // annotation for thumbs-down: "unnecessary step", "wrong target", etc.
}

export interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
  messageCount?: number;
}

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

export type AgentProfile =
  | 'general'
  | 'filesystem'
  | 'bloodhound'
  | 'ytdlp'
  // Swarm agent profiles
  | 'coordinator'
  | 'scout'
  | 'builder'
  | 'analyst'
  | 'writer'
  | 'reviewer'
  | 'data'
  | 'devops'
  | 'security'
  | 'synthesizer';

// ─── Swarm Types ───────────────────────────────────────────────────────────────

export type SwarmAgentStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface SwarmAgent {
  id: string;               // unique sub-agent id
  role: AgentProfile;       // which profile is running
  goal: string;             // short description of what this agent is doing
  status: SwarmAgentStatus;
  startedAt?: number;
  completedAt?: number;
  toolCallCount: number;
  result?: string;          // truncated result summary
  error?: string;
}

export interface SwarmState {
  runId: string;            // parent run id
  totalAgents: number;
  agents: SwarmAgent[];
  startedAt: number;
  completedAt?: number;
}
export type WorkflowStage = 'starting' | 'planning' | 'executing' | 'reviewing' | 'completed' | 'failed' | 'cancelled';

export interface ProcessInfo {
  id: string;
  conversationId: string;
  status: 'running' | 'awaiting_approval' | 'needs_human' | 'completed' | 'failed' | 'cancelled';
  summary: string;
  startedAt: number;
  completedAt?: number;
  toolCallCount: number;
  toolCompletedCount?: number;
  toolFailedCount?: number;
  error?: string;
  isAttached: boolean;
  wasDetached: boolean;
  provider?: ProviderId;
  model?: string;
  agentProfile?: AgentProfile;
  lastSpecializedTool?: string;
  workflowStage?: WorkflowStage;
}

export type RunStatus = 'running' | 'awaiting_approval' | 'needs_human' | 'completed' | 'failed' | 'cancelled';

export interface RunSummary {
  id: string;
  conversationId: string;
  title: string;
  goal: string;
  status: RunStatus;
  startedAt: number;
  completedAt?: number;
  toolCallCount: number;
  toolCompletedCount?: number;
  toolFailedCount?: number;
  error?: string;
  wasDetached: boolean;
  provider?: ProviderId;
  model?: string;
  workflowStage?: WorkflowStage;
}

export interface RunArtifact {
  id: number;
  runId: string;
  kind: 'execution_plan' | 'execution_graph_scaffold' | 'execution_graph_state' | 'evidence_ledger';
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunEvent {
  id: number;
  runId: string;
  seq: number;
  timestamp: string;
  kind: string;
  phase?: string | null;
  surface?: string | null;
  toolName?: string | null;
  payload: Record<string, any>;
}

export interface RunChange {
  id: number;
  runId: string;
  eventId?: number;
  changeType: string;
  target: string;
  summary: string;
  diffText?: string;
  createdAt: string;
}

export interface RunApproval {
  id: number;
  runId: string;
  status: 'pending' | 'approved' | 'denied';
  actionType: string;
  target: string;
  summary: string;
  request: Record<string, any>;
  createdAt: string;
  resolvedAt?: string;
}

export interface RunHumanIntervention {
  id: number;
  runId: string;
  status: 'pending' | 'resolved' | 'dismissed';
  interventionType: 'password' | 'otp' | 'captcha' | 'native_dialog' | 'site_confirmation' | 'conflict_resolution' | 'manual_takeover' | 'unknown';
  target?: string;
  summary: string;
  instructions?: string;
  request: Record<string, any>;
  createdAt: string;
  resolvedAt?: string;
}

export type BrowserExecutionMode = 'headed' | 'headless' | 'persistent_session';
export type PerformanceStance = 'conservative' | 'standard' | 'aggressive';

export type { ProviderId };

export interface PolicyRule {
  id: string;
  enabled: boolean;
  match: {
    toolNames?: string[];
    commandPatterns?: string[];
    pathPrefixes?: string[];
  };
  effect: 'allow' | 'deny' | 'require_approval';
  reason: string;
}

export interface PolicyProfile {
  id: string;
  name: string;
  scopeType: 'global' | 'workspace' | 'task_type';
  scopeValue?: string;
  rules: PolicyRule[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatSendResult {
  ok?: boolean;
  runId?: string;
  response?: string;
  toolCalls?: ToolCall[];
  conversationId?: string | null;
  error?: string;
}
