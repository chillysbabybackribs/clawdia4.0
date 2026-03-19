import React, { useState, useRef, useEffect, useCallback } from 'react';

interface TabInfo {
  id: string;
  url: string;
  title: string;
  isLoading: boolean;
  isActive: boolean;
}

/** Strip protocol + www for clean URL bar display */
function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/^www\./, '');
}

export default function BrowserPanel() {
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [urlInput, setUrlInput] = useState('');
  const [ghostText, setGhostText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const matchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const updateBounds = () => {
      const rect = el.getBoundingClientRect();
      (window as any).clawdia?.browser.setBounds({
        x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.round(rect.width), height: Math.round(rect.height),
      });
    };
    updateBounds();
    const observer = new ResizeObserver(updateBounds);
    observer.observe(el);
    window.addEventListener('resize', updateBounds);
    return () => { observer.disconnect(); window.removeEventListener('resize', updateBounds); };
  }, []);

  useEffect(() => {
    const api = (window as any).clawdia?.browser;
    if (!api) return;
    api.listTabs().then((list: TabInfo[]) => { if (list?.length) setTabs(list); });
  }, []);

  useEffect(() => {
    const api = (window as any).clawdia?.browser;
    if (!api) return;
    const cleanups: (() => void)[] = [];
    cleanups.push(api.onUrlChanged((url: string) => {
      if (!isFocused) setUrlInput(displayUrl(url));
    }));
    cleanups.push(api.onLoading((loading: boolean) => setIsLoading(loading)));
    cleanups.push(api.onTabsChanged((newTabs: TabInfo[]) => {
      setTabs(newTabs);
      const active = newTabs.find(t => t.isActive);
      if (active) {
        if (!isFocused) setUrlInput(displayUrl(active.url));
        setIsLoading(active.isLoading);
      }
    }));
    return () => cleanups.forEach(fn => fn());
  }, [isFocused]);

  // ── URL autocomplete ──
  const handleUrlChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setUrlInput(val);

    if (!val.trim() || val.length < 2) {
      setGhostText('');
      return;
    }

    if (matchTimerRef.current) clearTimeout(matchTimerRef.current);
    matchTimerRef.current = setTimeout(async () => {
      try {
        const match = await (window as any).clawdia?.browser.matchHistory(val);
        if (match) {
          // Show ghost text as the clean domain version
          const cleanMatch = displayUrl(match);
          if (cleanMatch.toLowerCase().startsWith(val.toLowerCase())) {
            setGhostText(cleanMatch);
          } else {
            setGhostText('');
          }
        } else {
          setGhostText('');
        }
      } catch { setGhostText(''); }
    }, 30);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Tab' || e.key === 'ArrowRight') && ghostText) {
      const input = inputRef.current;
      if (input && input.selectionStart === urlInput.length) {
        e.preventDefault();
        setUrlInput(ghostText);
        setGhostText('');
      }
    }
  }, [ghostText, urlInput]);

  const handleNavigate = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    let url = ghostText && ghostText.toLowerCase().startsWith(urlInput.toLowerCase())
      ? ghostText
      : urlInput.trim();
    if (!url) return;

    // Auto-prepend https:// if no protocol
    if (!/^https?:\/\//i.test(url) && !/^file:\/\//i.test(url)) {
      url = 'https://' + url;
    }

    setGhostText('');
    setUrlInput(displayUrl(url));
    (window as any).clawdia?.browser.navigate(url);
    inputRef.current?.blur();
  }, [urlInput, ghostText]);

  const handleFocus = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    setIsFocused(true);
    e.target.select();
  }, []);

  const handleBlur = useCallback(() => {
    setIsFocused(false);
    setGhostText('');
  }, []);

  const handleBack = useCallback(() => (window as any).clawdia?.browser.back(), []);
  const handleForward = useCallback(() => (window as any).clawdia?.browser.forward(), []);
  const handleRefresh = useCallback(() => (window as any).clawdia?.browser.refresh(), []);
  const handleNewTab = useCallback(() => (window as any).clawdia?.browser.newTab('https://www.google.com'), []);
  const handleSwitchTab = useCallback((id: string) => (window as any).clawdia?.browser.switchTab(id), []);
  const handleCloseTab = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    (window as any).clawdia?.browser.closeTab(id);
  }, []);

  const ghostSuffix = ghostText && isFocused && ghostText.toLowerCase().startsWith(urlInput.toLowerCase())
    ? ghostText.slice(urlInput.length)
    : '';

  return (
    <div className="flex flex-col h-full bg-surface-0">
      {/* Tab bar */}
      <div className="drag-region flex items-center h-[38px] bg-surface-1 border-b border-border-subtle px-1 gap-0.5 flex-shrink-0 overflow-hidden">
        <div className="flex items-center gap-0.5 min-w-0 overflow-x-auto no-scrollbar">
          {tabs.map(tab => (
            <div key={tab.id} onClick={() => handleSwitchTab(tab.id)}
              className={`no-drag group flex items-center gap-1.5 h-[30px] px-2.5 rounded-lg cursor-pointer transition-all duration-100 max-w-[180px] min-w-[80px] flex-shrink-0 ${tab.isActive ? 'bg-surface-3 text-text-primary' : 'text-text-tertiary hover:text-text-secondary hover:bg-white/[0.03]'}`}>
              {tab.isLoading && tab.isActive && (
                <div className="w-3 h-3 rounded-full border-[1.5px] border-accent border-t-transparent animate-spin flex-shrink-0" />
              )}
              <span className="text-2xs truncate flex-1 min-w-0">{tab.title || 'New Tab'}</span>
              {tabs.length > 1 && (
                <button onClick={(e) => handleCloseTab(tab.id, e)}
                  className="flex-shrink-0 flex items-center justify-center w-4 h-4 rounded opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-white/[0.1] transition-all cursor-pointer">
                  <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" /></svg>
                </button>
              )}
            </div>
          ))}
        </div>
        <button onClick={handleNewTab} className="no-drag flex items-center justify-center w-7 h-7 rounded-lg text-text-muted hover:text-text-secondary hover:bg-white/[0.04] transition-colors cursor-pointer flex-shrink-0" title="New tab">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
        </button>
        <div className="flex-1 drag-region" />
        <div className="no-drag flex items-center gap-0.5 flex-shrink-0">
          <button onClick={() => (window as any).clawdia?.window.minimize()} className="flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-text-secondary hover:bg-white/[0.06] transition-colors cursor-pointer opacity-40 hover:opacity-100"><svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="2" y1="5" x2="8" y2="5" /></svg></button>
          <button onClick={() => (window as any).clawdia?.window.maximize()} className="flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-text-secondary hover:bg-white/[0.06] transition-colors cursor-pointer opacity-40 hover:opacity-100"><svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="6" height="6" /></svg></button>
          <button onClick={() => (window as any).clawdia?.window.close()} className="flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-white hover:bg-red-500/80 transition-colors cursor-pointer opacity-40 hover:opacity-100"><svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" /></svg></button>
        </div>
      </div>

      {/* URL bar with ghost text autocomplete */}
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

            {/* Ghost text overlay */}
            {ghostSuffix && (
              <div className="absolute inset-0 flex items-center px-3 pointer-events-none font-mono text-xs">
                <span className="invisible whitespace-pre">{urlInput}</span>
                <span className="text-text-tertiary whitespace-pre">{ghostSuffix}</span>
              </div>
            )}

            <input
              ref={inputRef}
              type="text"
              value={urlInput}
              onChange={handleUrlChange}
              onKeyDown={handleKeyDown}
              onFocus={handleFocus}
              onBlur={handleBlur}
              className="w-full h-[30px] bg-surface-0/60 text-text-secondary text-xs px-3 rounded-lg border border-transparent hover:border-border focus:border-accent/30 focus:text-text-primary outline-none transition-all font-mono"
              placeholder="Enter URL or search..."
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </form>

        {ghostSuffix && isFocused && (
          <div className="flex items-center gap-1 flex-shrink-0 pr-1">
            <kbd className="text-[9px] text-text-muted/50 bg-white/[0.05] px-1.5 py-0.5 rounded border border-white/[0.08] font-mono">Tab</kbd>
          </div>
        )}
      </div>

      <div ref={viewportRef} className="flex-1 bg-surface-0" />
    </div>
  );
}
