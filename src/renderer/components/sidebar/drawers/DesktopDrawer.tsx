import React, { useState, useEffect, useCallback, useRef } from 'react';

interface AppInfo {
  name: string;
  pid: number;
  windowId: string;
  memoryMB: number;
}

export default function DesktopDrawer() {
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [platformChecked, setPlatformChecked] = useState(false);
  const [isLinux, setIsLinux] = useState(true);
  const platformCheckedRef = useRef(false);
  const api = (window as any).clawdia;

  const refresh = useCallback(async () => {
    if (!api) return;
    const list = await api.desktop.listApps().catch(() => null as AppInfo[] | null);
    if (!platformCheckedRef.current) {
      setIsLinux(list !== null);
      setPlatformChecked(true);
      platformCheckedRef.current = true;
    }
    setApps(list || []);
  }, []); // stable — reads platformCheckedRef by ref, not by closure

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]); // refresh is now stable, effect only runs once

  const handleFocus = async (windowId: string) => {
    await api.desktop.focusApp(windowId).catch(() => {});
  };

  const handleKill = async (pid: number) => {
    await api.desktop.killApp(pid).catch(() => {});
    setApps(prev => prev.filter(a => a.pid !== pid));
  };

  if (platformChecked && !isLinux) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-3 py-3 border-b border-border">
          <div className="text-[11px] font-semibold text-text-primary">Desktop</div>
        </div>
        <div className="flex-1 flex items-center justify-center px-4 text-center">
          <div className="text-[11px] text-text-muted leading-relaxed">
            Desktop control is available on Linux only.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-3 border-b border-border flex-shrink-0">
        <div className="text-[11px] font-semibold text-text-primary">Desktop</div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="px-3 py-1.5 text-[9px] font-semibold text-text-tertiary uppercase tracking-wider">
          Running Apps {apps.length > 0 && `(${apps.length})`}
        </div>

        {apps.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-text-muted">No windowed apps detected</div>
        )}

        {apps.map(app => (
          <div key={app.pid} className="flex items-center gap-2 px-3 py-2 hover:bg-border-subtle transition-colors group">
            <div className="w-[22px] h-[22px] rounded bg-border flex items-center justify-center text-[11px] flex-shrink-0">
              🖥
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[11px] text-text-secondary truncate">{app.name}</div>
              <div className="text-[9px] text-text-muted mt-0.5">PID {app.pid} · {app.memoryMB} MB</div>
            </div>
            <div className="flex gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => handleFocus(app.windowId)}
                title="Focus"
                className="no-drag w-[20px] h-[20px] flex items-center justify-center rounded bg-border border border-border text-[10px] text-text-tertiary hover:text-text-secondary hover:bg-surface-2 transition-all cursor-pointer"
              >
                ↗
              </button>
              <button
                onClick={() => handleKill(app.pid)}
                title="Kill"
                className="no-drag w-[20px] h-[20px] flex items-center justify-center rounded bg-border border border-border text-[10px] text-text-tertiary hover:text-accent hover:border-accent/30 hover:bg-accent/[0.06] transition-all cursor-pointer"
              >
                ✕
              </button>
            </div>
          </div>
        ))}

        <div className="h-px bg-surface-1 my-2" />
        <div className="px-3 pb-1 text-[9px] font-semibold text-text-tertiary uppercase tracking-wider">Try asking</div>
        {[
          '"Open VS Code and find all TODOs"',
          '"Open Spotify and play something"',
          '"Take a screenshot of this window"',
        ].map(prompt => (
          <div key={prompt} className="px-3 py-1 text-[10px] text-text-muted italic">{prompt}</div>
        ))}
      </div>
    </div>
  );
}
