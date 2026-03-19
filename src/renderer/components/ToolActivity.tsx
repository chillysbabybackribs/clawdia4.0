import React, { useState, useRef, useEffect } from 'react';
import type { ToolCall } from '../../shared/types';

export interface ToolStreamMap {
  [toolId: string]: string[];
}

interface ToolActivityProps {
  tools: ToolCall[];
  streamMap?: ToolStreamMap;
  messageId?: string;
  onRateTool?: (toolId: string, rating: 'up' | 'down' | null, note?: string) => void;
}

// ═══════════════════════════════════
// Friendly headers
// ═══════════════════════════════════

function toolHeader(tool: ToolCall): string {
  const d = tool.detail || '';
  switch (tool.name) {
    case 'shell_exec': return `Ran command: ${d.split(/\s+/).filter(w => !w.startsWith('-') && !w.startsWith('/') && !w.startsWith('"') && !w.startsWith("'") && w.length > 1).slice(0, 3).join(', ') || d.slice(0, 40)}`;
    case 'file_read': return `Read file: ${d.split('/').pop() || d}`;
    case 'file_write': return `Wrote file: ${d.split('/').pop() || d}`;
    case 'file_edit': return `Edited file: ${d.split('/').pop() || d}`;
    case 'directory_tree': return `Listed: ${d || 'directory'}`;
    case 'browser_search': return `Searched: ${d}`;
    case 'browser_navigate': return `Navigated: ${d.replace(/^https?:\/\//, '').slice(0, 40)}`;
    case 'browser_read_page': return 'Read page content';
    case 'browser_click': return `Clicked: ${d}`;
    case 'browser_type': return `Typed: ${d}`;
    case 'browser_extract': return `Extracted: ${d.slice(0, 40)}`;
    case 'browser_screenshot': return 'Took screenshot';
    case 'browser_scroll': return `Scrolled ${d}`;
    case 'create_document': return `Created: ${d}`;
    case 'memory_search': return `Memory search: ${d}`;
    case 'memory_store': return `Stored: ${d}`;
    case 'recall_context': return 'Recalled context';
    case 'app_control': return `App: ${d}`;
    case 'gui_interact': return `GUI: ${d}`;
    case 'dbus_control': return `DBus: ${d}`;
    default: return `${tool.name}: ${d.slice(0, 40)}`;
  }
}

/** Format the detail as a terminal-style command line */
function commandLine(tool: ToolCall): string | null {
  if (tool.name === 'shell_exec' && tool.detail) return tool.detail;
  if (tool.name === 'file_read' && tool.detail) return `cat ${tool.detail}`;
  if (tool.name === 'file_write' && tool.detail) return `write → ${tool.detail}`;
  if (tool.name === 'file_edit' && tool.detail) return `edit → ${tool.detail}`;
  if (tool.name === 'directory_tree' && tool.detail) return `tree ${tool.detail}`;
  if (tool.name === 'browser_search' && tool.detail) return `search ${tool.detail}`;
  if (tool.name === 'browser_navigate' && tool.detail) return `navigate ${tool.detail}`;
  return null;
}

// ═══════════════════════════════════
// Single Tool Card
// ═══════════════════════════════════

function ToolCard({ tool, streamLines }: { tool: ToolCall; streamLines: string[] }) {
  const isRunning = tool.status === 'running';
  const hasOutput = streamLines.length > 0;
  const [expanded, setExpanded] = useState(true); // Start expanded
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll while running
  useEffect(() => {
    if (isRunning && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [streamLines.length, isRunning]);

  const cmd = commandLine(tool);
  const header = toolHeader(tool);

  return (
    <div className="rounded-lg bg-[#0f0f13] border border-white/[0.06] overflow-hidden">
      {/* Header */}
      <div
        onClick={() => hasOutput && setExpanded(v => !v)}
        className={`flex items-center gap-2 px-3 py-2 ${hasOutput ? 'cursor-pointer hover:bg-white/[0.02]' : ''} transition-colors`}
      >
        {/* Status */}
        {isRunning ? (
          <div className="w-3 h-3 rounded-full border-[1.5px] border-[#8ab4f8] border-t-transparent animate-spin flex-shrink-0" />
        ) : tool.status === 'success' ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2.5" strokeLinecap="round" className="flex-shrink-0">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        )}

        {/* Header text */}
        <span className="text-[13px] text-text-primary/80 font-medium truncate">{header}</span>

        <div className="flex-1" />

        {/* Status label for running */}
        {isRunning && (
          <span className="text-[11px] text-[#8ab4f8]/60 flex-shrink-0">running</span>
        )}

        {/* Chevron */}
        {hasOutput && !isRunning && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
            className={`text-text-secondary/40 transition-transform duration-150 flex-shrink-0 ${expanded ? 'rotate-180' : ''}`}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </div>

      {/* Terminal output area */}
      {expanded && (cmd || hasOutput) && (
        <div className="border-t border-white/[0.04]">
          <div
            ref={scrollRef}
            className="max-h-[160px] overflow-y-auto px-3 py-2 font-mono text-[12px] leading-[1.55]"
          >
            {/* Command line */}
            {cmd && (
              <div className="text-text-secondary/90 mb-1">
                <span className="text-text-secondary/50 select-none">$ </span>
                <span className="font-semibold text-text-primary/70">{
                  // Bold the first word (the command)
                  (() => {
                    const parts = cmd.split(/\s+/);
                    const first = parts[0];
                    const rest = parts.slice(1).join(' ');
                    return (
                      <>
                        <span className="text-text-primary/90">{first}</span>
                        {rest && <span className="text-text-secondary/70"> {rest.length > 80 ? rest.slice(0, 77) + ' …' : rest}</span>}
                      </>
                    );
                  })()
                }</span>
              </div>
            )}

            {/* Stream output */}
            {hasOutput && (
              <div className="text-text-secondary/60 whitespace-pre-wrap break-all">
                {streamLines.join('')}
              </div>
            )}
          </div>

          {/* Bottom chevron for long output */}
          {hasOutput && !isRunning && (
            <button
              onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
              className="w-full flex items-center justify-center py-1 border-t border-white/[0.03] text-text-secondary/30 hover:text-text-secondary/60 transition-colors cursor-pointer"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
                className={`transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`}>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════
// Main Export
// ═══════════════════════════════════

export default function ToolActivity({ tools, streamMap = {} }: ToolActivityProps) {
  if (tools.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {tools.map(tool => (
        <ToolCard
          key={tool.id}
          tool={tool}
          streamLines={streamMap[tool.id] ?? []}
        />
      ))}
    </div>
  );
}
