import React, { useState, useRef, useEffect, useCallback } from 'react';

export default function BrowserPanel() {
  const [urlInput, setUrlInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [currentUrl, setCurrentUrl] = useState('');
  const [currentTitle, setCurrentTitle] = useState('');
  const viewportRef = useRef<HTMLDivElement>(null);

  // ── Report viewport bounds to main process ──
  // The BrowserView (native Chromium surface) needs exact pixel coordinates
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const updateBounds = () => {
      const rect = el.getBoundingClientRect();
      (window as any).clawdia?.browser.setBounds({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    };

    // Initial bounds
    updateBounds();

    // Track resizes
    const observer = new ResizeObserver(updateBounds);
    observer.observe(el);

    // Also update on window resize (catches maximizing, etc.)
    window.addEventListener('resize', updateBounds);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateBounds);
    };
  }, []);

  // ── Listen for browser events from main process ──
  useEffect(() => {
    const api = (window as any).clawdia?.browser;
    if (!api) return;

    const cleanups: (() => void)[] = [];

    cleanups.push(api.onUrlChanged((url: string) => {
      setCurrentUrl(url);
      setUrlInput(url);
    }));

    cleanups.push(api.onTitleChanged((title: string) => {
      setCurrentTitle(title);
    }));

    cleanups.push(api.onLoading((loading: boolean) => {
      setIsLoading(loading);
    }));

    return () => cleanups.forEach(fn => fn());
  }, []);

  // ── Navigation handlers ──
  const handleNavigate = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const url = urlInput.trim();
    if (!url) return;
    (window as any).clawdia?.browser.navigate(url);
  }, [urlInput]);

  const handleBack = useCallback(() => {
    (window as any).clawdia?.browser.back();
  }, []);

  const handleForward = useCallback(() => {
    (window as any).clawdia?.browser.forward();
  }, []);

  const handleRefresh = useCallback(() => {
    (window as any).clawdia?.browser.refresh();
  }, []);

  return (
    <div className="flex flex-col h-full bg-surface-0">
      {/* Tab bar */}
      <div className="drag-region flex items-center h-[38px] bg-surface-1 border-b border-border-subtle px-1 gap-0.5 flex-shrink-0">
        {/* Active tab (single tab for now) */}
        {currentTitle && (
          <div className="no-drag flex items-center gap-1.5 h-[30px] px-3 rounded-lg bg-surface-3 text-text-primary max-w-[280px] min-w-0">
            {isLoading && (
              <div className="w-3 h-3 rounded-full border-[1.5px] border-accent border-t-transparent animate-spin flex-shrink-0" />
            )}
            <span className="text-2xs truncate">{currentTitle}</span>
          </div>
        )}

        {!currentTitle && (
          <div className="no-drag flex items-center gap-1.5 h-[30px] px-3 rounded-lg bg-surface-3 text-text-tertiary">
            <span className="text-2xs">New Tab</span>
          </div>
        )}

        <div className="flex-1 drag-region" />

        {/* Window controls (browser side) */}
        <div className="no-drag flex items-center gap-0.5">
          <button onClick={() => (window as any).clawdia?.window.minimize()} className="flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-text-secondary hover:bg-white/[0.06] transition-colors cursor-pointer opacity-40 hover:opacity-100">
            <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="2" y1="5" x2="8" y2="5" /></svg>
          </button>
          <button onClick={() => (window as any).clawdia?.window.maximize()} className="flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-text-secondary hover:bg-white/[0.06] transition-colors cursor-pointer opacity-40 hover:opacity-100">
            <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="6" height="6" /></svg>
          </button>
          <button onClick={() => (window as any).clawdia?.window.close()} className="flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-white hover:bg-red-500/80 transition-colors cursor-pointer opacity-40 hover:opacity-100">
            <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" /></svg>
          </button>
        </div>
      </div>

      {/* URL bar */}
      <div className="flex items-center gap-1.5 px-2 h-[40px] bg-surface-1 border-b border-border-subtle flex-shrink-0">
        <div className="flex items-center gap-0.5">
          <button onClick={handleBack} className="flex items-center justify-center w-7 h-7 rounded-lg text-text-muted hover:text-text-secondary hover:bg-white/[0.04] transition-colors cursor-pointer">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
          </button>
          <button onClick={handleForward} className="flex items-center justify-center w-7 h-7 rounded-lg text-text-muted hover:text-text-secondary hover:bg-white/[0.04] transition-colors cursor-pointer">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
          </button>
          <button onClick={handleRefresh} className="flex items-center justify-center w-7 h-7 rounded-lg text-text-muted hover:text-text-secondary hover:bg-white/[0.04] transition-colors cursor-pointer">
            {isLoading ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
            )}
          </button>
        </div>

        <form onSubmit={handleNavigate} className="flex-1">
          <div className="relative">
            {isLoading && (
              <div className="absolute bottom-0 left-0 h-[2px] bg-accent/60 rounded-full animate-pulse-soft" style={{ width: '60%' }} />
            )}
            <input
              type="text"
              value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              onFocus={e => e.target.select()}
              className="w-full h-[30px] bg-surface-0/60 text-text-secondary text-xs px-3 rounded-lg border border-transparent hover:border-border focus:border-accent/30 focus:text-text-primary outline-none transition-all font-mono"
              placeholder="Enter URL or search..."
            />
          </div>
        </form>
      </div>

      {/* Viewport — BrowserView renders ON TOP of this div at exact coordinates */}
      <div
        ref={viewportRef}
        className="flex-1 bg-surface-0"
      >
        {/* This div is intentionally empty. The native BrowserView sits on top.
            If no page is loaded, the dark background shows through. */}
      </div>
    </div>
  );
}
