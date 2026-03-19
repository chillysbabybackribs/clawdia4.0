import React, { useState, useEffect, useRef } from 'react';

interface SettingsViewProps {
  onBack: () => void;
}

export default function SettingsView({ onBack }: SettingsViewProps) {
  const [apiKey, setApiKey] = useState('');
  const [keyVisible, setKeyVisible] = useState(false);
  const [saved, setSaved] = useState(false);
  const [currentModel, setCurrentModel] = useState('claude-sonnet-4-6');
  const [loaded, setLoaded] = useState(false);
  const originalKeyRef = useRef('');

  // Load current settings on mount
  useEffect(() => {
    const api = (window as any).clawdia;
    if (!api) return;
    Promise.all([
      api.settings.getApiKey(),
      api.settings.getModel(),
    ]).then(([key, model]: [string, string]) => {
      if (key) {
        setApiKey(key);
        originalKeyRef.current = key;
      }
      if (model) setCurrentModel(model);
      setLoaded(true);
    });
  }, []);

  const handleSave = async () => {
    const api = (window as any).clawdia;
    if (!api) return;

    // Always save the key (even if unchanged — it's idempotent)
    await api.settings.setApiKey(apiKey);
    await api.settings.setModel(currentModel);
    originalKeyRef.current = apiKey;

    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const hasKey = apiKey.length > 0;

  return (
    <div className="flex flex-col h-full bg-surface-0">
      <header className="drag-region flex items-center gap-3 px-4 h-[44px] flex-shrink-0 border-b border-border-subtle">
        <button onClick={onBack} className="no-drag flex items-center justify-center w-7 h-7 rounded-lg text-text-tertiary hover:text-text-secondary hover:bg-white/[0.04] transition-colors cursor-pointer">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
        </button>
        <h2 className="text-sm font-medium text-text-primary">Settings</h2>
        <div className="flex-1" />
        {hasKey && (
          <div className="flex items-center gap-1.5 text-2xs text-status-success no-drag">
            <div className="w-1.5 h-1.5 rounded-full bg-status-success" />
            API connected
          </div>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-5">
        <div className="max-w-[400px] flex flex-col gap-6">

          {/* API Key */}
          <section className="flex flex-col gap-2">
            <label className="text-xs font-medium text-text-secondary uppercase tracking-wider">Anthropic API Key</label>
            <div className="relative">
              <input
                type={keyVisible ? 'text' : 'password'}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="sk-ant-..."
                className="w-full h-[38px] bg-surface-2 text-text-primary text-sm font-mono pl-3 pr-10 rounded-lg border border-border placeholder:text-text-muted outline-none focus:border-accent/40 transition-colors"
              />
              <button onClick={() => setKeyVisible(v => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center justify-center w-7 h-7 rounded text-text-muted hover:text-text-secondary transition-colors cursor-pointer">
                {keyVisible ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                )}
              </button>
            </div>
            <p className="text-2xs text-text-muted">Stored locally with encryption. Never leaves your machine.</p>
          </section>

          {/* Model Default */}
          <section className="flex flex-col gap-2">
            <label className="text-xs font-medium text-text-secondary uppercase tracking-wider">Default Model</label>
            <p className="text-2xs text-text-muted -mt-1">The classifier auto-selects the best model per task. This sets the fallback.</p>
            <div className="flex flex-col gap-1">
              {[
                { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', desc: 'Most capable — complex reasoning, long context', dot: 'bg-amber-400' },
                { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', desc: 'Balanced — fast, capable, cost-effective', dot: 'bg-accent' },
                { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', desc: 'Fastest — quick tasks, high throughput', dot: 'bg-emerald-400' },
              ].map(m => (
                <label key={m.id} className="flex items-start gap-3 px-3 py-2.5 rounded-xl hover:bg-white/[0.02] transition-colors cursor-pointer">
                  <input type="radio" name="model" value={m.id} checked={currentModel === m.id} onChange={() => setCurrentModel(m.id)} className="mt-0.5 accent-accent" />
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <div className={`w-1.5 h-1.5 rounded-full ${m.dot}`} />
                      <span className="text-sm text-text-primary">{m.label}</span>
                    </div>
                    <span className="text-2xs text-text-muted">{m.desc}</span>
                  </div>
                </label>
              ))}
            </div>
          </section>

          {/* Save */}
          <button
            onClick={handleSave}
            className={`h-[38px] rounded-xl text-sm font-medium transition-all cursor-pointer ${saved ? 'bg-status-success/20 text-status-success' : 'bg-accent/90 hover:bg-accent text-white'}`}
          >
            {saved ? 'Saved ✓' : 'Save Settings'}
          </button>
        </div>
      </div>
    </div>
  );
}
