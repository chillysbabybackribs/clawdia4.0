import React, { useState } from 'react';
import { DEFAULT_MODEL_BY_PROVIDER, DEFAULT_PROVIDER, PROVIDERS, type ProviderId } from '../../shared/model-registry';

interface WelcomeScreenProps {
  onComplete: () => void;
}

/**
 * First-run onboarding. Shown instead of the chat when no API key is configured.
 * Lets the user paste their key and get started without hunting for Settings.
 */
export default function WelcomeScreen({ onComplete }: WelcomeScreenProps) {
  const [provider, setProvider] = useState<ProviderId>(DEFAULT_PROVIDER);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const validateApiKey = (providerId: ProviderId, key: string): string | null => {
    if (providerId === 'anthropic' && !key.startsWith('sk-ant-')) {
      return 'Anthropic API key should start with sk-ant-';
    }
    if (providerId === 'openai' && !key.startsWith('sk-')) {
      return 'OpenAI API key should start with sk-';
    }
    if (providerId === 'gemini' && !/^AIza[0-9A-Za-z_-]{20,}$/.test(key)) {
      return 'Gemini API key should usually start with AIza';
    }
    return null;
  };

  const handleSubmit = async () => {
    const key = apiKey.trim();
    if (!key) {
      setError('Please paste your API key');
      return;
    }
    const validationError = validateApiKey(provider, key);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError('');

    try {
      const api = (window as any).clawdia;
      await api.settings.setApiKey(provider, key);
      await api.settings.setProvider(provider);
      await api.settings.setModel(provider, DEFAULT_MODEL_BY_PROVIDER[provider]);
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
            Provider
          </label>
          <div className="grid grid-cols-3 gap-2">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                onClick={() => { setProvider(p.id); setError(''); }}
                className={`h-[38px] rounded-xl border text-xs transition-colors cursor-pointer ${
                  provider === p.id
                    ? 'border-accent/50 bg-accent/10 text-text-primary'
                    : 'border-border bg-surface-2 text-text-muted hover:text-text-secondary'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <label className="text-xs font-medium text-text-secondary uppercase tracking-wider pt-1">
            API Key
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={e => { setApiKey(e.target.value); setError(''); }}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            placeholder={provider === 'anthropic' ? 'sk-ant-...' : provider === 'openai' ? 'sk-...' : 'AIza...'}
            autoFocus
            className="w-full h-[42px] bg-surface-2 text-text-primary text-sm font-mono px-4 rounded-xl border border-border placeholder:text-text-muted outline-none focus:border-accent/40 transition-colors"
          />
          {error && (
            <p className="text-2xs text-status-error">{error}</p>
          )}
          <p className="text-2xs text-text-muted leading-relaxed">
            Get your key at{' '}
            <span className="text-accent cursor-pointer" onClick={() => {
              const url = provider === 'anthropic'
                ? 'https://console.anthropic.com'
                : provider === 'openai'
                  ? 'https://platform.openai.com/api-keys'
                  : 'https://aistudio.google.com/app/apikey';
              (window as any).clawdia?.browser?.navigate(url);
            }}>
              {provider === 'anthropic'
                ? 'console.anthropic.com'
                : provider === 'openai'
                  ? 'platform.openai.com/api-keys'
                  : 'aistudio.google.com/app/apikey'}
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
