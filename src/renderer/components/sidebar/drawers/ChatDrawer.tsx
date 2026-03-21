import React, { useState, useEffect, useCallback } from 'react';
import type { ProcessInfo } from '../../../../shared/types';

interface ConvItem {
  id: string;
  title: string;
  updatedAt: string;
}

interface ChatDrawerProps {
  onNewChat: () => void;
  onLoadConversation: (id: string, buffer?: any[] | null) => void;
  onOpenProcess: (id: string) => void;
  chatKey: number;
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

function StatusDot({ status }: { status: ProcessInfo['status'] }) {
  if (status === 'running') {
    return <span className="w-[7px] h-[7px] rounded-full bg-accent flex-shrink-0 shadow-[0_0_5px_rgba(255,80,97,0.5)]" />;
  }
  if (status === 'awaiting_approval' || status === 'needs_human') {
    return <span className="w-[7px] h-[7px] rounded-full bg-[#e8a020] flex-shrink-0 shadow-[0_0_5px_rgba(232,160,32,0.4)]" />;
  }
  return <span className="w-[7px] h-[7px] rounded-full bg-[#1e1e2e] flex-shrink-0" />;
}

export default function ChatDrawer({ onNewChat, onLoadConversation, onOpenProcess, chatKey }: ChatDrawerProps) {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [conversations, setConversations] = useState<ConvItem[]>([]);
  const [search, setSearch] = useState('');

  const api = (window as any).clawdia;

  // Load processes
  useEffect(() => {
    if (!api) return;
    api.process.list().then(setProcesses).catch(() => {});
    return api.process.onListChanged(setProcesses);
  }, []);

  // Load conversations — refresh when chatKey changes
  const loadConvs = useCallback(async () => {
    if (!api) return;
    try { setConversations(await api.chat.list() || []); } catch {}
  }, []);

  useEffect(() => { loadConvs(); }, [loadConvs, chatKey]);

  const handleDeleteConv = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!api) return;
    await api.chat.delete(id);
    setConversations(prev => prev.filter(c => c.id !== id));
  };

  const handleProcessClick = async (proc: ProcessInfo) => {
    if (!api) return;
    if (['running', 'awaiting_approval', 'needs_human'].includes(proc.status)) {
      const result = await api.process.attach(proc.id);
      onLoadConversation(proc.conversationId, result?.buffer || null);
    } else {
      onOpenProcess(proc.id);
    }
  };

  const active = processes.filter(p => ['running', 'awaiting_approval', 'needs_human'].includes(p.status));
  const q = search.toLowerCase();
  const filteredActive = q ? active.filter(p => p.summary.toLowerCase().includes(q)) : active;
  const filteredConvs = q ? conversations.filter(c => c.title.toLowerCase().includes(q)) : conversations;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-[#141420] flex-shrink-0">
        <span className="text-[11px] font-semibold text-text-primary">Conversations</span>
        <button
          onClick={onNewChat}
          className="no-drag text-[10px] text-accent border border-accent/20 bg-accent/[0.06] rounded px-2 py-0.5 hover:bg-accent/10 transition-colors cursor-pointer"
        >
          + New
        </button>
      </div>

      {/* Search */}
      <div className="px-2.5 py-2 flex-shrink-0">
        <div className="relative">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary/40 pointer-events-none">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full h-[26px] pl-7 pr-2 rounded bg-white/[0.04] border border-[#1a1a2a] text-[11px] text-text-primary placeholder-text-secondary/40 outline-none focus:border-accent/30 transition-all"
          />
        </div>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto min-h-0 scrollbar-thin">
        {/* Active */}
        {filteredActive.length > 0 && (
          <div className="mb-1">
            <div className="px-3 py-1.5 text-[9px] font-semibold text-text-secondary/40 uppercase tracking-wider">Active</div>
            {filteredActive.map(proc => (
              <button key={proc.id} onClick={() => handleProcessClick(proc)}
                className="no-drag w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.04] transition-colors cursor-pointer">
                <StatusDot status={proc.status} />
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] text-text-primary truncate">{proc.summary.slice(0, 30)}</div>
                  <div className="text-[9px] text-text-secondary/50 mt-0.5">{timeAgo(proc.startedAt)}</div>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* History */}
        {filteredConvs.length > 0 && (
          <div>
            <div className="px-3 py-1.5 text-[9px] font-semibold text-text-secondary/40 uppercase tracking-wider">History</div>
            {filteredConvs.map(conv => (
              <div key={conv.id} role="button" tabIndex={0}
                onClick={() => onLoadConversation(conv.id)}
                onKeyDown={e => { if (e.key === 'Enter') onLoadConversation(conv.id); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/[0.04] transition-colors cursor-pointer group outline-none">
                <span className="w-[4px] h-[4px] rounded-full bg-[#1e1e2e] flex-shrink-0" />
                <span className="flex-1 text-[11px] text-text-secondary/60 truncate">{conv.title}</span>
                <span className="text-[9px] text-text-secondary/30 flex-shrink-0">{convTimeAgo(conv.updatedAt)}</span>
                <button
                  onClick={e => handleDeleteConv(conv.id, e)}
                  className="flex-shrink-0 w-4 h-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-40 hover:!opacity-100 hover:bg-red-500/20 hover:text-red-400 transition-all cursor-pointer"
                >
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {filteredActive.length === 0 && filteredConvs.length === 0 && (
          <div className="px-3 py-4 text-[11px] text-text-secondary/30 text-center">
            {search ? 'No results' : 'No conversations yet'}
          </div>
        )}
      </div>
    </div>
  );
}
