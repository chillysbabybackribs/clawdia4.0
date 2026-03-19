export interface MessageIteration {
  text: string;          // LLM narration for this iteration (may be '')
  toolCalls: ToolCall[]; // tool calls dispatched after this text (may be [])
}

// Flat append-only feed item — renderer-only, NOT persisted to DB
export type FeedItem =
  | { kind: 'tool'; tool: ToolCall }
  | { kind: 'text'; text: string; isStreaming?: boolean };

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
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

export interface ProcessInfo {
  id: string;
  conversationId: string;
  status: 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
  summary: string;
  startedAt: number;
  completedAt?: number;
  toolCallCount: number;
  error?: string;
  isAttached: boolean;
  wasDetached: boolean;
}

export type RunStatus = 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

export interface RunSummary {
  id: string;
  conversationId: string;
  title: string;
  goal: string;
  status: RunStatus;
  startedAt: number;
  completedAt?: number;
  toolCallCount: number;
  error?: string;
  wasDetached: boolean;
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

export interface ChatSendResult {
  ok?: boolean;
  runId?: string;
  response?: string;
  toolCalls?: ToolCall[];
  conversationId?: string | null;
  error?: string;
}
