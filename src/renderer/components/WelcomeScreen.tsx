import React, { useState } from 'react';

interface WelcomeScreenProps {
  onComplete: () => void;
}

/**
 * First-run onboarding. Shown instead of the chat when no API key is configured.
 * Lets the user paste their key and get started without hunting for Settings.
 */
export default function WelcomeScreen({ onComplete }: WelcomeScreenProps) {
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    const key = apiKey.trim();
    if (!key) {
      setError('Please paste your API key');
      return;
    }
    if (!key.startsWith('sk-ant-')) {
      setError('API key should start with sk-ant-');
      return;
    }

    setSaving(true);
    setError('');

    try {
      const api = (window as any).clawdia;
      await api.settings.setApiKey(key);
      await api.settings.setModel('claude-sonnet-4-6');
      onComplete();
    } catch (err: any) {
      setError('Failed to save: ' + (err.message || 'Unknown error'));
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-full px-8">
      <div className="flex flex-col items-center gap-6 max-w-[400px] w-full">

        {/* Logo / title */}
        <div className="flex flex-col items-center gap-2">
          <div className="text-[28px] font-bold text-text-primary tracking-tight">
            Clawdia
          </div>
          <div className="text-sm text-text-tertiary text-center leading-relaxed">
            AI desktop workspace with browser, code, and task automation.
          </div>
        </div>

        {/* Divider */}
        <div className="w-full h-px bg-white/[0.06]" />

        {/* API key input */}
        <div className="flex flex-col gap-3 w-full">
          <label className="text-xs font-medium text-text-secondary uppercase tracking-wider">
            Anthropic API Key
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={e => { setApiKey(e.target.value); setError(''); }}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            placeholder="sk-ant-api03-..."
            autoFocus
            className="w-full h-[42px] bg-surface-2 text-text-primary text-sm font-mono px-4 rounded-xl border border-border placeholder:text-text-muted outline-none focus:border-accent/40 transition-colors"
          />
          {error && (
            <p className="text-2xs text-status-error">{error}</p>
          )}
          <p className="text-2xs text-text-muted leading-relaxed">
            Get your key at{' '}
            <span className="text-accent cursor-pointer" onClick={() => {
              (window as any).clawdia?.browser?.navigate('https://console.anthropic.com');
            }}>
              console.anthropic.com
            </span>
            . Stored locally with encryption — never leaves your machine.
          </p>
        </div>

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={saving}
          className="w-full h-[42px] rounded-xl text-sm font-medium bg-accent hover:bg-accent/90 text-white transition-all cursor-pointer disabled:opacity-50"
        >
          {saving ? 'Setting up...' : 'Get Started'}
        </button>

        {/* Features list */}
        <div className="flex flex-col gap-2 w-full pt-2">
          {[
            ['Terminal', 'Execute commands, install packages, run builds'],
            ['Browser', 'Search, navigate, click, extract data from any site'],
            ['Files', 'Read, write, edit files anywhere on your system'],
            ['Memory', 'Remembers facts and context across conversations'],
          ].map(([title, desc]) => (
            <div key={title} className="flex items-start gap-3 py-1">
              <div className="w-1 h-1 rounded-full bg-accent/60 mt-[7px] flex-shrink-0" />
              <div>
                <span className="text-2xs font-medium text-text-secondary">{title}</span>
                <span className="text-2xs text-text-muted"> — {desc}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
