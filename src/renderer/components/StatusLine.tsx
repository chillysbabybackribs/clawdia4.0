import React, { useState, useEffect, useRef } from 'react';

interface StatusLineProps {
  /** Current status text. Empty string = hidden. */
  text: string;
}

/**
 * Enterprise-grade single-line status indicator with shimmer animation.
 * Shows one line at a time — new text crossfades in, old fades out.
 * Fixed height so the chat never jumps.
 */
export default function StatusLine({ text }: StatusLineProps) {
  const [displayText, setDisplayText] = useState('');
  const [isVisible, setIsVisible] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    if (text) {
      if (!displayText) {
        // First appearance — fade in immediately
        setDisplayText(text);
        setIsVisible(true);
      } else if (text !== displayText) {
        // Crossfade: fade out old, then fade in new
        setIsTransitioning(true);
        timeoutRef.current = setTimeout(() => {
          setDisplayText(text);
          setIsTransitioning(false);
        }, 150); // Match the CSS transition duration
      }
    } else {
      // Hide — fade out
      setIsVisible(false);
      timeoutRef.current = setTimeout(() => {
        setDisplayText('');
        setIsTransitioning(false);
      }, 300);
    }

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [text]);

  // Don't render anything if no text and fully hidden
  if (!displayText && !text) return null;

  return (
    <div className="status-line-container h-[28px] flex items-center px-1 overflow-hidden">
      <div
        className={`
          status-line flex items-center gap-2
          transition-all duration-200 ease-out
          ${isVisible && !isTransitioning ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-[4px]'}
        `}
      >
        {/* Shimmer dot */}
        <div className="status-shimmer-dot" />

        {/* Text with shimmer effect */}
        <span className="status-shimmer-text text-[12px] tracking-wide">
          {displayText}
        </span>
      </div>
    </div>
  );
}
