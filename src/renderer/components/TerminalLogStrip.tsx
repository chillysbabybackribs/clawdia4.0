import React, { useEffect, useRef, useState } from 'react';

interface TerminalLogStripProps {
  lines: string[];
  isStreaming: boolean;
}

const DIM_RE = /^\[(?:LLM|stderr|Harness|Router|Agent|Install|Setup|Recall|Playbook)\]/i;

function classifyLine(line: string): 'dim' | 'cmd' | 'out' {
  if (DIM_RE.test(line)) return 'dim';
  if (line.startsWith('$') || line.startsWith('>')) return 'cmd';
  return 'out';
}

const LINE_COLORS: Record<'dim' | 'cmd' | 'out', string> = {
  dim: 'rgba(255,255,255,0.25)',
  cmd: 'rgba(255,255,255,0.38)',
  out: 'rgba(255,255,255,0.72)',
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function TerminalLogStrip({ lines, isStreaming: _ }: TerminalLogStripProps) {
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll expanded content when new lines arrive
  useEffect(() => {
    if (expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, expanded]);

  if (lines.length === 0) return null;

  return (
    <div
      className="terminal-log-strip"
      style={{
        borderTop: '1px solid rgba(255,255,255,0.07)',
        background: '#080a0f',
        flexShrink: 0,
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded(e => !e)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setExpanded(v => !v); }}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 14px',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <span style={{
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          fontSize: '12px',
          color: 'rgba(255,255,255,0.32)',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
        }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          terminal log
        </span>
        <span style={{
          color: 'rgba(255,255,255,0.25)',
          fontSize: '12px',
          lineHeight: '1',
          transition: 'transform 0.2s',
          transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
          display: 'inline-block',
        }}>
          &#8964;
        </span>
      </div>

      {expanded && (
        <div
          ref={scrollRef}
          style={{
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            fontSize: '12px',
            lineHeight: '1.55',
            padding: '0 14px 8px',
            borderTop: '1px solid rgba(255,255,255,0.04)',
            maxHeight: '120px',
            overflowY: 'auto',
          }}
        >
          {lines.map((line, i) => {
            const kind = classifyLine(line);
            // Slightly dimmer in collapsed-expanded view
            const color = kind === 'out' ? 'rgba(255,255,255,0.65)'
              : kind === 'cmd' ? 'rgba(255,255,255,0.30)'
              : 'rgba(255,255,255,0.20)';
            return (
              <div key={i} style={{ color }}>{line}</div>
            );
          })}
        </div>
      )}
    </div>
  );
}
