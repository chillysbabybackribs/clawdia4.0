import React from 'react';

export type DrawerMode = 'chat' | 'agents' | 'browser' | 'files' | 'desktop';

interface RailProps {
  activeMode: DrawerMode | null; // null = drawer closed
  onModeChange: (mode: DrawerMode) => void;
  onSettings: () => void;
}

function RailIcon({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`no-drag relative flex items-center justify-center w-[34px] h-[34px] rounded-lg transition-all cursor-pointer flex-shrink-0
        ${active
          ? 'bg-surface-1 text-text-primary'
          : 'text-text-muted hover:text-text-tertiary hover:bg-surface-1'
        }`}
    >
      {active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-[16px] bg-accent rounded-r-[2px]" />
      )}
      {children}
    </button>
  );
}

// SVG icons
const icons = {
  chat: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  agents: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),
  browser: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  ),
  files: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3h6l2 3h10a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    </svg>
  ),
  desktop: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  ),
  settings: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
};

const MODES: { mode: DrawerMode; title: string }[] = [
  { mode: 'chat', title: 'Conversations' },
  { mode: 'agents', title: 'Agents' },
  { mode: 'browser', title: 'Browser Sessions' },
  { mode: 'files', title: 'Files' },
  { mode: 'desktop', title: 'Desktop' },
];

export default function Rail({ activeMode, onModeChange, onSettings }: RailProps) {
  return (
    <div className="flex flex-col items-center w-[48px] flex-shrink-0 py-2.5 gap-1 bg-surface-0 border-r border-border">
      {/* Brand */}
      <div className="drag-region flex items-center justify-center w-[28px] h-[28px] rounded-lg bg-accent flex-shrink-0 mb-2">
        <span className="text-[11px] font-black text-white select-none">C</span>
      </div>

      <div className="w-[18px] h-px bg-surface-1 flex-shrink-0" />

      {/* Mode icons */}
      {MODES.map(({ mode, title }) => (
        <RailIcon
          key={mode}
          active={activeMode === mode}
          onClick={() => onModeChange(mode)}
          title={title}
        >
          {icons[mode]}
        </RailIcon>
      ))}

      <div className="flex-1" />

      {/* Settings */}
      <RailIcon active={false} onClick={onSettings} title="Settings">
        {icons.settings}
      </RailIcon>
    </div>
  );
}
