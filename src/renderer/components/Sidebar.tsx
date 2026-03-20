import React, { useState, useEffect, useCallback } from 'react';
import type { View } from '../App';
import type { ProcessInfo } from '../../shared/types';

interface SidebarProps {
  activeView: View;
  onViewChange: (view: View) => void;
  onNewChat: () => void;
  onLoadConversation: (conversationId: string, buffer?: Array<{ type: string; data: any }> | null) => void;
  onOpenProcess: (processId: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  activeProcessId?: string | null;
}

interface ConvItem {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

function Spinner() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className="animate-spin text-text-secondary" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" />
    </svg>
  );
}

function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[#FF5061] drop-shadow-[0_0_6px_rgba(255,80,97,0.75)]">
      <polyline points="3 8 7 12 13 4" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-red-400/80">
      <line x1="4" y1="4" x2="12" y2="12" />
      <line x1="12" y1="4" x2="4" y2="12" />
    </svg>
  );
}

function ApprovalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-[#FF5061]">
      <path d="M8 1.75 14 13H2L8 1.75Z" />
      <path d="M8 5.2v3.8" />
      <circle cx="8" cy="11.4" r="0.65" fill="currentColor" stroke="none" />
    </svg>
  );
}

function HumanIcon() {
  return (
    <span className="relative flex h-[14px] w-[14px] items-center justify-center">
      <span className="absolute inline-flex h-full w-full rounded-full border border-white/30 animate-ping opacity-70" />
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="relative text-text-primary">
        <circle cx="8" cy="8" r="6" />
        <path d="M8 4.8v3.6" />
        <circle cx="8" cy="11.5" r="0.65" fill="currentColor" stroke="none" />
      </svg>
    </span>
  );
}

function StatusIcon({ status }: { status: ProcessInfo['status'] }) {
  if (status === 'running') return <Spinner />;
  if (status === 'awaiting_approval') return <ApprovalIcon />;
  if (status === 'needs_human') return <HumanIcon />;
  if (status === 'completed') return <Check />;
  return <XIcon />;
}

function profileLabel(profile?: ProcessInfo['agentProfile']): string | null {
  if (profile === 'filesystem') return 'Filesystem';
  if (profile === 'bloodhound') return 'Bloodhound';
  if (profile === 'general') return 'General';
  return null;
}

function timeAgo(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return 'Now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

function convTimeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(isoDate).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function CollapseIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="15" height="15" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className={`transition-transform duration-200 ${collapsed ? 'rotate-180' : ''}`}
    >
      <polyline points="11 17 6 12 11 7" />
      <polyline points="18 17 13 12 18 7" />
    </svg>
  );
}

// ═══════════════════════════════════
// Collapsed
// ═══════════════════════════════════

function CollapsedSidebar({ onToggle, onNewChat, runningCount }: {
  onToggle: () => void;
  onNewChat: () => void;
  runningCount: number;
}) {
  return (
    <nav className="flex flex-col items-center w-[44px] flex-shrink-0 py-2.5 gap-1.5 bg-surface-0 border-r border-white/[0.06] shadow-[inset_-1px_0_8px_rgba(0,0,0,0.3),2px_0_12px_rgba(0,0,0,0.4)]">
      <button onClick={onToggle} title="Expand sidebar (Ctrl+S)"
        className="no-drag flex items-center justify-center w-8 h-8 rounded-lg text-text-secondary hover:text-text-primary hover:bg-white/[0.06] transition-all cursor-pointer">
        <CollapseIcon collapsed={true} />
      </button>
      <div className="w-5 h-px bg-white/[0.06]" />
      <button onClick={onNewChat} title="New Agent"
        className="no-drag flex items-center justify-center w-8 h-8 rounded-lg text-text-secondary hover:text-text-primary hover:bg-white/[0.06] transition-all cursor-pointer">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      {runningCount > 0 && (
        <div className="relative flex items-center justify-center w-8 h-8" title={`${runningCount} running`}>
          <Spinner />
          {runningCount > 1 && (
            <span className="absolute -top-0.5 -right-0.5 text-[9px] font-bold text-accent bg-surface-0 rounded-full w-3.5 h-3.5 flex items-center justify-center border border-accent/30">
              {runningCount}
            </span>
          )}
        </div>
      )}
    </nav>
  );
}

