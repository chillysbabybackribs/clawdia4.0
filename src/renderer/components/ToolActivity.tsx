import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { ToolCall } from '../../shared/types';

// ─── Live Stream Panel ────────────────────────────────────────────────────────

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

// ─── Rating Buttons + Annotation ──────────────────────────────────────────────

const QUICK_NOTES = [
  'unnecessary step',
  'wrong target',
  'too slow — better approach exists',
  'should have used different tool',
  'redundant — already had this data',
];

interface RatingProps {
  tool: ToolCall;
  onRate: (toolId: string, rating: 'up' | 'down' | null, note?: string) => void;
}

function RatingButtons({ tool, onRate }: RatingProps) {
  const [showAnnotation, setShowAnnotation] = useState(false);
  const [customNote, setCustomNote] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleThumbsDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (tool.rating === 'down') {
      // Toggle off
      onRate(tool.id, null);
      setShowAnnotation(false);
    } else {
      // Show annotation picker
      setShowAnnotation(true);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [tool.id, tool.rating, onRate]);

  const handleQuickNote = useCallback((note: string) => {
    onRate(tool.id, 'down', note);
    setShowAnnotation(false);
    setCustomNote('');
  }, [tool.id, onRate]);

  const handleCustomSubmit = useCallback(() => {
    const note = customNote.trim();
    if (note) {
      onRate(tool.id, 'down', note);
      setShowAnnotation(false);
      setCustomNote('');
    }
  }, [tool.id, customNote, onRate]);

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-0.5 ml-1">
        {/* Thumbs up */}
        <button
          onClick={(e) => { e.stopPropagation(); onRate(tool.id, tool.rating === 'up' ? null : 'up'); setShowAnnotation(false); }}
          title="Good tool usage"
          className={`flex items-center justify-center w-5 h-5 rounded transition-all cursor-pointer ${
            tool.rating === 'up'
              ? 'text-status-success bg-status-success/10'
              : 'text-text-muted/0 group-hover:text-text-muted/40 hover:!text-status-success hover:!bg-status-success/10'
          }`}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z" />
            <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
          </svg>
        </button>

        {/* Thumbs down */}
        <button
          onClick={handleThumbsDown}
          title="Bad tool usage — click to annotate"
          className={`flex items-center justify-center w-5 h-5 rounded transition-all cursor-pointer ${
            tool.rating === 'down'
              ? 'text-status-error bg-status-error/10'
              : 'text-text-muted/0 group-hover:text-text-muted/40 hover:!text-status-error hover:!bg-status-error/10'
          }`}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z" />
            <path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" />
          </svg>
        </button>

        {/* Show existing note */}
        {tool.rating === 'down' && tool.ratingNote && !showAnnotation && (
          <span className="text-[9px] text-status-error/60 ml-1 italic truncate max-w-[200px]">{tool.ratingNote}</span>
        )}
      </div>

      {/* Annotation picker — appears below when thumbs down is clicked */}
      {showAnnotation && (
        <div className="mt-1.5 ml-1 p-2 rounded-md bg-black/40 border border-white/[0.08] animate-fade-in" onClick={e => e.stopPropagation()}>
          <div className="text-[9px] text-text-muted mb-1.5">What was wrong?</div>
          <div className="flex flex-wrap gap-1 mb-1.5">
            {QUICK_NOTES.map(note => (
              <button
                key={note}
                onClick={() => handleQuickNote(note)}
                className="px-2 py-0.5 rounded-full text-[9px] bg-white/[0.06] text-text-muted hover:text-text-secondary hover:bg-white/[0.1] transition-colors cursor-pointer"
              >
                {note}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            <input
              ref={inputRef}
              type="text"
              value={customNote}
              onChange={e => setCustomNote(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCustomSubmit(); if (e.key === 'Escape') setShowAnnotation(false); }}
              placeholder="Or type a note..."
              className="flex-1 px-2 py-1 rounded text-[10px] bg-white/[0.04] border border-white/[0.06] text-text-secondary placeholder:text-text-muted/40 outline-none focus:border-white/[0.12]"
            />
            <button
              onClick={handleCustomSubmit}
              disabled={!customNote.trim()}
              className="px-2 py-1 rounded text-[9px] bg-white/[0.06] text-text-muted hover:text-text-secondary disabled:opacity-30 cursor-pointer disabled:cursor-default transition-colors"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Tool Row ─────────────────────────────────────────────────────────────────

interface ToolRowProps {
  tool: ToolCall;
  streamLines: string[];
  messageId?: string;
  onRate?: (toolId: string, rating: 'up' | 'down' | null, note?: string) => void;
}

function ToolRow({ tool, streamLines, messageId, onRate }: ToolRowProps) {
  const isStreaming = tool.status === 'running' && streamLines.length > 0;
  const [manualExpand, setManualExpand] = useState<boolean | null>(null);
  const showStream = manualExpand !== null ? manualExpand : isStreaming;
  const isDone = tool.status === 'success' || tool.status === 'error';

  return (
    <div className="flex flex-col py-1 px-2 rounded-md bg-white/[0.02] text-2xs group">
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

        {/* Static detail */}
        {tool.detail && !showStream && (
          <span className="text-text-muted truncate">{tool.detail}</span>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Rating buttons — only show when tool is done */}
        {isDone && onRate && (
          <RatingButtons tool={tool} onRate={onRate} />
        )}

        {/* Stream toggle */}
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
  messageId?: string;
  onRateTool?: (toolId: string, rating: 'up' | 'down' | null, note?: string) => void;
}

export default function ToolActivity({ tools, streamMap = {}, messageId, onRateTool }: ToolActivityProps) {
  const [expanded, setExpanded] = useState(false);

  if (tools.length === 0) return null;

  const allDone  = tools.every(t => t.status === 'success' || t.status === 'error');
  const failCount = tools.filter(t => t.status === 'error').length;
  const ratedUp = tools.filter(t => t.rating === 'up').length;
  const ratedDown = tools.filter(t => t.rating === 'down').length;

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
          {ratedUp > 0 && <span className="text-status-success ml-1">+{ratedUp}</span>}
          {ratedDown > 0 && <span className="text-status-error ml-1">-{ratedDown}</span>}
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
              messageId={messageId}
              onRate={onRateTool}
            />
          ))}
        </div>
      )}
    </div>
  );
}
