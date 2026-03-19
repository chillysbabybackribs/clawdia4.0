import React, { useState } from 'react';
import type { ToolCall } from '../../shared/types';

interface ToolActivityProps {
  tools: ToolCall[];
}

export default function ToolActivity({ tools }: ToolActivityProps) {
  const [expanded, setExpanded] = useState(false);

  if (tools.length === 0) return null;

  const allDone = tools.every(t => t.status === 'success' || t.status === 'error');
  const failCount = tools.filter(t => t.status === 'error').length;

  return (
    <div className="mb-2">
      {/* Summary bar */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="flex items-center gap-2 text-2xs text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer group"
      >
        {allDone ? (
          failCount > 0 ? (
            <div className="w-[6px] h-[6px] rounded-full bg-status-warning" />
          ) : (
            <div className="w-[6px] h-[6px] rounded-full bg-status-success" />
          )
        ) : (
          <div className="w-[6px] h-[6px] rounded-full bg-accent animate-pulse-soft" />
        )}

        <span>
          {tools.length} tool{tools.length > 1 ? 's' : ''} used
        </span>

        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className={`transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="mt-1.5 flex flex-col gap-1 animate-fade-in">
          {tools.map(tool => (
            <div
              key={tool.id}
              className="flex items-center gap-2 py-1 px-2 rounded-md bg-white/[0.02] text-2xs"
            >
              <div className={`flex-shrink-0 ${
                tool.status === 'success' ? 'text-status-success' :
                tool.status === 'error' ? 'text-status-error' :
                'text-accent'
              }`}>
                {tool.status === 'success' ? (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : tool.status === 'error' ? (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                ) : (
                  <div className="w-[11px] h-[11px] rounded-full border-2 border-current border-t-transparent animate-spin" />
                )}
              </div>

              <span className="font-mono text-text-secondary">{tool.name}</span>
              {tool.detail && (
                <span className="text-text-muted truncate">{tool.detail}</span>
              )}
              {tool.durationMs != null && (
                <span className="text-text-muted ml-auto flex-shrink-0">
                  {tool.durationMs < 1000 ? `${tool.durationMs}ms` : `${(tool.durationMs / 1000).toFixed(1)}s`}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
