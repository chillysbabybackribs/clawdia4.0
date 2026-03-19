import React, { useState, useRef, useCallback, useEffect } from 'react';

interface InputBarProps {
  onSend: (message: string) => void;
  isStreaming: boolean;
  isPaused: boolean;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  onAddContext: (text: string) => void;
}

const MODELS = [
  { id: 'claude-opus-4-6', label: 'Opus 4.6', tier: 'opus' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', tier: 'sonnet' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', tier: 'haiku' },
] as const;

export default function InputBar({ onSend, isStreaming, isPaused, onStop, onPause, onResume, onAddContext }: InputBarProps) {
  const [text, setText] = useState('');
  const [modelIdx, setModelIdx] = useState(1);
  const [modelOpen, setModelOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { textareaRef.current?.focus(); }, []);

  useEffect(() => {
    const api = (window as any).clawdia;
    if (!api) return;
    api.settings.getModel().then((model: string) => {
      const idx = MODELS.findIndex(m => m.id === model);
      if (idx !== -1) setModelIdx(idx);
    });
  }, []);

  const handleModelChange = useCallback((idx: number) => {
    setModelIdx(idx);
    setModelOpen(false);
    const api = (window as any).clawdia;
    api?.settings.setModel(MODELS[idx].id);
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (isStreaming) { onAddContext(trimmed); }
    else { onSend(trimmed); }
    setText('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [text, isStreaming, onSend, onAddContext]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    if (e.key === 'Escape' && isStreaming) { onStop(); }
  }, [handleSend, isStreaming, onStop]);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, []);

  const currentModel = MODELS[modelIdx];
  const canSend = text.trim().length > 0;

  return (
    <div className="px-4 pb-4 pt-2">
      <div
        className={`
          relative flex flex-col rounded-xl transition-all duration-200
          bg-[#18181c] border
          ${focused
            ? 'border-white/[0.12] shadow-[inset_0_1px_6px_rgba(0,0,0,0.3),0_-2px_10px_rgba(0,0,0,0.35),0_0_0_1px_rgba(255,255,255,0.04)]'
            : 'border-white/[0.06] hover:border-white/[0.09] shadow-[inset_0_1px_4px_rgba(0,0,0,0.2),0_-2px_8px_rgba(0,0,0,0.25)]'
          }
        `}
      >
        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={isStreaming ? 'Add a follow-up...' : 'Ask me anything...'}
          rows={1}
          className="w-full bg-transparent text-text-primary text-[14px] placeholder:text-text-tertiary px-4 pt-1.5 pb-1.5 resize-none outline-none max-h-[200px] leading-[1.6]"
        />

        {/* Bottom toolbar */}
        <div className="flex items-center justify-between px-3 pb-2.5 pt-0.5">
          {/* Left: attach */}
          <button title="Attach file"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-text-tertiary hover:text-text-secondary hover:bg-white/[0.05] transition-all cursor-pointer no-drag">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>

          {/* Right: model + send */}
          <div className="flex items-center gap-1.5 no-drag relative">
            {isStreaming ? (
              <>
                <button
                  onClick={isPaused ? onResume : onPause}
                  title={isPaused ? 'Resume' : 'Pause'}
                  className={`flex items-center justify-center w-8 h-8 rounded-lg transition-all cursor-pointer ${
                    isPaused ? 'bg-[#8ab4f8]/15 text-[#8ab4f8] hover:bg-[#8ab4f8]/25' : 'bg-amber-500/15 text-amber-400 hover:bg-amber-500/25'
                  }`}
                >
                  {isPaused ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20" /></svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="4" width="4" height="16" rx="1" /><rect x="15" y="4" width="4" height="16" rx="1" /></svg>
                  )}
                </button>

                {canSend && (
                  <button onClick={handleSend} title="Add context"
                    className="flex items-center justify-center w-8 h-8 rounded-lg bg-[#8ab4f8]/15 text-[#8ab4f8] hover:bg-[#8ab4f8]/25 transition-all cursor-pointer">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </button>
                )}

                <button onClick={onStop} title="Stop (Esc)"
                  className="flex items-center justify-center w-8 h-8 rounded-lg bg-red-500/12 text-red-400 hover:bg-red-500/20 transition-all cursor-pointer">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                </button>
              </>
            ) : (
              <>
              {/* Model selector */}
              <button
                onClick={() => setModelOpen(v => !v)}
                className="flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[12px] font-medium text-text-tertiary hover:text-text-secondary hover:bg-white/[0.05] transition-all cursor-pointer"
              >
                {currentModel.label}
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="opacity-50">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {modelOpen && (
                <div className="absolute bottom-full right-0 mb-2 py-1.5 bg-[#1e1e24] border border-white/[0.08] rounded-xl shadow-xl shadow-black/50 min-w-[160px] animate-fade-in z-50">
                  {MODELS.map((m, i) => (
                    <button
                      key={m.id}
                      onClick={() => handleModelChange(i)}
                      className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-left text-[13px] transition-all cursor-pointer ${
                        i === modelIdx ? 'text-text-primary bg-white/[0.06]' : 'text-text-secondary hover:text-text-primary hover:bg-white/[0.04]'
                      }`}
                    >
                      {m.label}
                      {i === modelIdx && (
                        <svg className="ml-auto text-[#8ab4f8]" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {/* Send */}
              <button
                onClick={handleSend}
                disabled={!canSend}
                title="Send (Enter)"
                className={`
                  flex items-center justify-center w-9 h-9 rounded-lg transition-all cursor-pointer
                  ${canSend
                    ? 'bg-[#8ab4f8] text-[#0d0d10] hover:bg-[#aecbfa] shadow-sm shadow-[#8ab4f8]/20'
                    : 'bg-white/[0.06] text-text-tertiary cursor-default'
                  }
                `}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
