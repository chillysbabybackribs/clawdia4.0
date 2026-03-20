import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { BrowserExecutionMode } from '../../shared/types';

interface TabInfo {
  id: string;
  url: string;
  title: string;
  isLoading: boolean;
  isActive: boolean;
  faviconUrl: string;
}

/** Strip protocol + www for clean URL bar display */
function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/^www\./, '');
}

/**
 * Turn user input into a navigable URL.
 * - Already has protocol → use as-is
 * - Looks like a hostname (has a dot, or is a known TLD-less shorthand) → add https://
 * - Bare word like "github" → treat as hostname, add https:// + .com if no dot
 * - Anything with spaces or no dot-like structure → Google search
 */
function resolveUrl(raw: string): string {
  const s = raw.trim();
  if (/^https?:\/\//i.test(s) || /^file:\/\//i.test(s)) return s;
  if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(s)) {
    return 'http://' + s;
  }
  if (/\s/.test(s)) return 'https://www.google.com/search?q=' + encodeURIComponent(s);
  if (s.includes('.')) return 'https://' + s;
  return 'https://' + s + '.com';
}

/* ─────────────────────────────────────────────
   Chrome Dark-Mode Color Tokens
   (pixel-sampled from live Google Chrome 2026)
   ───────────────────────────────────────────── */
const C = {
  tabStripBg:      '#0d0d10',   // surface-0 — matches sidebar/chat
  activeTab:       '#141418',   // slightly lifted for active tab
  urlBarBg:        '#0d0d10',   // same as strip
  urlInputBg:      '#111115',   // just barely above background
  topBorder:       'rgba(255,255,255,0.04)',
  separator:       'rgba(255,255,255,0.04)',
  tabSeparator:    'rgba(255,255,255,0.06)',
  tabActiveBorder: 'rgba(255,255,255,0.08)',
  textActive:      '#f0f0f2',
  textInactive:    '#5a5a68',
  iconNormal:      '#555563',
  iconHover:       '#b0b0be',
};

