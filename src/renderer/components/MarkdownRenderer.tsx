import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownRendererProps {
  content: string;
  isStreaming?: boolean;
}

/**
 * Enterprise-grade markdown renderer.
 * During streaming: renders markdown live with a blinking cursor.
 * After streaming: full GFM rendering with tables, code blocks, lists.
 */
export default function MarkdownRenderer({ content, isStreaming }: MarkdownRendererProps) {
  if (!content) return null;

  // Memoize the remarkPlugins array so it's stable across renders
  const plugins = useMemo(() => [remarkGfm], []);

  return (
    <div className={`markdown-prose ${isStreaming ? 'streaming-cursor' : ''}`}>
      <ReactMarkdown
        remarkPlugins={plugins}
        components={{
          // Custom code block with copy-ready styling
          code({ node, className, children, ...props }) {
            const isInline = !className && typeof children === 'string' && !children.includes('\n');
            if (isInline) {
              return <code {...props}>{children}</code>;
            }
            const lang = className?.replace('language-', '') || '';
            return (
              <div className="relative group">
                {lang && (
                  <div className="absolute top-0 right-0 px-2.5 py-1 text-[10px] font-mono text-text-muted/50 uppercase tracking-wider">
                    {lang}
                  </div>
                )}
                <code className={className} {...props}>
                  {children}
                </code>
              </div>
            );
          },
          // Clean table wrapper for horizontal scrolling
          table({ children }) {
            return (
              <div className="overflow-x-auto rounded-lg">
                <table>{children}</table>
              </div>
            );
          },
          // Links open externally
          a({ href, children }) {
            return (
              <a href={href} title={href} onClick={(e) => {
                e.preventDefault();
                // Could wire to browser panel navigation here
              }}>
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
