import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { Message, ToolCall, FeedItem, ProcessInfo, RunApproval, RunHumanIntervention, MessageAttachment } from '../../shared/types';
import InputBar from './InputBar';
import StatusLine from './StatusLine';
import ToolActivity, { type ToolStreamMap } from './ToolActivity';
import MarkdownRenderer from './MarkdownRenderer';
import TerminalLogStrip from './TerminalLogStrip';
import SwarmPanel from './SwarmPanel';


interface ChatPanelProps {
  browserVisible: boolean;
  onToggleBrowser: () => void;
  onHideBrowser: () => void;
  onShowBrowser: () => void;
  calendarOpen: boolean;
  onToggleCalendar: () => void;
  onOpenSettings: () => void;
  onOpenPendingApproval?: (processId: string) => void;
  loadConversationId?: string | null;
  replayBuffer?: Array<{ type: string; data: any }> | null;
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
  const isWorkflowPlan = approval.actionType === 'workflow_plan';
  const planText = typeof approval.request?.plan === 'string' ? approval.request.plan : '';
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-text-primary">{isWorkflowPlan ? 'Plan approval required' : 'Approval required'}</div>
          <div className="mt-1 text-[13px] text-text-primary">{approval.summary}</div>
          <div className="mt-1 text-2xs text-text-muted break-all">
            {approval.actionType} · {approval.target}
          </div>
          {isWorkflowPlan && planText && (
            <div className="mt-3 rounded-xl border border-white/[0.04] bg-[#0f0f13] px-4 py-3">
              <MarkdownRenderer content={planText} />
            </div>
          )}
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
          className="text-2xs px-2.5 py-1 rounded-md bg-white/[0.07] text-text-primary hover:bg-white/[0.1] transition-colors cursor-pointer"
        >
          Approve
        </button>
        <button
          onClick={onDeny}
          className="text-2xs px-2.5 py-1 rounded-md bg-white/[0.04] text-text-secondary hover:bg-white/[0.08] hover:text-text-primary transition-colors cursor-pointer"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function WorkflowPlanCard({
  planText,
  isStreaming,
  approval,
  onApprove,
  onRevise,
  onDeny,
  onOpenReview,
}: {
  planText: string;
  isStreaming: boolean;
  approval?: RunApproval | null;
  onApprove?: () => void;
  onRevise?: () => void;
  onDeny?: () => void;
  onOpenReview?: () => void;
}) {
  if (!planText && !isStreaming) return null;

  return (
    <div className="flex justify-start animate-slide-up">
      <div className="max-w-[92%] px-1 py-1 text-text-primary">
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
          <div className="flex items-center gap-2">
            <div className="status-shimmer-dot" />
            <div className="text-[13px] font-medium text-text-primary">
              {isStreaming ? 'Drafting execution plan' : 'Execution plan ready'}
            </div>
            {isStreaming && (
              <span className="status-shimmer-text text-[12px] tracking-wide text-text-secondary">
                Streaming
              </span>
            )}
          </div>
          <div className="mt-1 text-2xs text-text-muted">
            {isStreaming ? 'Clawdia is planning before execution starts.' : 'Review the plan before approving execution.'}
          </div>
          <div className="mt-3 rounded-xl border border-white/[0.04] bg-[#0f0f13] px-4 py-3">
            <MarkdownRenderer content={planText || '## Objective\nDrafting execution plan...'} isStreaming={isStreaming} />
          </div>
          {approval && !isStreaming && (
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={onApprove}
                className="text-2xs px-2.5 py-1 rounded-md bg-white/[0.07] text-text-primary hover:bg-white/[0.1] transition-colors cursor-pointer"
              >
                Approve
              </button>
              <button
                onClick={onRevise}
                className="text-2xs px-2.5 py-1 rounded-md bg-white/[0.04] text-text-secondary hover:bg-white/[0.08] hover:text-text-primary transition-colors cursor-pointer"
              >
                Regenerate
              </button>
              <button
                onClick={onDeny}
                className="text-2xs px-2.5 py-1 rounded-md bg-white/[0.04] text-text-secondary hover:bg-white/[0.08] hover:text-text-primary transition-colors cursor-pointer"
              >
                Deny
              </button>
              <button
                onClick={onOpenReview}
                className="text-2xs px-2.5 py-1 rounded-md text-text-secondary hover:text-text-primary hover:bg-white/[0.06] transition-colors cursor-pointer"
              >
                Open review
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function HumanInterventionBanner({
  intervention,
  onResume,
  onCancelRun,
  onOpenReview,
}: {
  intervention: RunHumanIntervention;
  onResume: () => void;
  onCancelRun: () => void;
  onOpenReview: () => void;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.14] bg-white/[0.04] px-4 py-3 shadow-[0_0_0_1px_rgba(255,255,255,0.03),0_0_18px_rgba(255,255,255,0.08)] animate-pulse">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-text-primary">Needs human intervention</div>
          <div className="mt-1 text-[13px] text-text-primary">{intervention.summary}</div>
          {intervention.instructions && (
            <div className="mt-2 text-[12px] leading-relaxed text-text-secondary whitespace-pre-wrap">
              {intervention.instructions}
            </div>
          )}
          <div className="mt-2 text-2xs text-text-muted break-all">
            {intervention.interventionType}{intervention.target ? ` · ${intervention.target}` : ''}
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
          onClick={onResume}
          className="text-2xs px-2.5 py-1 rounded-md bg-white/[0.07] text-text-primary hover:bg-white/[0.1] transition-colors cursor-pointer"
        >
          Resume
        </button>
        <button
          onClick={onCancelRun}
          className="text-2xs px-2.5 py-1 rounded-md bg-white/[0.04] text-text-secondary hover:bg-white/[0.08] hover:text-text-primary transition-colors cursor-pointer"
        >
          Cancel run
        </button>
      </div>
    </div>
  );
}

function CalendarTrigger({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const fmt = () => {
    const d = new Date();
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  };
  const [label, setLabel] = useState(fmt);
  useEffect(() => {
    const interval = setInterval(() => setLabel(fmt()), 60_000);
    return () => clearInterval(interval);
  }, []);
  return (
    <button
      onClick={onToggle}
      className="no-drag"
      title={open ? 'Close calendar' : 'Open calendar'}
      style={{
        background: open ? 'rgba(255,255,255,0.06)' : 'transparent',
        border: open ? '1px solid rgba(255,255,255,0.35)' : '1px solid transparent',
        borderRadius: 6,
        padding: '3px 8px',
        cursor: 'pointer',
        transition: 'background 0.15s, border-color 0.15s, color 0.15s',
        color: open ? '#fff' : 'rgba(255,255,255,0.55)',
        fontSize: 13,
        fontWeight: 400,
        letterSpacing: '0.01em',
        lineHeight: 1,
      }}
      onMouseEnter={(e) => {
        if (!open) {
          (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)';
          (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.85)';
        }
      }}
      onMouseLeave={(e) => {
        if (!open) {
          (e.currentTarget as HTMLElement).style.background = 'transparent';
          (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.55)';
        }
      }}
    >
      {label}
    </button>
  );
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

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentGallery({ attachments }: { attachments: MessageAttachment[] }) {
  if (attachments.length === 0) return null;
  const images = attachments.filter((attachment) => attachment.kind === 'image' && attachment.dataUrl);
  const files = attachments.filter((attachment) => attachment.kind !== 'image' || !attachment.dataUrl);
  const openAttachment = async (attachment: MessageAttachment) => {
    if (!attachment.path) return;
    await (window as any).clawdia?.chat.openAttachment(attachment.path);
  };

  return (
    <div className="flex flex-col gap-2">
      {images.length > 0 && (
        <div className="flex flex-col gap-2">
          {images.map((attachment) => (
            <button
              key={attachment.id}
              type="button"
              onClick={() => openAttachment(attachment)}
              disabled={!attachment.path}
              className={`overflow-hidden rounded-2xl border border-white/[0.10] bg-white/[0.03] max-w-[420px] text-left transition-colors ${
                attachment.path ? 'cursor-pointer hover:bg-white/[0.05]' : 'cursor-default'
              }`}
            >
              <img src={attachment.dataUrl} alt={attachment.name} className="block w-full max-h-[320px] object-cover" />
              <div className="px-3 py-2.5 border-t border-white/[0.06]">
                <div className="text-[12px] text-text-primary truncate">{attachment.name}</div>
                <div className="mt-0.5 text-[11px] text-text-secondary/80">{formatAttachmentSize(attachment.size)}</div>
              </div>
            </button>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-col gap-2">
          {files.map((attachment) => (
            <button
              key={attachment.id}
              type="button"
              onClick={() => openAttachment(attachment)}
              disabled={!attachment.path}
              className={`rounded-xl border border-white/[0.10] bg-white/[0.03] px-3 py-2.5 max-w-[420px] text-left transition-colors ${
                attachment.path ? 'cursor-pointer hover:bg-white/[0.05]' : 'cursor-default'
              }`}
            >
              <div className="text-[12px] text-text-primary break-all">{attachment.name}</div>
              <div className="mt-0.5 text-[11px] text-text-secondary/80">{formatAttachmentSize(attachment.size)}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const AssistantMessage = React.memo(function AssistantMessage({ message, streamMap, shimmerText }: { message: Message; streamMap?: ToolStreamMap; shimmerText?: string }) {
  const activeStreamMap = message.isStreaming ? (streamMap ?? {}) : {};

  // Live path: flat append-only feed
  if (message.feed && message.feed.length > 0) {
    const textItems: Array<{ text: string; isStreaming?: boolean; idx: number }> = [];
    for (let i = 0; i < message.feed.length; i++) {
      const item = message.feed[i];
      if (item.kind === 'text') {
        if (!item.text.trim()) continue;
        textItems.push({ text: item.text, isStreaming: item.isStreaming, idx: i });
      }
    }

    const hasText = textItems.length > 0;

    return (
      <div className="flex justify-start animate-slide-up group">
        <div className="max-w-[92%] px-1 py-2 text-text-primary flex flex-col gap-3">
          {/* Shimmer — shown only while streaming and no text has arrived yet */}
          {message.isStreaming && shimmerText && !hasText && (
            <InlineShimmer text={shimmerText} />
          )}
          {textItems.map(g => (
            <MarkdownRenderer key={g.idx} content={g.text} isStreaming={g.isStreaming === true} />
          ))}
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
  if (!hasContent) return null;
  return (
    <div className="flex justify-start animate-slide-up group">
      <div className="max-w-[92%] px-1 py-2 text-text-primary">
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
}, (prev, next) => {
  // Skip re-render for finished messages — their data never changes
  if (!prev.message.isStreaming && !next.message.isStreaming) {
    return prev.message.id === next.message.id;
  }
  // Re-render when shimmerText changes (keeps shimmer in sync)
  if (prev.shimmerText !== next.shimmerText) return false;
  // Always re-render the actively streaming message
  return false;
});

const UserMessage = React.memo(function UserMessage({ message }: { message: Message }) {
  return (
    <div className="flex flex-col items-end gap-1 animate-slide-up">
      <div className="max-w-[85%] rounded-2xl rounded-br-md px-4 py-2.5 bg-neutral-700/60 text-white backdrop-blur-sm">
        {message.attachments && message.attachments.length > 0 && (
          <div className={message.content.trim() ? 'mb-3' : ''}>
            <AttachmentGallery attachments={message.attachments} />
          </div>
        )}
        {message.content.trim() && <div className="text-[1rem] leading-relaxed whitespace-pre-wrap">{message.content}</div>}
      </div>
      <span className="text-[11px] text-text-secondary/70 mr-1">{message.timestamp}</span>
    </div>
  );
});

function extractHostname(detail: string): string | null {
  const match = detail?.match(/https?:\/\/([^/\s]+)/);
  return match ? match[1].replace(/^www\./, '') : null;
}

function toolToShimmerLabel(name: string, detail?: string): string {
  if (name === 'browser_navigate') {
    const host = extractHostname(detail ?? '');
    return host ? `Navigating to ${host}…` : 'Navigating…';
  }
  const labels: Record<string, string> = {
    browser_click:     'Clicking…',
    browser_extract:   'Extracting page content…',
    browser_read:      'Reading page…',
    browser_type:      'Typing…',
    browser_batch:     'Running browser sequence…',
    browser_scroll:    'Scrolling…',
    shell_exec:        'Running command…',
    file_read:         'Reading file…',
    file_write:        'Writing file…',
    file_edit:         'Editing file…',
    directory_tree:    'Scanning directory…',
    fs_quote_lookup:   'Searching files…',
    fs_folder_summary: 'Summarising folder…',
    agent_spawn:       'Spawning agent…',
    memory_read:       'Recalling memory…',
    memory_write:      'Saving to memory…',
  };
  return labels[name] ?? 'Working…';
}

function InlineShimmer({ text }: { text: string }) {
  return <span className="inline-shimmer">{text}</span>;
}

export default function ChatPanel({ browserVisible, onToggleBrowser, onHideBrowser, onShowBrowser, calendarOpen, onToggleCalendar, onOpenSettings, onOpenPendingApproval, loadConversationId, replayBuffer }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [shimmerText, setShimmerText] = useState<string>('');
  const [streamMap, setStreamMap] = useState<ToolStreamMap>({});
  const [pendingApprovalRunId, setPendingApprovalRunId] = useState<string | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<RunApproval[]>([]);
  const [pendingHumanRunId, setPendingHumanRunId] = useState<string | null>(null);
  const [pendingHumanInterventions, setPendingHumanInterventions] = useState<RunHumanIntervention[]>([]);
  const [workflowPlanDraft, setWorkflowPlanDraft] = useState('');
  const [isWorkflowPlanStreaming, setIsWorkflowPlanStreaming] = useState(false);
  const [loadedConversationId, setLoadedConversationId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Flat append-only feed — each item appended once, never moved
  const feedRef = useRef<FeedItem[]>([]);
  const assistantMsgIdRef = useRef<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingUpdateRef = useRef(false);
  const isUserScrolledUpRef = useRef(false);
  const replayedBufferRef = useRef<string | null>(null);

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

  const ensureAssistantReplayMessage = useCallback(() => {
    if (assistantMsgIdRef.current) return assistantMsgIdRef.current;
    const assistantId = `assistant-replay-${Date.now()}`;
    assistantMsgIdRef.current = assistantId;
    setMessages(prev => [...prev, {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      isStreaming: true,
    }]);
    setIsStreaming(true);
    setShimmerText('Thinking…');
    return assistantId;
  }, []);

  const handleStreamTextChunk = useCallback((chunk: string) => {
    ensureAssistantReplayMessage();
    setShimmerText('');           // clear shimmer the moment text arrives
    if (chunk.includes('__RESET__')) {
      const lastIdx = feedRef.current.length - 1;
      if (lastIdx >= 0 && feedRef.current[lastIdx].kind === 'text') {
        feedRef.current[lastIdx] = { ...feedRef.current[lastIdx], isStreaming: false } as FeedItem;
      }
      scheduleStreamUpdate();
      return;
    }

    const lastIdx = feedRef.current.length - 1;
    if (lastIdx >= 0 && feedRef.current[lastIdx].kind === 'text') {
      const last = feedRef.current[lastIdx] as { kind: 'text'; text: string; isStreaming?: boolean };
      feedRef.current[lastIdx] = { kind: 'text', text: last.text + chunk, isStreaming: true };
    } else {
      feedRef.current.push({ kind: 'text', text: chunk, isStreaming: true });
    }
    setShimmerText('');
    scheduleStreamUpdate();
  }, [ensureAssistantReplayMessage, scheduleStreamUpdate]);

  const handleThinkingEvent = useCallback((thought: string) => {
    setShimmerText(thought ? 'Thinking…' : '');
    if (thought) autoScroll();
  }, [autoScroll]);

  const handleWorkflowPlanTextEvent = useCallback((chunk: string) => {
    setWorkflowPlanDraft(prev => prev + chunk);
    setIsWorkflowPlanStreaming(true);
    requestAnimationFrame(() => autoScroll());
  }, [autoScroll]);

  const handleWorkflowPlanResetEvent = useCallback(() => {
    setWorkflowPlanDraft('');
    setIsWorkflowPlanStreaming(true);
  }, []);

  const handleWorkflowPlanEndEvent = useCallback(() => {
    setIsWorkflowPlanStreaming(false);
  }, []);

  const handleToolActivityEvent = useCallback((activity: { name: string; status: string; detail?: string }) => {
    ensureAssistantReplayMessage();

    if (activity.status === 'running') {
      // Freeze any in-progress text item so text + shimmer don't interleave
      const lastIdx = feedRef.current.length - 1;
      if (lastIdx >= 0 && feedRef.current[lastIdx].kind === 'text') {
        feedRef.current[lastIdx] = { ...feedRef.current[lastIdx], isStreaming: false } as FeedItem;
      }
      setShimmerText(toolToShimmerLabel(activity.name, activity.detail));
      scheduleStreamUpdate();
      autoScroll();
    } else if (activity.status === 'awaiting_approval') {
      setShimmerText('Waiting for approval…');
      autoScroll();
    } else if (activity.status === 'needs_human') {
      setShimmerText('Needs your input…');
      autoScroll();
    }
    // success / error: no-op — shimmer will be cleared by first text chunk or stream end
  }, [autoScroll, ensureAssistantReplayMessage, scheduleStreamUpdate]);

  const handleToolStreamEvent = useCallback((payload: { toolId: string; toolName: string; chunk: string }) => {
    setStreamMap(prev => {
      const existing = prev[payload.toolId] ?? [];
      const next = existing.length >= 200
        ? [...existing.slice(-199), payload.chunk]
        : [...existing, payload.chunk];
      return { ...prev, [payload.toolId]: next };
    });
  }, []);

  const handleStreamEndEvent = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    flushStreamUpdate();
    if (assistantMsgIdRef.current) {
      const finalFeed = [...feedRef.current].map(item =>
        item.kind === 'text' ? { ...item, isStreaming: false } : item
      ) as FeedItem[];
      setMessages(prev => prev.map(m =>
        m.id === assistantMsgIdRef.current
          ? {
              ...m,
              feed: finalFeed,
              content: finalFeed.filter(i => i.kind === 'text').map(i => (i as any).text).join('\n\n'),
              toolCalls: finalFeed.filter(i => i.kind === 'tool').map(i => (i as any).tool),
              isStreaming: false,
            }
          : m,
      ));
    }
    setIsStreaming(false);
    setShimmerText('');
    assistantMsgIdRef.current = null;
  }, [flushStreamUpdate]);

  useEffect(() => {
    if (!loadConversationId) return;
    const api = (window as any).clawdia;
    if (!api) return;

    // If a replay buffer is provided we're attaching to a live/recently-live
    // process. The buffer is the authoritative source of truth for what happened
    // in the current run — skip loading DB messages (which are incomplete
    // mid-stream) and let the replay effect reconstruct the view.
    if (replayBuffer && replayBuffer.length > 0) {
      replayedBufferRef.current = null;
      assistantMsgIdRef.current = null;
      feedRef.current = [];
      setStreamMap({});
      setWorkflowPlanDraft('');
      setIsWorkflowPlanStreaming(false);
      setIsStreaming(false);
      setShimmerText('');
      setMessages([]);
      setLoadedConversationId(loadConversationId);
      return;
    }

    api.chat.load(loadConversationId).then((result: any) => {
      replayedBufferRef.current = null;
      assistantMsgIdRef.current = null;
      feedRef.current = [];
      setStreamMap({});
      setWorkflowPlanDraft('');
      setIsWorkflowPlanStreaming(false);
      setIsStreaming(false);
      setShimmerText('');
      setMessages(result.messages || []);
      setLoadedConversationId(loadConversationId);
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      });
    }).catch(() => {});
  }, [loadConversationId, replayBuffer]);

  useEffect(() => {
    if (!replayBuffer || replayBuffer.length === 0 || !loadConversationId || loadedConversationId !== loadConversationId) return;
    const replayKey = `${loadConversationId}:${replayBuffer.length}:${JSON.stringify(replayBuffer[replayBuffer.length - 1])}`;
    if (replayedBufferRef.current === replayKey) return;
    replayedBufferRef.current = replayKey;

    feedRef.current = [];
    setStreamMap({});
    setShimmerText('');
    setIsStreaming(true);

    const replay = async () => {
      let sawStreamEnd = false;
      for (const item of replayBuffer) {
        if (item.type === 'chat:stream:text') handleStreamTextChunk(item.data);
        if (item.type === 'chat:workflow-plan:text') handleWorkflowPlanTextEvent(item.data);
        if (item.type === 'chat:workflow-plan:end') handleWorkflowPlanEndEvent();
        if (item.type === 'chat:thinking') handleThinkingEvent(item.data);
        if (item.type === 'chat:tool-activity') handleToolActivityEvent(item.data);
        if (item.type === 'chat:tool-stream') handleToolStreamEvent(item.data);
        if (item.type === 'chat:stream:end') { handleStreamEndEvent(); sawStreamEnd = true; }
      }
      if (assistantMsgIdRef.current) {
        flushStreamUpdate();
      }
      // If the process is still running (no stream:end in buffer), stay in
      // streaming mode so live events continue to render correctly.
      if (!sawStreamEnd && assistantMsgIdRef.current) {
        setIsStreaming(true);
      }
    };

    void replay();
  }, [
    replayBuffer,
    loadConversationId,
    loadedConversationId,
    handleStreamTextChunk,
    handleWorkflowPlanTextEvent,
    handleWorkflowPlanEndEvent,
    handleThinkingEvent,
    handleToolActivityEvent,
    handleToolStreamEvent,
    handleStreamEndEvent,
    flushStreamUpdate,
  ]);

  useEffect(() => {
    const api = (window as any).clawdia;
    if (!api?.process || !api?.run) return;

    const syncPendingApproval = async (processes: ProcessInfo[]) => {
      const attachedProcess = processes.find((proc) => proc.isAttached);

      const attachedBlocked = processes.find((proc) => proc.isAttached && proc.status === 'awaiting_approval');
      if (!attachedBlocked) {
        setPendingApprovalRunId(null);
        setPendingApprovals([]);
        if (!isWorkflowPlanStreaming) setWorkflowPlanDraft('');
      } else {
        setPendingApprovalRunId(attachedBlocked.id);
        const approvals = await api.run.approvals(attachedBlocked.id);
        const pending = (approvals || []).filter((approval: RunApproval) => approval.status === 'pending');
        setPendingApprovals(pending);
        const workflowApproval = pending.find((approval: RunApproval) => approval.actionType === 'workflow_plan');
        if (workflowApproval?.request?.plan) {
          setWorkflowPlanDraft(String(workflowApproval.request.plan));
          setIsWorkflowPlanStreaming(false);
        }
      }

      const attachedNeedsHuman = processes.find((proc) => proc.isAttached && proc.status === 'needs_human');
      if (!attachedNeedsHuman) {
        setPendingHumanRunId(null);
        setPendingHumanInterventions([]);
      } else {
        setPendingHumanRunId(attachedNeedsHuman.id);
        const interventions = await api.run.humanInterventions(attachedNeedsHuman.id);
        setPendingHumanInterventions((interventions || []).filter((item: RunHumanIntervention) => item.status === 'pending'));
      }
    };

    api.process.list().then(syncPendingApproval).catch(() => {});
    const cleanup = api.process.onListChanged((processes: ProcessInfo[]) => {
      syncPendingApproval(processes).catch(() => {});
    });
    return cleanup;
  }, [isWorkflowPlanStreaming]);

  useEffect(() => {
    const api = (window as any).clawdia;
    if (!api) return;
    const cleanups: (() => void)[] = [];

    cleanups.push(api.chat.onStreamText(handleStreamTextChunk));

    cleanups.push(api.chat.onThinking(handleThinkingEvent));
    if (api.chat.onWorkflowPlanText) {
      cleanups.push(api.chat.onWorkflowPlanText(handleWorkflowPlanTextEvent));
    }
    if (api.chat.onWorkflowPlanReset) {
      cleanups.push(api.chat.onWorkflowPlanReset(handleWorkflowPlanResetEvent));
    }
    if (api.chat.onWorkflowPlanEnd) {
      cleanups.push(api.chat.onWorkflowPlanEnd(handleWorkflowPlanEndEvent));
    }

    cleanups.push(api.chat.onToolActivity(handleToolActivityEvent));

    if (api.chat.onToolStream) {
      cleanups.push(api.chat.onToolStream(handleToolStreamEvent));
    }

    cleanups.push(api.chat.onStreamEnd(handleStreamEndEvent));

    return () => {
      cleanups.forEach(fn => fn());
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [handleStreamEndEvent, handleStreamTextChunk, handleThinkingEvent, handleWorkflowPlanResetEvent, handleWorkflowPlanTextEvent, handleWorkflowPlanEndEvent, handleToolActivityEvent, handleToolStreamEvent]);

  const handleSend = useCallback(async (text: string, attachments: MessageAttachment[] = []) => {
    const api = (window as any).clawdia;
    if (!api) return;

    isUserScrolledUpRef.current = false;

    const userMsg: Message = {
      id: `user-${Date.now()}`, role: 'user', content: text, attachments,
      timestamp: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    };
    setMessages(prev => [...prev, userMsg]);
    setTimeout(() => scrollToBottom('smooth'), 50);

    const assistantId = `assistant-${Date.now()}`;
    assistantMsgIdRef.current = assistantId;
    feedRef.current = [];
    setStreamMap({});
    setWorkflowPlanDraft('');
    setIsWorkflowPlanStreaming(false);

    setTimeout(() => {
      setMessages(prev => [...prev, {
        id: assistantId, role: 'assistant', content: '',
        timestamp: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        isStreaming: true,
      }]);
      setIsStreaming(true);
    }, 100);

    try {
      const result = await api.chat.send(text, attachments);

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
      setShimmerText('');
      setWorkflowPlanDraft('');
      setIsWorkflowPlanStreaming(false);
      assistantMsgIdRef.current = null;
      isUserScrolledUpRef.current = false;
      requestAnimationFrame(() => scrollToBottom('smooth'));
    } catch (err: any) {
      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, content: `⚠️ ${err.message || 'Unknown error'}`, isStreaming: false } : m
      ));
      setIsStreaming(false);
      setShimmerText('');
      setWorkflowPlanDraft('');
      setIsWorkflowPlanStreaming(false);
      assistantMsgIdRef.current = null;
    }
  }, [scrollToBottom]);

  const handleStop = useCallback(() => {
    (window as any).clawdia?.chat.stop();
    setIsStreaming(false);
    setIsPaused(false);
    setShimmerText('');
  }, []);

  const handlePause = useCallback(() => {
    (window as any).clawdia?.chat.pause();
    setIsPaused(true);
  }, []);

  const handleResume = useCallback(() => {
    (window as any).clawdia?.chat.resume();
    setIsPaused(false);
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
    requestAnimationFrame(() => scrollToBottom('smooth'));
  }, [scrollToBottom]);

  const handleApprovalDecision = useCallback(async (decision: 'approve' | 'revise' | 'deny') => {
    const api = (window as any).clawdia;
    const approval = pendingApprovals[0];
    if (!api?.run || !approval) return;

    if (decision === 'approve') await api.run.approve(approval.id);
    else if (decision === 'revise') await api.run.revise(approval.id);
    else await api.run.deny(approval.id);

    if (pendingApprovalRunId) {
      const approvals = await api.run.approvals(pendingApprovalRunId);
      const pending = (approvals || []).filter((item: RunApproval) => item.status === 'pending');
      setPendingApprovals(pending);
      const workflowApproval = pending.find((item: RunApproval) => item.actionType === 'workflow_plan');
      if (!workflowApproval) {
        setWorkflowPlanDraft('');
        setIsWorkflowPlanStreaming(false);
      }
    }
  }, [pendingApprovalRunId, pendingApprovals]);

  const handleHumanResume = useCallback(async () => {
    const api = (window as any).clawdia;
    const intervention = pendingHumanInterventions[0];
    if (!api?.run || !intervention) return;

    await api.run.resolveHumanIntervention(intervention.id);

    if (pendingHumanRunId) {
      const interventions = await api.run.humanInterventions(pendingHumanRunId);
      setPendingHumanInterventions((interventions || []).filter((item: RunHumanIntervention) => item.status === 'pending'));
    }
  }, [pendingHumanInterventions, pendingHumanRunId]);

  const handleCancelRun = useCallback(() => {
    (window as any).clawdia?.chat.stop();
    setPendingHumanRunId(null);
    setPendingHumanInterventions([]);
  }, []);

  const workflowPlanApproval = pendingApprovals.find((approval) => approval.actionType === 'workflow_plan');
  const visiblePlanText = workflowPlanApproval?.request?.plan
    ? String(workflowPlanApproval.request.plan)
    : workflowPlanDraft;
  const nonWorkflowApproval = pendingApprovals.find((approval) => approval.actionType !== 'workflow_plan');

  return (
    <div className="flex flex-col h-full">
      <header className="drag-region flex items-center gap-2 px-4 h-[44px] flex-shrink-0 bg-surface-1 border-b border-border-subtle shadow-[inset_0_-1px_6px_rgba(0,0,0,0.2),0_2px_8px_rgba(0,0,0,0.3)] relative z-10">
        <CalendarTrigger open={calendarOpen} onToggle={onToggleCalendar} />
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
          {messages.map(msg =>
            msg.role === 'assistant'
              ? <AssistantMessage key={msg.id} message={msg} streamMap={msg.isStreaming ? streamMap : undefined} shimmerText={msg.isStreaming ? shimmerText : undefined} />
              : <UserMessage key={msg.id} message={msg} />
          )}
          {(visiblePlanText || isWorkflowPlanStreaming) && (
            <WorkflowPlanCard
              planText={visiblePlanText}
              isStreaming={isWorkflowPlanStreaming}
              approval={workflowPlanApproval || null}
              onApprove={() => handleApprovalDecision('approve')}
              onRevise={() => handleApprovalDecision('revise')}
              onDeny={() => handleApprovalDecision('deny')}
              onOpenReview={() => pendingApprovalRunId && onOpenPendingApproval?.(pendingApprovalRunId)}
            />
          )}
          {pendingApprovalRunId && nonWorkflowApproval && (
            <div className="flex justify-start animate-slide-up">
              <div className="max-w-[92%] px-1 py-1 text-text-primary">
                <ApprovalBanner
                  approval={nonWorkflowApproval}
                  onApprove={() => handleApprovalDecision('approve')}
                  onDeny={() => handleApprovalDecision('deny')}
                  onOpenReview={() => onOpenPendingApproval?.(pendingApprovalRunId)}
                />
              </div>
            </div>
          )}
          <div className="h-2" />
        </div>
      </div>

      <SwarmPanel />

      {(() => {
        const terminalLines = Object.values(streamMap).flat();
        return (isStreaming || terminalLines.length > 0) ? (
          <TerminalLogStrip lines={terminalLines} isStreaming={isStreaming} />
        ) : null;
      })()}

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
