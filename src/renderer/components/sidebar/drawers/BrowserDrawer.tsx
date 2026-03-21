import React, { useState, useEffect, useCallback } from 'react';

export default function BrowserDrawer() {
  const [domains, setDomains] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const api = (window as any).clawdia;

  const load = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    try {
      const list = await api.browser.listSessions();
      setDomains(list || []);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleClear = async (domain: string) => {
    if (!api) return;
    await api.browser.clearSession(domain).catch(() => {});
    setDomains(prev => prev.filter(d => d !== domain));
  };

  const filtered = search
    ? domains.filter(d => d.includes(search.toLowerCase()))
    : domains;

  // First letter as favicon fallback
  const favicon = (domain: string) => domain.replace(/^www\./, '')[0]?.toUpperCase() || '?';

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-3 border-b border-border flex-shrink-0">
        <div className="text-[11px] font-semibold text-text-primary mb-2">Browser Sessions</div>
        <div className="relative">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text" placeholder="Filter sites..."
            value={search} onChange={e => setSearch(e.target.value)}
            className="w-full h-[26px] pl-7 pr-2 rounded bg-border-subtle border border-border text-[11px] text-text-primary placeholder-text-tertiary outline-none focus:border-accent/30 transition-all"
          />
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="px-3 py-1.5 text-[9px] font-semibold text-text-tertiary uppercase tracking-wider">
          Active Sessions {!loading && `(${filtered.length})`}
        </div>

        {loading && (
          <div className="px-3 py-2 text-[11px] text-text-muted">Loading...</div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-text-muted">
            {search ? 'No matching sites' : 'No active sessions. Browse a site to create one.'}
          </div>
        )}

        {filtered.map(domain => (
          <div key={domain} className="flex items-center gap-2 px-3 py-1.5 hover:bg-border-subtle transition-colors group">
            <div className="w-[18px] h-[18px] rounded bg-border flex items-center justify-center text-[10px] font-semibold text-text-secondary flex-shrink-0">
              {favicon(domain)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[11px] text-text-secondary truncate">{domain}</div>
              <div className="text-[9px] text-[#3a6644] mt-0.5">● Session active</div>
            </div>
            <button
              onClick={() => handleClear(domain)}
              className="no-drag flex-shrink-0 text-[9px] text-text-muted border border-border rounded px-1.5 py-0.5 hover:text-accent hover:border-accent/30 hover:bg-accent/[0.06] transition-all cursor-pointer opacity-0 group-hover:opacity-100"
            >
              Clear
            </button>
          </div>
        ))}

        <div className="h-px bg-surface-1 my-2" />
        <div className="px-3 pb-3 text-[10px] text-text-muted leading-relaxed">
          Claude uses your existing sessions automatically. No API keys required.
        </div>
      </div>
    </div>
  );
}
