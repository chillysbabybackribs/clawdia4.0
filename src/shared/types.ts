export interface MessageIteration {
  text: string;          // LLM narration for this iteration (may be '')
  toolCalls: ToolCall[]; // tool calls dispatched after this text (may be [])
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  toolCalls?: ToolCall[];
  iterations?: MessageIteration[];   // renderer-only — NOT persisted to DB
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
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  summary: string;
  startedAt: number;
  completedAt?: number;
  toolCallCount: number;
  error?: string;
  isAttached: boolean;
  wasDetached: boolean;
}
