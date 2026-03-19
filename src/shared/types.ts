export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  toolCalls?: ToolCall[];
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
