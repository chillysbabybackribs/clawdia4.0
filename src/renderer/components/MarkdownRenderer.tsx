import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownRendererProps {
  content: string;
  isStreaming?: boolean;
}

/**
 * Throttled markdown rendering.
 *
 * Always uses ReactMarkdown (consistent DOM structure), but during streaming
 * we throttle content updates to once per THROTTLE_MS. This prevents expensive
 * re-parses on every chunk while keeping the visual output stable — no jumping
 * between raw text and formatted markdown.
 *
 * On stream end, we do one final render with the complete content.
 */
const THROTTLE_MS = 120;

/** Copy button for code blocks */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-mono bg-white/[0.06] hover:bg-white/[0.12] text-text-muted hover:text-text-secondary transition-all opacity-0 group-hover:opacity-100 cursor-pointer"
    >
      {copied ? (
        <>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
          Copied
        </>
      ) : (
        <>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
          Copy
        </>
      )}
    </button>
  );
}

export default function MarkdownRenderer({ content, isStreaming }: MarkdownRendererProps) {
  if (!content) return null;

  const plugins = useMemo(() => [remarkGfm], []);

  // Throttled content: during streaming, only update every THROTTLE_MS.
  // This reduces ReactMarkdown re-parses from ~30/s to ~8/s while keeping
  // the same DOM structure (no visual jumping).
  const [throttledContent, setThrottledContent] = useState(content);
  const lastUpdateRef = useRef(Date.now());
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestContentRef = useRef(content);

  // Always track the latest content
  latestContentRef.current = content;

  useEffect(() => {
    if (!isStreaming) {
      // Streaming ended — render final content immediately
      if (pendingRef.current) { clearTimeout(pendingRef.current); pendingRef.current = null; }
      setThrottledContent(content);
      return;
    }

    const now = Date.now();
    const elapsed = now - lastUpdateRef.current;

    if (elapsed >= THROTTLE_MS) {
      // Enough time has passed — update now
      lastUpdateRef.current = now;
      setThrottledContent(content);
    } else if (!pendingRef.current) {
      // Schedule an update for when the throttle window expires
      pendingRef.current = setTimeout(() => {
        pendingRef.current = null;
        lastUpdateRef.current = Date.now();
        setThrottledContent(latestContentRef.current);
      }, THROTTLE_MS - elapsed);
    }

    return () => {
      if (pendingRef.current) { clearTimeout(pendingRef.current); pendingRef.current = null; }
    };
  }, [content, isStreaming]);

  return (
    <div className={`markdown-prose ${isStreaming ? 'streaming-cursor' : ''}`}>
      <ReactMarkdown
        remarkPlugins={plugins}
        components={{
          code({ node, className, children, ...props }) {
            const childText = String(children).replace(/\n$/, '');
            const isInline = !className && !childText.includes('\n');

            if (isInline) {
              return <code {...props}>{children}</code>;
            }

            const lang = className?.replace('language-', '') || '';

            return (
              <div className="relative group">
                {lang && (
                  <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/[0.04] bg-white/[0.02]">
                    <span className="text-[10px] font-mono text-text-muted/60 uppercase tracking-wider">{lang}</span>
                  </div>
                )}
                {!isStreaming && <CopyButton text={childText} />}
                <code className={className} {...props}>
                  {children}
                </code>
              </div>
            );
          },

          table({ children }) {
            return (
              <div className="overflow-x-auto rounded-lg">
                <table>{children}</table>
              </div>
            );
          },

          a({ href, children }) {
            return (
              <a
                href={href}
                title={href}
                onClick={(e) => {
                  e.preventDefault();
                  if (href) {
                    (window as any).clawdia?.browser.navigate(href);
                  }
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {throttledContent}
      </ReactMarkdown>
    </div>
  );
}
