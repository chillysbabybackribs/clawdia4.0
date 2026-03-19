import React, { useState, useRef, useEffect } from 'react';
import type { ToolCall } from '../../shared/types';

interface ToolActivityProps {
  tools: ToolCall[];
}

// ─── Live Stream Panel ────────────────────────────────────────────────────────
// Shown inline for a single running tool that has stdout chunks.
// Auto-scrolls to bottom; keeps last 200 lines to avoid memory blowup.

const MAX_STREAM_LINES = 200;

interface StreamPanelProps {
  lines: string[];
}

function StreamPanel({ lines }: StreamPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [lines.length]);

  if (lines.length === 0) return null;

  return (
    <div className="mt-1 rounded-md bg-black/30 border border-white/[0.06] overflow-hidden">
      <div className="max-h-[180px] overflow-y-auto px-2 py-1.5 font-mono text-[10px] leading-[1.5] text-text-muted/80 whitespace-pre-wrap break-all">
        {lines.join('')}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ─── Tool Row ─────────────────────────────────────────────────────────────────

interface ToolRowProps {
  tool: ToolCall;
  streamLines: string[];
}

function ToolRow({ tool, streamLines }: ToolRowProps) {
  // Expand automatically while streaming; collapse once done
  const isStreaming = tool.status === 'running' && streamLines.length > 0;
  const [manualExpand, setManualExpand] = useState<boolean | null>(null);
  const showStream = manualExpand !== null ? manualExpand : isStreaming;

  return (
    <div className="flex flex-col py-1 px-2 rounded-md bg-white/[0.02] text-2xs">
      {/* Header row */}
      <div className="flex items-center gap-2">
        {/* Status icon */}
        <div className={`flex-shrink-0 ${
          tool.status === 'success' ? 'text-status-success' :
          tool.status === 'error'   ? 'text-status-error'   :
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

        {/* Tool name */}
        <span className="font-mono text-text-secondary">{tool.name}</span>

        {/* Static detail (command summary) */}
        {tool.detail && !showStream && (
          <span className="text-text-muted truncate">{tool.detail}</span>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Stream toggle — only when there's output */}
        {streamLines.length > 0 && (
          <button
            onClick={() => setManualExpand(v => v === null ? !isStreaming : !v)}
            className="text-text-muted hover:text-text-secondary transition-colors flex items-center gap-0.5"
            title={showStream ? 'Hide output' : 'Show output'}
          >
            <svg
              width="9" height="9" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.5"
              className={`transition-transform duration-150 ${showStream ? 'rotate-180' : ''}`}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        )}

        {/* Duration */}
        {tool.durationMs != null && (
          <span className="text-text-muted flex-shrink-0">
            {tool.durationMs < 1000 ? `${tool.durationMs}ms` : `${(tool.durationMs / 1000).toFixed(1)}s`}
          </span>
        )}
      </div>

      {/* Live stream output */}
      {showStream && <StreamPanel lines={streamLines} />}
    </div>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export interface ToolStreamMap {
  [toolId: string]: string[];
}

interface ToolActivityProps {
  tools: ToolCall[];
  streamMap?: ToolStreamMap;
}

export default function ToolActivity({ tools, streamMap = {} }: ToolActivityProps) {
  const [expanded, setExpanded] = useState(false);

  if (tools.length === 0) return null;

  const allDone  = tools.every(t => t.status === 'success' || t.status === 'error');
  const failCount = tools.filter(t => t.status === 'error').length;

  return (
    <div className="mb-2">
      {/* Summary bar */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="flex items-center gap-2 text-2xs text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer group"
      >
        {allDone ? (
          failCount > 0
            ? <div className="w-[6px] h-[6px] rounded-full bg-status-warning" />
            : <div className="w-[6px] h-[6px] rounded-full bg-status-success" />
        ) : (
          <div className="w-[6px] h-[6px] rounded-full bg-accent animate-pulse-soft" />
        )}

        <span>
          {tools.length} tool{tools.length > 1 ? 's' : ''} used
        </span>

        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.5"
          className={`transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="mt-1.5 flex flex-col gap-1 animate-fade-in">
          {tools.map(tool => (
            <ToolRow
              key={tool.id}
              tool={tool}
              streamLines={streamMap[tool.id] ?? []}
            />
          ))}
        </div>
      )}
    </div>
  );
}
