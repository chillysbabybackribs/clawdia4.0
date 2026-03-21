import React, { useEffect, useState } from 'react';
import type { SwarmState, SwarmAgent, SwarmAgentStatus } from '../../shared/types';

const STATUS_ICON: Record<SwarmAgentStatus, string> = {
  queued:    '⏳',
  running:   '🔄',
  done:      '✅',
  failed:    '❌',
  cancelled: '🚫',
};

const ROLE_ICON: Record<string, string> = {
  coordinator: '🧠', scout: '🔍', builder: '🔨', analyst: '📊',
  writer: '✍️', reviewer: '🔎', data: '🗄️', devops: '⚙️',
  security: '🛡️', synthesizer: '🔗', general: '🤖',
};

function AgentRow({ agent }: { agent: SwarmAgent }) {
  const durationMs = agent.completedAt && agent.startedAt
    ? agent.completedAt - agent.startedAt
    : agent.startedAt ? Date.now() - agent.startedAt : null;
  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-white/[0.04] last:border-0">
      <span className="text-sm w-5 flex-shrink-0">{STATUS_ICON[agent.status]}</span>
      <span className="text-sm w-5 flex-shrink-0">{ROLE_ICON[agent.role] ?? '🤖'}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-text-primary capitalize">{agent.role}</span>
          {agent.status === 'running' && (
            <span className="text-[10px] text-blue-400 animate-pulse">working…</span>
          )}
          {durationMs !== null && agent.status === 'done' && (
            <span className="text-[10px] text-text-muted">{(durationMs / 1000).toFixed(1)}s</span>
          )}
          {agent.toolCallCount > 0 && (
            <span className="text-[10px] text-text-muted">{agent.toolCallCount} calls</span>
          )}
        </div>
        <div className="text-[11px] text-text-muted truncate">{agent.goal}</div>
        {agent.error && (
          <div className="text-[11px] text-red-400 truncate">{agent.error}</div>
        )}
      </div>
    </div>
  );
}

export default function SwarmPanel() {
  const [swarm, setSwarm] = useState<SwarmState | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const off = window.clawdia.swarm.onStateChanged((state: SwarmState) => {
      setSwarm(state);
      setExpanded(true);
      // Auto-collapse 4s after completion
      if (state.completedAt) {
        setTimeout(() => setExpanded(false), 4000);
        setTimeout(() => setSwarm(null), 8000);
      }
    });
    return off;
  }, []);

  if (!swarm) return null;

  const done = swarm.agents.filter(a => a.status === 'done' || a.status === 'failed' || a.status === 'cancelled').length;
  const running = swarm.agents.filter(a => a.status === 'running').length;
  const pct = Math.round((done / swarm.totalAgents) * 100);
  const isComplete = !!swarm.completedAt;

  return (
    <div className="mx-3 mb-2 rounded-xl border border-white/[0.08] bg-white/[0.025] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] overflow-hidden">
      {/* Header bar */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-3 px-3 py-2 hover:bg-white/[0.03] transition-colors cursor-pointer"
      >
        <span className="text-sm">⚡</span>
        <span className="text-[12px] font-medium text-text-primary flex-1 text-left">
          {isComplete
            ? `Swarm complete — ${swarm.totalAgents} agents`
            : `Running ${running} agent${running !== 1 ? 's' : ''} of ${swarm.totalAgents}`}
        </span>
        {/* Progress bar */}
        <div className="w-24 h-1.5 rounded-full bg-white/[0.08] overflow-hidden">
          <div
            className="h-full rounded-full bg-blue-500 transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="text-[11px] text-text-muted w-8 text-right">{pct}%</span>
        <span className="text-[11px] text-text-muted">{expanded ? '▲' : '▼'}</span>
      </button>

      {/* Expanded agent list */}
      {expanded && (
        <div className="px-3 pb-2 max-h-64 overflow-y-auto">
          {swarm.agents.map(agent => (
            <AgentRow key={agent.id} agent={agent} />
          ))}
        </div>
      )}
    </div>
  );
}