// ═══════════════════════════════════
// Expanded
// ═══════════════════════════════════

const HISTORY_COLLAPSED_COUNT = 3;
const RECENT_COMPLETED_MAX_AGE_MS = 5 * 60 * 60 * 1000;

export default function Sidebar({
  activeView, onViewChange, onNewChat, onLoadConversation, onOpenProcess,
  collapsed, onToggleCollapse,
}: SidebarProps) {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [conversations, setConversations] = useState<ConvItem[]>([]);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [search, setSearch] = useState('');

  // Load processes
  useEffect(() => {
    const api = (window as any).clawdia;
    if (!api) return;
    api.process.list().then(setProcesses).catch(() => {});
    const cleanup = api.process.onListChanged((updated: ProcessInfo[]) => setProcesses(updated));
    return cleanup;
  }, []);

  // Load conversation history
  const loadHistory = useCallback(async () => {
    const api = (window as any).clawdia;
    if (!api) return;
    try {
      const list = await api.chat.list();
      setConversations(list || []);
    } catch {}
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  // Reload history when view changes back to chat (catches new conversations)
  useEffect(() => {
    if (activeView === 'chat') loadHistory();
  }, [activeView, loadHistory]);

  const handleProcessClick = async (proc: ProcessInfo) => {
    const api = (window as any).clawdia;
    if (!api) return;
    if (proc.status === 'running' || proc.status === 'awaiting_approval' || proc.status === 'needs_human') {
      const result = await api.process.attach(proc.id);
      onLoadConversation(proc.conversationId, result?.buffer || null);
      return;
    }
    onOpenProcess(proc.id);
  };

  const handleDeleteConv = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const api = (window as any).clawdia;
    if (!api) return;
    await api.chat.delete(id);
    setConversations(prev => prev.filter(c => c.id !== id));
  }, []);

  const running = processes.filter(p => p.status === 'running' || p.status === 'awaiting_approval' || p.status === 'needs_human');
  const done = processes.filter(p =>
    p.status !== 'running' &&
    p.status !== 'awaiting_approval' &&
    p.status !== 'needs_human' &&
    (Date.now() - (p.completedAt || p.startedAt)) <= RECENT_COMPLETED_MAX_AGE_MS,
  );
  const recentCompletedConversationIds = new Set(done.map(p => p.conversationId));
  const q = search.toLowerCase();
  const filteredRunning = q ? running.filter(p => p.summary.toLowerCase().includes(q)) : running;
  const filteredDone = q ? done.filter(p => p.summary.toLowerCase().includes(q)) : done;
  const filteredConvs = q
    ? conversations.filter(c =>
        !recentCompletedConversationIds.has(c.id) &&
        c.title.toLowerCase().includes(q),
      )
    : conversations.filter(c => !recentCompletedConversationIds.has(c.id));

  const visibleConvs = historyExpanded ? filteredConvs : filteredConvs.slice(0, HISTORY_COLLAPSED_COUNT);
  const hasMoreHistory = filteredConvs.length > HISTORY_COLLAPSED_COUNT;

  if (collapsed) {
    return <CollapsedSidebar onToggle={onToggleCollapse} onNewChat={onNewChat} runningCount={running.length} />;
  }

  return (
    <nav className="flex flex-col w-[196px] flex-shrink-0 bg-surface-0 border-r border-white/[0.06] shadow-[inset_-1px_0_8px_rgba(0,0,0,0.3),2px_0_12px_rgba(0,0,0,0.4)]">
      {/* Brand + collapse */}
      <div className="drag-region flex items-center justify-between px-3.5 pt-3 pb-3">
        <span className="text-[14px] font-semibold tracking-[0.1em] uppercase text-text-primary/40 select-none">
          Clawdia
        </span>
        <button
          onClick={onToggleCollapse}
          title="Collapse sidebar (Ctrl+S)"
          className="no-drag flex items-center justify-center w-6 h-6 rounded-md text-text-secondary/50 hover:text-text-secondary hover:bg-white/[0.06] transition-all cursor-pointer"
        >
          <CollapseIcon collapsed={false} />
        </button>
      </div>

      {/* Search */}
      <div className="px-2.5 pb-2">
        <div className="relative">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary/40 pointer-events-none">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full h-[30px] pl-8 pr-2 rounded-lg bg-white/[0.04] border border-white/[0.06] text-[13px] text-text-primary placeholder-text-secondary/50 outline-none focus:border-accent/30 focus:bg-white/[0.06] transition-all"
          />
        </div>
      </div>

      {/* New Agent */}
      <div className="px-2.5 pb-2">
        <button
          onClick={onNewChat}
          className="no-drag flex items-center justify-center w-full h-[28px] rounded-lg border border-[#FF5061]/20 text-[13px] font-medium text-text-primary/70 hover:text-[#FF5061]/80 hover:bg-[#FF5061]/[0.04] hover:border-[#FF5061]/40 transition-all cursor-pointer"
        >
          New Agent
        </button>
      </div>

      {/* Agents area */}
      <div className="flex-1 overflow-y-auto px-1.5 pt-0.5 min-h-0">

        {/* Active — only visible when background processes are running */}
        <div className="mb-1">
          <div className="px-2 py-1.5 text-[12px] font-semibold text-text-secondary/60 uppercase tracking-wider">
            Active
          </div>
          {filteredRunning.length > 0 ? (
            filteredRunning.map(proc => (
              <button key={proc.id} onClick={() => handleProcessClick(proc)}
                className={`w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors cursor-pointer border ${
                  proc.status === 'needs_human'
                    ? 'border-white/[0.18] bg-white/[0.05] shadow-[0_0_18px_rgba(255,255,255,0.08)] animate-pulse'
                    : proc.isAttached
                      ? 'border-accent/[0.12] bg-accent/[0.08]'
                      : 'border-transparent hover:bg-white/[0.04]'
                }`}>
                <div className="mt-0.5 flex-shrink-0"><StatusIcon status={proc.status} /></div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-[13px] text-text-primary truncate font-medium">{proc.summary.slice(0, 28)}</span>
                    <span className="text-[11px] text-text-secondary/60 flex-shrink-0">{timeAgo(proc.startedAt)}</span>
                  </div>
                  {(profileLabel(proc.agentProfile) || proc.lastSpecializedTool) && (
                    <div className="flex items-center gap-1.5 mt-1">
                      {profileLabel(proc.agentProfile) && (
                        <span className="px-1.5 py-0.5 rounded bg-white/[0.05] text-[10px] uppercase tracking-wide text-text-secondary">
                          {profileLabel(proc.agentProfile)}
                        </span>
                      )}
                      {proc.lastSpecializedTool && (
                        <span className="text-[10px] text-text-secondary/70 truncate">
                          {proc.lastSpecializedTool}
                        </span>
                      )}
                    </div>
                  )}
                  <div className="text-[12px] text-text-secondary mt-0.5 truncate">
                    {proc.status === 'needs_human'
                      ? 'Needs your attention'
                      : proc.status === 'awaiting_approval'
                      ? 'Waiting for approval'
                      : proc.toolCallCount > 0
                        ? `${proc.toolCallCount} tool${proc.toolCallCount !== 1 ? 's' : ''} used...`
                        : 'Generating...'}
                  </div>
                </div>
              </button>
            ))
          ) : (
            <div className="px-2.5 py-2 text-[12px] text-text-secondary/30">
              No active sessions
            </div>
          )}
        </div>

        <div className="mb-1">
          <div className="px-2 py-1.5 text-[12px] font-semibold text-text-secondary/60 uppercase tracking-wider">
            Recently Completed
          </div>
          {filteredDone.length > 0 ? (
            filteredDone.map(proc => (
              <button key={proc.id} onClick={() => handleProcessClick(proc)}
                className="w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors cursor-pointer border border-transparent hover:bg-white/[0.04]">
                <div className="mt-0.5 flex-shrink-0"><StatusIcon status={proc.status} /></div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-[13px] text-text-primary/70 truncate">{proc.summary.slice(0, 28)}</span>
                    <span className="text-[11px] text-text-secondary/60 flex-shrink-0">{timeAgo(proc.startedAt)}</span>
                  </div>
                  {(profileLabel(proc.agentProfile) || proc.lastSpecializedTool) && (
                    <div className="flex items-center gap-1.5 mt-1">
                      {profileLabel(proc.agentProfile) && (
                        <span className="px-1.5 py-0.5 rounded bg-white/[0.05] text-[10px] uppercase tracking-wide text-text-secondary">
                          {profileLabel(proc.agentProfile)}
                        </span>
                      )}
                      {proc.lastSpecializedTool && (
                        <span className="text-[10px] text-text-secondary/70 truncate">
                          {proc.lastSpecializedTool}
                        </span>
                      )}
                    </div>
                  )}
                  <div className="text-[12px] text-text-secondary mt-0.5 truncate">
                    {proc.status === 'completed' ? `Done · ${proc.toolCallCount} tools`
                      : proc.status === 'failed' ? `Failed: ${proc.error?.slice(0, 20) || 'error'}`
                      : 'Cancelled'}
                  </div>
                </div>
              </button>
            ))
          ) : (
            <div className="px-2.5 py-2 text-[12px] text-text-secondary/30">
              No completed runs yet
            </div>
          )}
        </div>
      </div>

      {/* ─── History ─── pushed to bottom */}
      <div className="flex-1 min-h-0 border-t border-white/[0.04] overflow-y-auto flex flex-col justify-end">
        {filteredConvs.length > 0 && (
          <div>
            <div className="flex items-center justify-between px-3 pt-2 pb-1">
              <span className="text-[12px] font-semibold text-text-secondary/60 uppercase tracking-wider">
                History
              </span>
              {hasMoreHistory && (
                <button
                  onClick={() => setHistoryExpanded(v => !v)}
                  className="text-[11px] text-text-secondary/50 hover:text-text-secondary transition-colors cursor-pointer"
                >
                  {historyExpanded ? 'Show less' : `${filteredConvs.length - HISTORY_COLLAPSED_COUNT} more`}
                </button>
              )}
            </div>

            <div className="px-1.5 pb-1">
              {visibleConvs.map(conv => (
                <div
                  key={conv.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onLoadConversation(conv.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onLoadConversation(conv.id);
                    }
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left hover:bg-white/[0.04] focus:bg-white/[0.04] transition-all cursor-pointer group outline-none"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-text-secondary/40 flex-shrink-0">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[12px] text-text-primary/60 truncate">{conv.title}</span>
                      <span className="text-[11px] text-text-secondary/40 flex-shrink-0">{convTimeAgo(conv.updatedAt)}</span>
                    </div>
                  </div>
                  <button
                    onClick={(e) => handleDeleteConv(conv.id, e)}
                    className="flex-shrink-0 flex items-center justify-center w-5 h-5 rounded opacity-0 group-hover:opacity-40 hover:!opacity-100 hover:bg-red-500/20 hover:text-red-400 transition-all cursor-pointer"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              ))}

              {/* Show more / less chevron */}
              {hasMoreHistory && (
                <button
                  onClick={() => setHistoryExpanded(v => !v)}
                  className="w-full flex items-center justify-center py-1.5 text-text-secondary/40 hover:text-text-secondary/70 transition-colors cursor-pointer"
                  title={historyExpanded ? 'Show less' : `Show ${filteredConvs.length - HISTORY_COLLAPSED_COUNT} more`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                    className={`transition-transform duration-200 ${historyExpanded ? 'rotate-180' : ''}`}>
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        )}
      </div>


    </nav>
  );
}
