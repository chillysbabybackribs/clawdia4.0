import React, { useState, useCallback } from 'react';

interface Tab {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

const DEMO_TABS: Tab[] = [
  { id: '1', title: 'Anthropic API Pricing', url: 'https://docs.anthropic.com/en/docs/about-claude/pricing', active: true },
  { id: '2', title: 'Claude Model Comparison', url: 'https://docs.anthropic.com/en/docs/about-claude/models', active: false },
];

export default function BrowserPanel() {
  const [tabs, setTabs] = useState<Tab[]>(DEMO_TABS);
  const [urlInput, setUrlInput] = useState(DEMO_TABS[0].url);
  const [isLoading, setIsLoading] = useState(false);

  const switchTab = useCallback((id: string) => {
    setTabs(prev => prev.map(t => ({ ...t, active: t.id === id })));
    const target = tabs.find(t => t.id === id);
    if (target) setUrlInput(target.url);
  }, [tabs]);

  const closeTab = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTabs(prev => {
      const filtered = prev.filter(t => t.id !== id);
      if (filtered.length > 0 && prev.find(t => t.id === id)?.active) {
        filtered[filtered.length - 1].active = true;
        setUrlInput(filtered[filtered.length - 1].url);
      }
      return filtered;
    });
  }, []);

  const handleNavigate = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setTimeout(() => setIsLoading(false), 1500);
  }, []);

  return (
    <div className="flex flex-col h-full bg-surface-0">
      {/* Tab bar */}
      <div className="drag-region flex items-center h-[38px] bg-surface-1 border-b border-border-subtle px-1 gap-0.5 flex-shrink-0">
        {tabs.map(tab => (
          <div
            key={tab.id}
            onClick={() => switchTab(tab.id)}
            className={`
              no-drag group flex items-center gap-1.5 h-[30px] px-3 rounded-lg cursor-pointer
              transition-all duration-100 max-w-[200px] min-w-0
              ${tab.active
                ? 'bg-surface-3 text-text-primary'
                : 'text-text-tertiary hover:text-text-secondary hover:bg-white/[0.03]'
              }
            `}
          >
            <span className="text-2xs truncate flex-1">{tab.title}</span>
            <button
              onClick={(e) => closeTab(tab.id, e)}
              className="flex-shrink-0 flex items-center justify-center w-4 h-4 rounded opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-white/[0.1] transition-all cursor-pointer"
            >
              <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <line x1="2" y1="2" x2="8" y2="8" />
                <line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>
          </div>
        ))}

        <button className="no-drag flex items-center justify-center w-7 h-7 rounded-lg text-text-muted hover:text-text-secondary hover:bg-white/[0.04] transition-colors cursor-pointer" title="New tab">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>

        <div className="flex-1 drag-region" />

        {/* Window controls (browser side) */}
        <div className="no-drag flex items-center gap-0.5">
          <button onClick={() => window.clawdia?.window.minimize()} className="flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-text-secondary hover:bg-white/[0.06] transition-colors cursor-pointer opacity-40 hover:opacity-100">
            <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="2" y1="5" x2="8" y2="5" /></svg>
          </button>
          <button onClick={() => window.clawdia?.window.maximize()} className="flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-text-secondary hover:bg-white/[0.06] transition-colors cursor-pointer opacity-40 hover:opacity-100">
            <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="6" height="6" /></svg>
          </button>
          <button onClick={() => window.clawdia?.window.close()} className="flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-white hover:bg-red-500/80 transition-colors cursor-pointer opacity-40 hover:opacity-100">
            <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" /></svg>
          </button>
        </div>
      </div>

      {/* URL bar */}
      <div className="flex items-center gap-1.5 px-2 h-[40px] bg-surface-1 border-b border-border-subtle flex-shrink-0">
        <div className="flex items-center gap-0.5">
          <button className="flex items-center justify-center w-7 h-7 rounded-lg text-text-muted hover:text-text-secondary hover:bg-white/[0.04] transition-colors cursor-pointer">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
          </button>
          <button className="flex items-center justify-center w-7 h-7 rounded-lg text-text-muted hover:text-text-secondary hover:bg-white/[0.04] transition-colors cursor-pointer">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
          </button>
          <button className="flex items-center justify-center w-7 h-7 rounded-lg text-text-muted hover:text-text-secondary hover:bg-white/[0.04] transition-colors cursor-pointer">
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
              className="
                w-full h-[30px] bg-surface-0/60 text-text-secondary text-xs
                px-3 rounded-lg border border-transparent
                hover:border-border focus:border-accent/30 focus:text-text-primary
                outline-none transition-all font-mono
              "
              placeholder="Enter URL..."
            />
          </div>
        </form>
      </div>

      {/* Viewport */}
      <div className="flex-1 flex items-center justify-center bg-surface-0">
        <div className="flex flex-col items-center gap-5 text-text-muted">
          <div className="opacity-[0.15]">
            <svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <ellipse cx="12" cy="12" rx="4" ry="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
          </div>
          <p className="text-sm text-text-muted/60">
            Navigate to a page or let Clawdia browse for you
          </p>
        </div>
      </div>
    </div>
  );
}
