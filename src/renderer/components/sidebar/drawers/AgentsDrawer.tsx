import React, { useState, useEffect } from 'react';
import type { ProcessInfo } from '../../../../shared/types';

interface AgentsDrawerProps {
  onNewChat: () => void;
  onOpenProcess: (id: string) => void;
}

const RECENT_MAX_AGE_MS = 5 * 60 * 60 * 1000;

const PROFILES = [
  { cmd: '/bloodhound', desc: 'web automation' },
  { cmd: '/filesystem', desc: 'file operations' },
  { cmd: '/ytdlp', desc: 'download media' },
  { cmd: '/general', desc: 'full capabilities' },
];

function timeAgo(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return 'Now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

function StatusDot({ status }: { status: ProcessInfo['status'] }) {
  if (status === 'running') {
    return <span className="w-[7px] h-[7px] rounded-full bg-accent flex-shrink-0 mt-[5px] shadow-[0_0_5px_rgba(255,80,97,0.5)]" />;
  }
  if (status === 'awaiting_approval' || status === 'needs_human') {
    return <span className="w-[7px] h-[7px] rounded-full bg-[#e8a020] flex-shrink-0 mt-[5px] shadow-[0_0_5px_rgba(232,160,32,0.4)]" />;
  }
  return <span className="w-[7px] h-[7px] rounded-full bg-[#3a6644] flex-shrink-0 mt-[5px]" />;
}

export default function AgentsDrawer({ onNewChat, onOpenProcess }: AgentsDrawerProps) {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const api = (window as any).clawdia;

  useEffect(() => {
    if (!api) return;
    api.process.list().then(setProcesses).catch(() => {});
    return api.process.onListChanged(setProcesses);
  }, []);

  const prefillInput = (cmd: string) => {
    window.dispatchEvent(new CustomEvent('clawdia:prefill-input', { detail: cmd }));
  };

  const handleCancel = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!api) return;
    await api.process.cancel(id).catch(() => {});
  };

  const running = processes.filter(p => ['running', 'awaiting_approval', 'needs_human'].includes(p.status));
  const completedToday = processes.filter(p =>
    !['running', 'awaiting_approval', 'needs_human'].includes(p.status) &&
    (Date.now() - (p.completedAt || p.startedAt)) <= RECENT_MAX_AGE_MS
  );

  const totalCount = processes.length;
  const todayCount = processes.filter(p => {
    const ts = p.completedAt || p.startedAt;
    return Date.now() - ts < 86400000;
  }).length;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-border flex-shrink-0">
        <span className="text-[11px] font-semibold text-text-primary">Agents</span>
        <button onClick={onNewChat}
          className="no-drag text-[10px] text-accent border border-accent/20 bg-accent/[0.06] rounded px-2 py-0.5 hover:bg-accent/10 transition-colors cursor-pointer">
          + Spawn
        </button>
      </div>

      {/* New agent button */}
      <div className="px-2.5 py-2 flex-shrink-0">
        <button onClick={onNewChat}
          className="no-drag w-full py-1.5 rounded-lg bg-accent/[0.08] border border-accent/20 text-[11px] font-semibold text-accent hover:bg-accent/[0.12] transition-colors cursor-pointer">
          + New Agent
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto min-h-0">

        {/* Running */}
        <div className="px-3 py-1.5 text-[9px] font-semibold text-text-tertiary uppercase tracking-wider">
          Running {running.length > 0 && `(${running.length})`}
        </div>
        {running.length === 0 && (
          <div className="px-3 pb-2 text-[11px] text-text-muted">No active agents</div>
        )}
        {running.map(proc => (
          <div key={proc.id} className="flex items-start gap-2 px-3 py-2 hover:bg-border-subtle transition-colors group">
            <StatusDot status={proc.status} />
            <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onOpenProcess(proc.id)}>
              <div className="text-[11px] text-text-primary truncate">{proc.summary.slice(0, 30)}</div>
              <div className="text-[9px] text-text-tertiary mt-0.5">
                {proc.agentProfile && <span className="mr-1.5 uppercase">{proc.agentProfile}</span>}
                {timeAgo(proc.startedAt)} · {proc.toolCallCount} tools
              </div>
            </div>
            <button
              onClick={e => proc.status === 'needs_human' ? onOpenProcess(proc.id) : handleCancel(e, proc.id)}
              className="no-drag flex-shrink-0 text-[10px] text-text-muted hover:text-text-secondary transition-colors cursor-pointer mt-0.5"
            >
              {proc.status === 'needs_human' ? '→' : '✕'}
            </button>
          </div>
        ))}

        <div className="h-px bg-surface-1 my-1" />

        {/* Profiles */}
        <div className="px-3 py-1.5 text-[9px] font-semibold text-text-tertiary uppercase tracking-wider">Profiles</div>
        {PROFILES.map(({ cmd, desc }) => (
          <button key={cmd} onClick={() => prefillInput(cmd)}
            className="no-drag w-full flex items-center gap-2 px-3 py-1.5 hover:bg-border-subtle transition-colors cursor-pointer text-left">
            <span className="text-[10px] text-accent font-mono font-semibold flex-shrink-0">{cmd}</span>
            <span className="text-[10px] text-text-tertiary">{desc}</span>
          </button>
        ))}

        {completedToday.length > 0 && (
          <>
            <div className="h-px bg-surface-1 my-1" />
            <div className="px-3 py-1.5 text-[9px] font-semibold text-text-tertiary uppercase tracking-wider">Completed Today</div>
            {completedToday.map(proc => (
              <button key={proc.id} onClick={() => onOpenProcess(proc.id)}
                className="no-drag w-full flex items-center gap-2 px-3 py-1.5 hover:bg-border-subtle transition-colors cursor-pointer">
                <span className="w-[7px] h-[7px] rounded-full bg-[#3a6644] flex-shrink-0" />
                <span className="flex-1 text-[11px] text-text-secondary truncate">{proc.summary.slice(0, 30)}</span>
                <span className="text-[9px] text-text-muted flex-shrink-0">{timeAgo(proc.completedAt || proc.startedAt)}</span>
              </button>
            ))}
          </>
        )}
      </div>

      {/* Stats bar */}
      <div className="flex border-t border-border flex-shrink-0">
        {[
          { val: running.length, key: 'Running' },
          { val: todayCount, key: 'Today' },
          { val: totalCount, key: 'Total' },
        ].map(({ val, key }, i) => (
          <div key={key} className={`flex-1 py-1.5 text-center ${i < 2 ? 'border-r border-border' : ''}`}>
            <div className="text-[12px] font-semibold text-text-secondary">{val}</div>
            <div className="text-[8px] text-text-muted uppercase tracking-wide">{key}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