export default function BrowserPanel() {
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [urlInput, setUrlInput] = useState('');
  const [ghostText, setGhostText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [executionMode, setExecutionMode] = useState<BrowserExecutionMode>('headed');
  const [menuOpen, setMenuOpen] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const matchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // When user submits a URL, hold it here so tab-change events don't clobber it
  // before did-navigate fires with the real new URL.
  const pendingUrlRef = useRef<string | null>(null);
  const prevActiveTabIdRef = useRef<string | null>(null);

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
    api.getExecutionMode?.().then((mode: BrowserExecutionMode) => {
      if (mode) setExecutionMode(mode);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const api = (window as any).clawdia?.browser;
    if (!api) return;
    const cleanups: (() => void)[] = [];
    cleanups.push(api.onUrlChanged((url: string) => {
      pendingUrlRef.current = null;
      if (!isFocused) setUrlInput(displayUrl(url));
    }));
    cleanups.push(api.onLoading((loading: boolean) => setIsLoading(loading)));
    cleanups.push(api.onTabsChanged((newTabs: TabInfo[]) => {
      setTabs(newTabs);
      const active = newTabs.find(t => t.isActive);
      if (active) {
        if (!isFocused && !pendingUrlRef.current) setUrlInput(displayUrl(active.url));
        setIsLoading(active.isLoading);
        // Auto-focus URL bar when switching to a different tab or opening a new one
        if (active.id !== prevActiveTabIdRef.current) {
          prevActiveTabIdRef.current = active.id;
          setTimeout(() => {
            inputRef.current?.focus();
            inputRef.current?.select();
          }, 50);
        }
      }
    }));
    if (api.onModeChanged) {
      cleanups.push(api.onModeChanged((payload: { mode: BrowserExecutionMode }) => {
        setExecutionMode(payload.mode);
      }));
    }
    return () => cleanups.forEach(fn => fn());
  }, [isFocused]);

  // Hide BrowserView when menu is open so the dropdown isn't rendered behind
  // the native BrowserView layer (BrowserView always sits above HTML/CSS z-index)
  useEffect(() => {
    const api = (window as any).clawdia?.browser;
    if (!api) return;
    if (menuOpen) {
      api.hide();
    } else {
      api.show();
    }
  }, [menuOpen]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  // ── URL autocomplete ──
  const handleUrlChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setUrlInput(val);
    if (!val.trim() || val.length < 2) { setGhostText(''); return; }
    if (matchTimerRef.current) clearTimeout(matchTimerRef.current);
    matchTimerRef.current = setTimeout(async () => {
      try {
        const match = await (window as any).clawdia?.browser.matchHistory(val);
        if (match) {
          const cleanMatch = displayUrl(match);
          if (cleanMatch.toLowerCase().startsWith(val.toLowerCase())) {
            setGhostText(cleanMatch);
          } else { setGhostText(''); }
        } else { setGhostText(''); }
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
      ? ghostText : urlInput.trim();
    if (!url) return;
    url = resolveUrl(url);
    setGhostText('');
    const displayedUrl = displayUrl(url);
    setUrlInput(displayedUrl);
    pendingUrlRef.current = displayedUrl;
    (window as any).clawdia?.browser.navigate(url);
    inputRef.current?.blur();
  }, [urlInput, ghostText]);

  const handleFocus = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    setIsFocused(true);
    e.target.select();
  }, []);

  const handleBlur = useCallback(() => { setIsFocused(false); setGhostText(''); }, []);

  const handleBack    = useCallback(() => (window as any).clawdia?.browser.back(), []);
  const handleForward = useCallback(() => (window as any).clawdia?.browser.forward(), []);
  const handleRefresh = useCallback(() => (window as any).clawdia?.browser.refresh(), []);
  const handleNewTab  = useCallback(() => (window as any).clawdia?.browser.newTab('https://www.google.com'), []);
  const handleSwitchTab = useCallback((id: string) => (window as any).clawdia?.browser.switchTab(id), []);
  const handleCloseTab  = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    (window as any).clawdia?.browser.closeTab(id);
  }, []);

  const ghostSuffix = ghostText && isFocused && ghostText.toLowerCase().startsWith(urlInput.toLowerCase())
    ? ghostText.slice(urlInput.length) : '';

  // Chrome-accurate tab width: 240px max, shrinks as tabs open, min 72px
  const tabWidth = Math.max(72, Math.min(240, Math.floor((window.innerWidth - 200) / Math.max(tabs.length, 1))));

  const activeTab = tabs.find(t => t.isActive);
  const isHttps = (activeTab?.url || '').startsWith('https://');

  return (
    <div className="flex flex-col h-full" style={{ background: C.tabStripBg }}>

      {/* ═══ TOP BORDER ═══ */}
      <div style={{ height: 1, background: C.topBorder, flexShrink: 0 }} />

      {/* ═══ TAB STRIP ═══ */}
      <div
        className="drag-region flex items-end flex-shrink-0"
        style={{ background: C.tabStripBg, height: 38, paddingLeft: 8, paddingRight: 0 }}
      >
        {/* Tabs */}
        <div className="flex items-end gap-0 min-w-0 overflow-x-auto no-scrollbar" style={{ height: '100%' }}>
          {tabs.map((tab, i) => {
            const isActive = tab.isActive;
            const isLast = i === tabs.length - 1;
            return (
              <React.Fragment key={tab.id}>
                <div
                  onClick={() => handleSwitchTab(tab.id)}
                  className="no-drag group flex items-center gap-[6px] cursor-pointer flex-shrink-0 relative"
                  style={{
                    height: isActive ? 33 : 30,
                    paddingLeft: 10,
                    paddingRight: 6,
                    width: tabWidth,
                    maxWidth: 240,
                    minWidth: 72,
                    borderRadius: '8px 8px 0 0',
                    background: isActive ? C.activeTab : 'transparent',
                    color: isActive ? C.textActive : C.textInactive,
                    transition: 'background 0.1s, color 0.1s',
                    alignSelf: 'flex-end',
                    ...(isActive ? { boxShadow: `inset 0 1px 0 0 ${C.tabActiveBorder}` } : {}),
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                      e.currentTarget.style.color = '#b0b0b0';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.background = 'transparent';
                      e.currentTarget.style.color = C.textInactive;
                    }
                  }}
                >
                  {/* Favicon / spinner */}
                  {tab.isLoading ? (
                    <div style={{
                      width: 14, height: 14, borderRadius: '50%',
                      border: '1.5px solid #FF5061',
                      borderTopColor: 'transparent',
                      flexShrink: 0,
                      animation: 'spin 0.8s linear infinite',
                    }} />
                  ) : (
                    <TabFavicon tab={tab} isActive={isActive} />
                  )}

                  {/* Tab title */}
                  <span style={{
                    fontSize: 12,
                    fontFamily: 'system-ui, -apple-system, sans-serif',
                    fontWeight: 400,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    flex: 1,
                    minWidth: 0,
                  }}>
                    {tab.title || 'New Tab'}
                  </span>

                  {/* Close button — shown on tab hover via CSS group */}
                  {tabs.length > 1 && (
                    <button
                      onClick={(e) => handleCloseTab(tab.id, e)}
                      className="no-drag tab-close-btn"
                      style={{
                        width: 16, height: 16, borderRadius: 4,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        opacity: 0,
                        transition: 'opacity 0.1s, background 0.1s',
                        flexShrink: 0, cursor: 'pointer',
                        border: 'none', background: 'transparent',
                        color: 'inherit', padding: 0,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(255,255,255,0.12)';
                        e.currentTarget.style.opacity = '1';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                        // Restore to 0.6 if parent is hovered, else 0
                        const parent = e.currentTarget.parentElement;
                        e.currentTarget.style.opacity = parent?.matches(':hover') ? '0.6' : '0';
                      }}
                    >
                      <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
                        <line x1="1.5" y1="1.5" x2="6.5" y2="6.5" />
                        <line x1="6.5" y1="1.5" x2="1.5" y2="6.5" />
                      </svg>
                    </button>
                  )}
                </div>

                {/* Tab separator */}
                {!isActive && !isLast && !tabs[i + 1]?.isActive && (
                  <div style={{ width: 1, height: 16, background: C.tabSeparator, alignSelf: 'center', flexShrink: 0 }} />
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* New tab button */}
        <button
          onClick={handleNewTab}
          className="no-drag"
          title="New tab"
          style={{
            width: 28, height: 28, borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: C.iconNormal, background: 'transparent', border: 'none',
            cursor: 'pointer', flexShrink: 0, marginLeft: 4, marginBottom: 3,
            transition: 'background 0.12s, color 0.12s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = C.iconHover; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = C.iconNormal; }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>

        {/* Spacer */}
        <div className="flex-1 drag-region" style={{ minHeight: '100%' }} />

        {/* Window controls */}
        <div className="no-drag flex items-center flex-shrink-0" style={{ gap: 0, marginBottom: 5 }}>
          <button onClick={() => (window as any).clawdia?.window.minimize()} style={winBtnStyle}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round"><line x1="2" y1="5" x2="8" y2="5" /></svg>
          </button>
          <button onClick={() => (window as any).clawdia?.window.maximize()} style={winBtnStyle}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="6" height="6" /></svg>
          </button>
          <button onClick={() => (window as any).clawdia?.window.close()} style={winBtnStyle}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#e81123'; e.currentTarget.style.color = '#ffffff'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = C.textInactive; }}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round"><line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" /></svg>
          </button>
        </div>
      </div>

      {/* ═══ SEPARATOR ═══ */}
      <div style={{ height: 1, background: C.separator, flexShrink: 0 }} />

      {/* ═══ TOOLBAR / URL BAR ═══ */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 2,
        paddingLeft: 4, paddingRight: 4,
        height: 40, background: C.urlBarBg, flexShrink: 0,
      }}>
        {/* Nav buttons */}
        <NavButton onClick={handleBack} title="Back">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
        </NavButton>
        <NavButton onClick={handleForward} title="Forward">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
        </NavButton>
        <NavButton onClick={handleRefresh} title={isLoading ? 'Stop' : 'Reload'}>
          {isLoading ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
          )}
        </NavButton>

        {/* Omnibox */}
        <form onSubmit={handleNavigate} style={{ flex: 1, marginLeft: 2, marginRight: 2 }}>
          <div style={{ position: 'relative' }}>
            {/* Loading bar */}
            {isLoading && (
              <div style={{
                position: 'absolute', bottom: 0, left: 0,
                height: 2, borderRadius: 1, background: '#4f8ff7',
                opacity: 0.6, width: '60%',
                animation: 'pulse-soft 2s ease-in-out infinite',
              }} />
            )}

            {/* Ghost text */}
            {ghostSuffix && (
              <div style={{
                position: 'absolute', inset: 0,
                display: 'flex', alignItems: 'center',
                paddingLeft: isFocused ? 14 : 30,
                pointerEvents: 'none',
                fontFamily: '"Roboto", "Segoe UI", system-ui, sans-serif',
                fontSize: 13,
              }}>
                <span style={{ visibility: 'hidden', whiteSpace: 'pre' }}>{urlInput}</span>
                <span style={{ color: '#5e5e5e', whiteSpace: 'pre' }}>{ghostSuffix}</span>
              </div>
            )}

            {/* Lock icon — shown when not focused */}
            {!isFocused && (
              <div style={{
                position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
                pointerEvents: 'none', color: isHttps ? C.iconNormal : '#e57373',
                display: 'flex', alignItems: 'center',
              }}>
                {isHttps ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 9.9-1" />
                  </svg>
                )}
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
              autoComplete="off"
              spellCheck={false}
              placeholder="Search Google or type a URL"
              style={{
                width: '100%',
                height: 32,
                background: C.urlInputBg,
                color: isFocused ? C.textActive : '#c8c8c8',
                fontSize: 13,
                fontFamily: '"Roboto", "Segoe UI", system-ui, sans-serif',
                fontWeight: 400,
                paddingLeft: isFocused ? 14 : 30,
                paddingRight: 32,
                borderRadius: 16,
                border: isFocused ? '1px solid rgba(138,180,248,0.4)' : '1px solid transparent',
                outline: 'none',
                transition: 'border-color 0.15s, padding-left 0.1s',
              }}
            />

            {/* Bookmark star — right side of omnibox, not focused */}
            {!isFocused && (
              <div style={{
                position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                color: C.iconNormal, cursor: 'pointer', display: 'flex', alignItems: 'center',
                padding: 2, borderRadius: 3,
              }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = C.iconHover; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = C.iconNormal; }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
              </div>
            )}

            {/* Tab autocomplete hint */}
            {ghostSuffix && isFocused && (
              <div style={{
                position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                pointerEvents: 'none',
              }}>
                <kbd style={{
                  fontSize: 9, color: 'rgba(150,150,150,0.5)',
                  background: 'rgba(255,255,255,0.05)',
                  padding: '2px 5px', borderRadius: 3,
                  border: '1px solid rgba(255,255,255,0.08)',
                  fontFamily: 'monospace',
                }}>Tab</kbd>
              </div>
            )}
          </div>
        </form>

        {/* ── RIGHT-SIDE ICONS (Chrome-matching) ── */}

        {/* Extensions puzzle button */}
        <ToolbarIconBtn title="Extensions">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z" />
            <line x1="16" y1="8" x2="2" y2="22" />
            <line x1="17.5" y1="15" x2="9" y2="15" />
          </svg>
        </ToolbarIconBtn>

        {/* Profile avatar */}
        <div
          title="Profile"
          className="no-drag"
          style={{
            width: 26, height: 26, borderRadius: '50%',
            background: '#4285f4',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 700, color: '#fff',
            cursor: 'pointer', flexShrink: 0,
            transition: 'opacity 0.12s',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.85'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
        >
          C
        </div>

        {/* Three-dot menu */}
        <div ref={menuRef} style={{ position: 'relative', flexShrink: 0 }}>
          <ToolbarIconBtn title="Settings and more" onClick={() => setMenuOpen(o => !o)}>
            <svg width="16" height="16" viewBox="0 0 4 16" fill="currentColor">
              <circle cx="2" cy="2" r="1.5" />
              <circle cx="2" cy="8" r="1.5" />
              <circle cx="2" cy="14" r="1.5" />
            </svg>
          </ToolbarIconBtn>

          {menuOpen && (
            <div style={{
              position: 'absolute', right: 0, top: 'calc(100% + 4px)',
              background: '#2c2c2c', border: '1px solid #404040',
              borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
              minWidth: 220, zIndex: 1000, overflow: 'hidden',
              fontFamily: 'system-ui, -apple-system, sans-serif',
            }}>
              <MenuItem icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              } label="New tab" onClick={() => { handleNewTab(); setMenuOpen(false); }} />
              <MenuItem icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              } label="Reload" onClick={() => { handleRefresh(); setMenuOpen(false); }} />
              <div style={{ height: 1, background: '#404040', margin: '4px 0' }} />
              <MenuItem icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
              } label="History" onClick={() => setMenuOpen(false)} />
              <MenuItem icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              } label="Bookmarks" onClick={() => setMenuOpen(false)} />
              <MenuItem icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              } label="Downloads" onClick={() => setMenuOpen(false)} />
              <div style={{ height: 1, background: '#404040', margin: '4px 0' }} />
              {/* Zoom row */}
              <div style={{
                display: 'flex', alignItems: 'center',
                padding: '6px 14px', gap: 8,
                fontSize: 13, color: '#c8c8c8',
              }}>
                <span style={{ flex: 1 }}>Zoom</span>
                <button style={zoomBtnStyle} onClick={() => setMenuOpen(false)}>−</button>
                <span style={{ minWidth: 36, textAlign: 'center', fontSize: 12 }}>100%</span>
                <button style={zoomBtnStyle} onClick={() => setMenuOpen(false)}>+</button>
                <button style={{ ...zoomBtnStyle, padding: '2px 6px', borderRadius: 4 }} onClick={() => setMenuOpen(false)}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
                </button>
              </div>
              <div style={{ height: 1, background: '#404040', margin: '4px 0' }} />
              <MenuItem icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
              } label={`Mode: ${executionMode === 'headless' ? 'Headless' : 'Visible'}`} onClick={() => setMenuOpen(false)} />
              <MenuItem icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
              } label="Settings" onClick={() => setMenuOpen(false)} />
            </div>
          )}
        </div>
      </div>

      {/* ═══ BOTTOM TOOLBAR BORDER ═══ */}
      <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', flexShrink: 0 }} />

      {/* ═══ VIEWPORT ═══ */}
      <div ref={viewportRef} style={{ flex: 1, position: 'relative', background: '#202124' }}>
        {executionMode === 'headless' && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: '#202124', color: 'rgba(200,200,200,0.7)',
            pointerEvents: 'none',
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <div style={{ fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '0.18em', color: 'rgba(150,150,150,0.5)' }}>Headless Browser</div>
              <div style={{ fontSize: 13, color: 'rgba(200,200,200,0.6)' }}>This run detached and the browser is now running in the background.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── TabFavicon — multi-source favicon with fallbacks ─── */
function TabFavicon({ tab, isActive }: { tab: TabInfo; isActive: boolean }) {
  const [srcIndex, setSrcIndex] = React.useState(0);

  // Build ordered list of favicon sources to try:
  // 1. The URL reported by Electron (page-favicon-updated)
  // 2. /favicon.ico on the page's origin
  // 3. Google's favicon service (reliable CDN fallback)
  const sources = React.useMemo(() => {
    const srcs: string[] = [];
    if (tab.faviconUrl && tab.faviconUrl.startsWith('http')) {
      srcs.push(tab.faviconUrl);
    }
    try {
      const origin = new URL(tab.url).origin;
      if (origin && origin !== 'null') {
        srcs.push(`${origin}/favicon.ico`);
        srcs.push(`https://www.google.com/s2/favicons?sz=32&domain_url=${encodeURIComponent(origin)}`);
      }
    } catch {}
    return srcs;
  }, [tab.faviconUrl, tab.url]);

  // Reset when tab changes
  React.useEffect(() => { setSrcIndex(0); }, [tab.faviconUrl, tab.url]);

  if (sources.length === 0 || srcIndex >= sources.length) {
    // No favicon available — show placeholder
    return (
      <div style={{
        width: 14, height: 14, borderRadius: 2,
        background: isActive ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.05)',
        flexShrink: 0,
      }} />
    );
  }

  return (
    <img
      src={sources[srcIndex]}
      width={14}
      height={14}
      style={{ borderRadius: 2, flexShrink: 0, objectFit: 'contain' }}
      onError={() => setSrcIndex(i => i + 1)}
    />
  );
}

/* ─── Shared button styles ─── */

const winBtnStyle: React.CSSProperties = {
  width: 32, height: 28,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'transparent', border: 'none', cursor: 'pointer',
  color: '#969696', borderRadius: 0, transition: 'background 0.1s, color 0.1s',
};

const zoomBtnStyle: React.CSSProperties = {
  width: 24, height: 24, borderRadius: '50%',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(255,255,255,0.06)', border: 'none',
  color: '#c8c8c8', cursor: 'pointer', fontSize: 14,
};

/* ─── NavButton ─── */
function NavButton({ onClick, title, children }: {
  onClick: () => void; title: string; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} title={title} className="no-drag" style={{
      width: 28, height: 28, borderRadius: '50%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: '#929292', background: 'transparent', border: 'none',
      cursor: 'pointer', transition: 'background 0.12s, color 0.12s', padding: 0,
    }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = '#c4c4c4'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#929292'; }}
    >
      {children}
    </button>
  );
}

/* ─── ToolbarIconBtn — right-side icon buttons ─── */
function ToolbarIconBtn({ onClick, title, children }: {
  onClick?: () => void; title: string; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} title={title} className="no-drag" style={{
      width: 28, height: 28, borderRadius: '50%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: '#929292', background: 'transparent', border: 'none',
      cursor: 'pointer', transition: 'background 0.12s, color 0.12s', padding: 0, flexShrink: 0,
    }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = '#c4c4c4'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#929292'; }}
    >
      {children}
    </button>
  );
}

/* ─── MenuItem ─── */
function MenuItem({ icon, label, onClick }: {
  icon: React.ReactNode; label: string; onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '7px 14px', cursor: 'pointer',
        fontSize: 13, color: '#c8c8c8',
        transition: 'background 0.08s',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
    >
      <span style={{ color: '#929292', display: 'flex', alignItems: 'center' }}>{icon}</span>
      {label}
    </div>
  );
}
