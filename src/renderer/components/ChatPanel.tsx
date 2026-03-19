import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { Message, ToolCall } from '../../shared/types';
import InputBar from './InputBar';
import StatusLine from './StatusLine';
import ToolActivity, { type ToolStreamMap } from './ToolActivity';
import MarkdownRenderer from './MarkdownRenderer';

interface ChatPanelProps {
  browserVisible: boolean;
  onToggleBrowser: () => void;
  loadConversationId?: string | null;
}

function Clock() {
  const [time, setTime] = useState(() => {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  });
  useEffect(() => {
    const interval = setInterval(() => {
      const now = new Date();
      setTime(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`);
    }, 30_000);
    return () => clearInterval(interval);
  }, []);
  return <span className="text-xs text-text-muted tabular-nums px-2">{time}</span>;
}

/** Copy button with checkmark feedback */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback for older Electron versions
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      title="Copy response"
      className={`
        flex items-center justify-center w-7 h-7 rounded-md transition-all duration-200 cursor-pointer
        ${copied
          ? 'text-status-success'
          : 'text-text-muted/0 group-hover:text-text-muted hover:!text-text-secondary hover:bg-white/[0.06]'
        }
      `}
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

function AssistantMessage({ message, streamMap, onRateTool }: { message: Message; streamMap?: ToolStreamMap; onRateTool?: (messageId: string, toolId: string, rating: 'up' | 'down' | null, note?: string) => void }) {
  const handleRate = useCallback((toolId: string, rating: 'up' | 'down' | null, note?: string) => {
    onRateTool?.(message.id, toolId, rating, note);
  }, [message.id, onRateTool]);

  return (
    <div className="flex justify-start animate-slide-up group">
      <div className="max-w-[92%] px-1 py-2 text-text-primary">
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mb-2">
            <ToolActivity
              tools={message.toolCalls}
              streamMap={streamMap}
              messageId={message.id}
              onRateTool={handleRate}
            />
          </div>
        )}
        <MarkdownRenderer content={message.content} isStreaming={message.isStreaming} />
        {!message.isStreaming && message.content && (
          <div className="flex items-center gap-2 mt-2">
            <span className="text-2xs text-text-muted">{message.timestamp}</span>
            <CopyButton text={message.content} />
          </div>
        )}
      </div>
    </div>
  );
}

function UserMessage({ message }: { message: Message }) {
  return (
    <div className="flex justify-end animate-slide-up">
      <div className="max-w-[85%] rounded-2xl rounded-br-md px-4 py-2.5 bg-user-bubble text-text-primary">
        <div className="text-[0.9rem] leading-relaxed whitespace-pre-wrap">{message.content}</div>
        <div className="mt-1 text-2xs text-white/20">{message.timestamp}</div>
      </div>
    </div>
  );
}

export default function ChatPanel({ browserVisible, onToggleBrowser, loadConversationId }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [statusText, setStatusText] = useState('');
  // toolId → accumulated stdout/stderr lines for the live stream panel
  const [streamMap, setStreamMap] = useState<ToolStreamMap>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamBufferRef = useRef('');
  const toolCallsRef = useRef<ToolCall[]>([]);
  const assistantMsgIdRef = useRef<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingUpdateRef = useRef(false);
  const isUserScrolledUpRef = useRef(false);

  useEffect(() => {
    if (!loadConversationId) return;
    const api = (window as any).clawdia;
    if (!api) return;
    api.chat.load(loadConversationId).then((result: any) => {
      if (result.messages?.length > 0) {
        setMessages(result.messages);
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        });
      }
    }).catch(() => {});
  }, [loadConversationId]);

  const scrollToBottom = useCallback((behavior: 'auto' | 'smooth' = 'auto') => {
    if (scrollRef.current) scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior });
  }, []);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    isUserScrolledUpRef.current = (scrollHeight - scrollTop - clientHeight) > 100;
  }, []);

  const autoScroll = useCallback(() => {
    if (!isUserScrolledUpRef.current) scrollToBottom();
  }, [scrollToBottom]);

  const flushStreamUpdate = useCallback(() => {
    if (!assistantMsgIdRef.current) return;
    const content = streamBufferRef.current;
    const tools = [...toolCallsRef.current];
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === assistantMsgIdRef.current);
      if (idx === -1) return prev;
      const updated = [...prev];
      updated[idx] = { ...updated[idx], content, toolCalls: tools, isStreaming: true };
      return updated;
    });
    pendingUpdateRef.current = false;
    requestAnimationFrame(() => autoScroll());
  }, [autoScroll]);

  const scheduleStreamUpdate = useCallback(() => {
    if (pendingUpdateRef.current) return;
    pendingUpdateRef.current = true;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      flushStreamUpdate();
    });
  }, [flushStreamUpdate]);

  useEffect(() => {
    const api = (window as any).clawdia;
    if (!api) return;
    const cleanups: (() => void)[] = [];

    cleanups.push(api.chat.onStreamText((chunk: string) => {
      if (chunk.includes('__RESET__')) {
        streamBufferRef.current = '';
        scheduleStreamUpdate();
        return;
      }
      streamBufferRef.current += chunk;
      setStatusText('');
      scheduleStreamUpdate();
    }));

    cleanups.push(api.chat.onThinking((thought: string) => {
      if (thought) { setStatusText(thought); autoScroll(); }
    }));

    cleanups.push(api.chat.onToolActivity((activity: { name: string; status: string; detail?: string }) => {
      const tc: ToolCall = {
        id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: activity.name,
        status: activity.status as ToolCall['status'],
        detail: activity.detail,
      };
      toolCallsRef.current = toolCallsRef.current.filter(t => !(t.name === tc.name && t.status === 'running'));
      toolCallsRef.current.push(tc);
      scheduleStreamUpdate();

      if (activity.status === 'running') {
        const detail = activity.detail ? ` — ${activity.detail.slice(0, 50)}` : '';
        setStatusText(`Running ${activity.name}${detail}`);
      } else if (activity.status === 'success') {
        setStatusText(`Completed ${activity.name}`);
      } else if (activity.status === 'error') {
        setStatusText(`Failed: ${activity.name}`);
      }
      autoScroll();
    }));

    if (api.chat.onToolStream) {
      cleanups.push(api.chat.onToolStream((payload: { toolId: string; toolName: string; chunk: string }) => {
        setStreamMap(prev => {
          const existing = prev[payload.toolId] ?? [];
          // Cap at 200 lines to avoid unbounded memory growth
          const next = existing.length >= 200
            ? [...existing.slice(-199), payload.chunk]
            : [...existing, payload.chunk];
          return { ...prev, [payload.toolId]: next };
        });
      }));
    }

    cleanups.push(api.chat.onStreamEnd(() => {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    }));

    return () => {
      cleanups.forEach(fn => fn());
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [scheduleStreamUpdate, autoScroll]);

  const handleSend = useCallback(async (text: string) => {
    const api = (window as any).clawdia;
    if (!api) return;

    isUserScrolledUpRef.current = false;

    const userMsg: Message = {
      id: `user-${Date.now()}`, role: 'user', content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    };
    setMessages(prev => [...prev, userMsg]);
    setTimeout(() => scrollToBottom('smooth'), 50);

    const assistantId = `assistant-${Date.now()}`;
    assistantMsgIdRef.current = assistantId;
    streamBufferRef.current = '';
    toolCallsRef.current = [];
    setStreamMap({});

    setTimeout(() => {
      setMessages(prev => [...prev, {
        id: assistantId, role: 'assistant', content: '',
        timestamp: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        isStreaming: true,
      }]);
      setIsStreaming(true);
    }, 100);

    try {
      const result = await api.chat.send(text);

      const finalContent = result.response || streamBufferRef.current || '';
      const finalTools = result.toolCalls?.map((tc: any, i: number) => ({
        ...tc, id: tc.id || `tc-${i}`
      })) || [...toolCallsRef.current];

      if (result.error) {
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: `⚠️ ${result.error}`, isStreaming: false, toolCalls: [] } : m
        ));
      } else {
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: finalContent, toolCalls: finalTools, isStreaming: false } : m
        ));
      }

      setIsStreaming(false);
      setStatusText('');
      assistantMsgIdRef.current = null;
      isUserScrolledUpRef.current = false;
      requestAnimationFrame(() => scrollToBottom('smooth'));
    } catch (err: any) {
      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, content: `⚠️ ${err.message || 'Unknown error'}`, isStreaming: false } : m
      ));
      setIsStreaming(false);
      setStatusText('');
      assistantMsgIdRef.current = null;
    }
  }, [scrollToBottom]);

  const handleStop = useCallback(() => {
    (window as any).clawdia?.chat.stop();
    setIsStreaming(false);
    setIsPaused(false);
    setStatusText('');
  }, []);

  const handlePause = useCallback(() => {
    (window as any).clawdia?.chat.pause();
    setIsPaused(true);
    setStatusText('Paused — type to add context, or resume');
  }, []);

  const handleResume = useCallback(() => {
    (window as any).clawdia?.chat.resume();
    setIsPaused(false);
    setStatusText('Resuming...');
  }, []);

  const handleRateTool = useCallback((messageId: string, toolId: string, rating: 'up' | 'down' | null, note?: string) => {
    const api = (window as any).clawdia;
    if (!api) return;
    // Update local state immediately for responsive UI
    setMessages(prev => prev.map(m => {
      if (m.id !== messageId || !m.toolCalls) return m;
      return {
        ...m,
        toolCalls: m.toolCalls.map(tc => {
          if (tc.id !== toolId) return tc;
          const updated = { ...tc, rating };
          if (note !== undefined) updated.ratingNote = note;
          if (rating === null) { updated.rating = null; updated.ratingNote = undefined; }
          if (rating === 'up') { updated.ratingNote = undefined; }
          return updated;
        }),
      };
    }));
    // Persist to database
    api.chat.rateTool(messageId, toolId, rating, note);
  }, []);

  const handleAddContext = useCallback((text: string) => {
    (window as any).clawdia?.chat.addContext(text);
    // Show it in the chat as a visual indicator
    const contextMsg: Message = {
      id: `context-${Date.now()}`,
      role: 'user',
      content: `💬 ${text}`,
      timestamp: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    };
    setMessages(prev => [...prev, contextMsg]);
    setStatusText('Context added — will be used in next iteration');
    requestAnimationFrame(() => scrollToBottom('smooth'));
  }, [scrollToBottom]);

  return (
    <div className="flex flex-col h-full">
      <header className="drag-region flex items-center gap-2 px-3 h-[44px] flex-shrink-0 border-b border-border-subtle">
        <span className="text-[13px] font-semibold tracking-[0.06em] uppercase text-text-tertiary ml-1">Clawdia</span>
        <div className="flex-1 drag-region" />
        <button onClick={onToggleBrowser} title="Toggle browser" className={`no-drag flex items-center justify-center w-8 h-8 rounded-lg transition-all cursor-pointer ${browserVisible ? 'text-text-secondary hover:text-text-primary hover:bg-white/[0.06]' : 'text-text-muted hover:text-text-secondary hover:bg-white/[0.04]'}`}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="12" y1="3" x2="12" y2="21" /></svg>
        </button>
        <Clock />
        <div className="no-drag flex items-center gap-0.5 ml-1 pl-2 border-l border-white/[0.06]">
          <button onClick={() => (window as any).clawdia?.window.minimize()} className="flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-text-secondary hover:bg-white/[0.06] transition-colors cursor-pointer opacity-50 hover:opacity-100"><svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="2" y1="5" x2="8" y2="5" /></svg></button>
          <button onClick={() => (window as any).clawdia?.window.maximize()} className="flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-text-secondary hover:bg-white/[0.06] transition-colors cursor-pointer opacity-50 hover:opacity-100"><svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="6" height="6" /></svg></button>
          <button onClick={() => (window as any).clawdia?.window.close()} className="flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-white hover:bg-red-500/80 transition-colors cursor-pointer opacity-50 hover:opacity-100"><svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" /></svg></button>
        </div>
      </header>

      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto overflow-x-hidden scroll-smooth">
        <div className="flex flex-col gap-4 px-4 py-5 max-w-[720px]">
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-[60vh] text-text-muted">
              <div className="flex flex-col items-center gap-3">
                <div className="opacity-[0.12]"><svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg></div>
                <span className="text-sm text-text-muted/50">Ask Clawdia anything</span>
              </div>
            </div>
          )}
          {messages.map(msg =>
            msg.role === 'assistant'
              ? <AssistantMessage key={msg.id} message={msg} streamMap={msg.isStreaming ? streamMap : undefined} onRateTool={handleRateTool} />
              : <UserMessage key={msg.id} message={msg} />
          )}
          {isStreaming && <StatusLine text={statusText} />}
          <div className="h-2" />
        </div>
      </div>

      <InputBar
        onSend={handleSend}
        isStreaming={isStreaming}
        isPaused={isPaused}
        onStop={handleStop}
        onPause={handlePause}
        onResume={handleResume}
        onAddContext={handleAddContext}
      />
    </div>
  );
}
