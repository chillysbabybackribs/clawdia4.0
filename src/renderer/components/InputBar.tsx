import React, { useState, useRef, useCallback } from 'react';

interface InputBarProps {
  onSend: (message: string) => void;
  isStreaming: boolean;
  onStop: () => void;
}

const MODELS = [
  { id: 'claude-opus-4-6', label: 'Opus 4.6', tier: 'opus' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', tier: 'sonnet' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', tier: 'haiku' },
] as const;

export default function InputBar({ onSend, isStreaming, onStop }: InputBarProps) {
  const [text, setText] = useState('');
  const [modelIdx, setModelIdx] = useState(1);
  const [modelOpen, setModelOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    onSend(trimmed);
    setText('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [text, isStreaming, onSend]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, []);

  const currentModel = MODELS[modelIdx];

  return (
    <div className="px-3 pb-3 pt-1">
      <div className="relative flex flex-col bg-surface-2 rounded-2xl border border-border/60 focus-within:border-accent/30 transition-colors">
        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Ask me anything..."
          rows={1}
          className="
            w-full bg-transparent text-text-primary text-[0.9rem] placeholder:text-text-muted
            px-4 pt-3 pb-1 resize-none outline-none
            max-h-[200px] leading-relaxed
          "
        />

        {/* Bottom bar */}
        <div className="flex items-center justify-between px-3 pb-2.5 pt-0.5">
          <div className="flex items-center gap-2 no-drag relative">
            {/* Attach */}
            <button
              title="Attach file"
              className="flex items-center justify-center w-7 h-7 rounded-lg text-text-muted hover:text-text-secondary hover:bg-white/[0.04] transition-colors cursor-pointer"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>

            {/* Model pill */}
            <button
              onClick={() => setModelOpen(v => !v)}
              className="
                flex items-center gap-1.5 h-7 px-2.5 rounded-lg
                text-2xs font-medium text-text-tertiary
                hover:text-text-secondary hover:bg-white/[0.04]
                transition-colors cursor-pointer
              "
            >
              <div className={`w-1.5 h-1.5 rounded-full ${
                currentModel.tier === 'opus' ? 'bg-amber-400' :
                currentModel.tier === 'sonnet' ? 'bg-accent' :
                'bg-emerald-400'
              }`} />
              {currentModel.label}
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {/* Model dropdown */}
            {modelOpen && (
              <div className="absolute bottom-full left-8 mb-2 py-1.5 bg-surface-3 border border-border rounded-xl shadow-lg shadow-black/40 min-w-[160px] animate-fade-in z-50">
                {MODELS.map((m, i) => (
                  <button
                    key={m.id}
                    onClick={() => { setModelIdx(i); setModelOpen(false); }}
                    className={`
                      w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors cursor-pointer
                      ${i === modelIdx ? 'text-text-primary bg-white/[0.05]' : 'text-text-secondary hover:text-text-primary hover:bg-white/[0.03]'}
                    `}
                  >
                    <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      m.tier === 'opus' ? 'bg-amber-400' :
                      m.tier === 'sonnet' ? 'bg-accent' :
                      'bg-emerald-400'
                    }`} />
                    {m.label}
                    {i === modelIdx && (
                      <svg className="ml-auto text-accent" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Send / Stop */}
          <div className="flex items-center gap-1.5">
            {isStreaming ? (
              <button
                onClick={onStop}
                title="Stop generation"
                className="
                  flex items-center justify-center w-8 h-8 rounded-lg
                  bg-status-error/20 text-status-error hover:bg-status-error/30
                  transition-colors cursor-pointer
                "
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!text.trim()}
                title="Send message"
                className="
                  flex items-center justify-center w-8 h-8 rounded-lg
                  transition-all cursor-pointer
                  disabled:opacity-20 disabled:cursor-default
                  bg-accent/90 hover:bg-accent text-white
                "
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
