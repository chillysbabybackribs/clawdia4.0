import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { Message, ToolCall, FeedItem, ProcessInfo, RunApproval } from '../../shared/types';
import InputBar from './InputBar';
import StatusLine from './StatusLine';
import ToolActivity, { type ToolStreamMap } from './ToolActivity';
import MarkdownRenderer from './MarkdownRenderer';
import TerminalLogStrip from './TerminalLogStrip';

interface ChatPanelProps {
  browserVisible: boolean;
  onToggleBrowser: () => void;
  onOpenSettings: () => void;
  onOpenPendingApproval?: (processId: string) => void;
  loadConversationId?: string | null;
}

function ApprovalBanner({
  approval,
  onApprove,
  onDeny,
  onOpenReview,
}: {
  approval: RunApproval;
  onApprove: () => void;
  onDeny: () => void;
  onOpenReview: () => void;
}) {
  return (
    <div className="mx-4 mb-3 rounded-xl border border-[#ff7a00]/25 bg-[#ff7a00]/8 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-[#ff9a3d]">Approval required</div>
          <div className="mt-1 text-[13px] text-text-primary">{approval.summary}</div>
          <div className="mt-1 text-2xs text-text-muted break-all">
            {approval.actionType} · {approval.target}
          </div>
        </div>
        <button
          onClick={onOpenReview}
          className="text-2xs px-2.5 py-1 rounded-md text-text-secondary hover:text-text-primary hover:bg-white/[0.06] transition-colors cursor-pointer flex-shrink-0"
        >
          Open review
        </button>
      </div>
      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={onApprove}
          className="text-2xs px-2.5 py-1 rounded-md bg-[#ff7a00]/16 text-[#ff9a3d] hover:bg-[#ff7a00]/24 transition-colors cursor-pointer"
        >
          Approve
        </button>
        <button
          onClick={onDeny}
          className="text-2xs px-2.5 py-1 rounded-md bg-red-400/10 text-red-300 hover:bg-red-400/18 transition-colors cursor-pointer"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function Clock() {
  const fmt = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const [time, setTime] = useState(fmt);
  useEffect(() => {
    const interval = setInterval(() => setTime(fmt()), 30_000);
    return () => clearInterval(interval);
  }, []);
  return <span className="text-[13px] text-text-secondary tabular-nums">{time}</span>;
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

function AssistantMessage({ message, streamMap }: { message: Message; streamMap?: ToolStreamMap }) {
  const activeStreamMap = message.isStreaming ? (streamMap ?? {}) : {};

  // Live path: flat append-only feed
  if (message.feed && message.feed.length > 0) {
    // Collapse consecutive tool items into groups for rendering
    type RenderGroup =
      | { kind: 'tools'; tools: ToolCall[]; startIdx: number }
      | { kind: 'text'; text: string; isStreaming?: boolean; idx: number };

    const groups: RenderGroup[] = [];
    for (let i = 0; i < message.feed.length; i++) {
      const item = message.feed[i];
      if (item.kind === 'tool') {
        const last = groups[groups.length - 1];
        if (last && last.kind === 'tools') {
          last.tools.push(item.tool);
        } else {
          groups.push({ kind: 'tools', tools: [item.tool], startIdx: i });
        }
      } else {
        if (!item.text.trim()) continue; // skip empty text — don't break tool grouping
        groups.push({ kind: 'text', text: item.text, isStreaming: item.isStreaming, idx: i });
      }
    }

    return (
      <div className="flex justify-start animate-slide-up group">
        <div className="max-w-[92%] px-1 py-2 text-text-primary flex flex-col gap-3">
          {groups.map((g, i) =>
            g.kind === 'tools' ? (
              <ToolActivity key={g.startIdx} tools={g.tools} streamMap={activeStreamMap} />
            ) : (
              <MarkdownRenderer key={g.idx} content={g.text} isStreaming={g.isStreaming === true} />
            )
          )}
          {!message.isStreaming && message.content && (
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[11px] text-text-secondary/70">{message.timestamp}</span>
              <CopyButton text={message.content} />
            </div>
          )}
        </div>
      </div>
    );
  }

  // Fallback: DB-loaded historical messages
  const hasContent = !!message.content?.trim();
  const hasTools = !!message.toolCalls?.length;
  if (!hasContent && !hasTools) return null;
  return (
    <div className="flex justify-start animate-slide-up group">
      <div className="max-w-[92%] px-1 py-2 text-text-primary">
        {hasTools && <div className={hasContent ? 'mb-3' : ''}><ToolActivity tools={message.toolCalls!} streamMap={{}} /></div>}
        {hasContent && <MarkdownRenderer content={message.content} isStreaming={false} />}
        {hasContent && (
          <div className="flex items-center gap-2 mt-2">
            <span className="text-[11px] text-text-secondary/70">{message.timestamp}</span>
            <CopyButton text={message.content} />
          </div>
        )}
      </div>
    </div>
  );
}

function UserMessage({ message }: { message: Message }) {
  return (
    <div className="flex flex-col items-end gap-1 animate-slide-up">
      <div className="max-w-[85%] rounded-2xl rounded-br-md px-4 py-2.5 bg-accent/90 text-white">
        <div className="text-[1rem] leading-relaxed whitespace-pre-wrap">{message.content}</div>
      </div>
      <span className="text-[11px] text-text-secondary/70 mr-1">{message.timestamp}</span>
    </div>
  );
}

export default function ChatPanel({ browserVisible, onToggleBrowser, onOpenSettings, onOpenPendingApproval, loadConversationId }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [streamMap, setStreamMap] = useState<ToolStreamMap>({});
  const [pendingApprovalRunId, setPendingApprovalRunId] = useState<string | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<RunApproval[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Flat append-only feed — each item appended once, never moved
  const feedRef = useRef<FeedItem[]>([]);
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

  useEffect(() => {
    const api = (window as any).clawdia;
    if (!api?.process || !api?.run) return;

    const syncPendingApproval = async (processes: ProcessInfo[]) => {
      const attachedBlocked = processes.find((proc) => proc.isAttached && proc.status === 'awaiting_approval');
      if (!attachedBlocked) {
        setPendingApprovalRunId(null);
        setPendingApprovals([]);
        return;
      }

      setPendingApprovalRunId(attachedBlocked.id);
      const approvals = await api.run.approvals(attachedBlocked.id);
      setPendingApprovals((approvals || []).filter((approval: RunApproval) => approval.status === 'pending'));
    };

    api.process.list().then(syncPendingApproval).catch(() => {});
    const cleanup = api.process.onListChanged((processes: ProcessInfo[]) => {
      syncPendingApproval(processes).catch(() => {});
    });
    return cleanup;
  }, []);

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
    const feed = [...feedRef.current];
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === assistantMsgIdRef.current);
      if (idx === -1) return prev;
      const updated = [...prev];
      updated[idx] = { ...updated[idx], feed, isStreaming: true };
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
        // Finalize the current streaming text item (seal it as non-streaming)
        const lastIdx = feedRef.current.length - 1;
        if (lastIdx >= 0 && feedRef.current[lastIdx].kind === 'text') {
          feedRef.current[lastIdx] = { ...feedRef.current[lastIdx], isStreaming: false } as FeedItem;
        }
        scheduleStreamUpdate();
        return;
      }
      // Append to existing streaming text item, or create one
      const lastIdx = feedRef.current.length - 1;
      if (lastIdx >= 0 && feedRef.current[lastIdx].kind === 'text') {
        const last = feedRef.current[lastIdx] as { kind: 'text'; text: string; isStreaming?: boolean };
        feedRef.current[lastIdx] = { kind: 'text', text: last.text + chunk, isStreaming: true };
      } else {
        feedRef.current.push({ kind: 'text', text: chunk, isStreaming: true });
      }
      setStatusText('');
      scheduleStreamUpdate();
    }));

    cleanups.push(api.chat.onThinking((thought: string) => {
      if (thought) { setStatusText(thought); autoScroll(); }
    }));

    cleanups.push(api.chat.onToolActivity((activity: { name: string; status: string; detail?: string }) => {
      if (activity.status === 'running') {
        const newTool: ToolCall = {
          id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: activity.name,
          status: 'running',
          detail: activity.detail,
        };
        // Finalize any open text item above, then append tool
        const lastIdx = feedRef.current.length - 1;
        if (lastIdx >= 0 && feedRef.current[lastIdx].kind === 'text') {
          feedRef.current[lastIdx] = { ...feedRef.current[lastIdx], isStreaming: false } as FeedItem;
        }
        feedRef.current.push({ kind: 'tool', tool: newTool });
        scheduleStreamUpdate();
        const detail = activity.detail ? ` — ${activity.detail.slice(0, 50)}` : '';
        setStatusText(`Running ${activity.name}${detail}`);
      } else {
        // Tool completed — find the matching running tool item and update it in place
        const toolId = feedRef.current
          .slice().reverse()
          .find(item => item.kind === 'tool' && item.tool.name === activity.name && item.tool.status === 'running');
        if (toolId && toolId.kind === 'tool') {
          const idx = feedRef.current.lastIndexOf(toolId);
          feedRef.current[idx] = {
            kind: 'tool',
            tool: {
              ...toolId.tool,
              status: activity.status as ToolCall['status'],
              detail: activity.detail,
            },
          };
        }
        scheduleStreamUpdate();
        if (activity.status === 'success') setStatusText(`Completed ${activity.name}`);
        else if (activity.status === 'error') setStatusText(`Failed: ${activity.name}`);
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
      flushStreamUpdate();
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
    feedRef.current = [];
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

      const finalFeed = [...feedRef.current].map(item =>
        item.kind === 'text' ? { ...item, isStreaming: false } : item
      ) as FeedItem[];
      const finalContent = result.response ||
        finalFeed.filter(i => i.kind === 'text').map(i => (i as any).text).join('\n\n') || '';
      const finalTools = finalFeed.filter(i => i.kind === 'tool').map(i => (i as any).tool) as ToolCall[];

      if (result.error) {
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: `⚠️ ${result.error}`, isStreaming: false, feed: [], toolCalls: [] } : m
        ));
      } else {
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? { ...m, content: finalContent, toolCalls: finalTools, feed: finalFeed, isStreaming: false }
            : m
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
    const applyRating = (tc: ToolCall) => {
      if (tc.id !== toolId) return tc;
      const updated = { ...tc, rating };
      if (note !== undefined) updated.ratingNote = note;
      if (rating === null) { updated.rating = null; updated.ratingNote = undefined; }
      if (rating === 'up') { updated.ratingNote = undefined; }
      return updated;
    };
    // Update local state immediately for responsive UI
    setMessages(prev => prev.map(m => {
      if (m.id !== messageId) return m;
      const updates: Partial<Message> = {};
      if (m.toolCalls) updates.toolCalls = m.toolCalls.map(applyRating);
      if (m.feed) updates.feed = m.feed.map(item =>
        item.kind === 'tool' ? { kind: 'tool', tool: applyRating(item.tool) } : item
      ) as FeedItem[];
      return { ...m, ...updates };
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

  const handleApprovalDecision = useCallback(async (decision: 'approve' | 'deny') => {
    const api = (window as any).clawdia;
    const approval = pendingApprovals[0];
    if (!api?.run || !approval) return;

    if (decision === 'approve') await api.run.approve(approval.id);
    else await api.run.deny(approval.id);

    if (pendingApprovalRunId) {
      const approvals = await api.run.approvals(pendingApprovalRunId);
      setPendingApprovals((approvals || []).filter((item: RunApproval) => item.status === 'pending'));
    }
  }, [pendingApprovalRunId, pendingApprovals]);

  return (
    <div className="flex flex-col h-full">
      <header className="drag-region flex items-center gap-2 px-4 h-[44px] flex-shrink-0 bg-surface-1 border-b border-border-subtle shadow-[inset_0_-1px_6px_rgba(0,0,0,0.2),0_2px_8px_rgba(0,0,0,0.3)] relative z-10">
        <Clock />
        <div className="flex-1 drag-region" />
        <button onClick={onOpenSettings} title="Settings" className="no-drag flex items-center justify-center w-8 h-8 rounded-lg text-text-secondary hover:text-text-primary hover:bg-white/[0.06] transition-all cursor-pointer">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </header>

      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto overflow-x-hidden scroll-smooth">
        <div className="flex flex-col gap-4 px-4 pt-5 pb-8 max-w-[720px]">
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-[60vh] text-text-muted">
              <div className="flex flex-col items-center gap-3">
                <div className="opacity-[0.12]"><svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg></div>
                <span className="text-[14px] text-text-secondary/50">Ask Clawdia anything</span>
              </div>
            </div>
          )}
          {messages.map(msg =>
            msg.role === 'assistant'
              ? <AssistantMessage key={msg.id} message={msg} streamMap={msg.isStreaming ? streamMap : undefined} />
              : <UserMessage key={msg.id} message={msg} />
          )}
          {isStreaming && <StatusLine text={statusText} />}
          <div className="h-2" />
        </div>
      </div>

      {(() => {
        const terminalLines = Object.values(streamMap).flat();
        return (isStreaming || terminalLines.length > 0) ? (
          <TerminalLogStrip lines={terminalLines} isStreaming={isStreaming} />
        ) : null;
      })()}

      {pendingApprovalRunId && pendingApprovals[0] && (
        <ApprovalBanner
          approval={pendingApprovals[0]}
          onApprove={() => handleApprovalDecision('approve')}
          onDeny={() => handleApprovalDecision('deny')}
          onOpenReview={() => onOpenPendingApproval?.(pendingApprovalRunId)}
        />
      )}

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
