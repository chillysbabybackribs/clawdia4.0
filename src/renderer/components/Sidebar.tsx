import React, { useState, useEffect } from 'react';
import type { View } from '../App';
import Rail, { type DrawerMode } from './sidebar/Rail';
import ChatDrawer from './sidebar/drawers/ChatDrawer';
import AgentsDrawer from './sidebar/drawers/AgentsDrawer';
import BrowserDrawer from './sidebar/drawers/BrowserDrawer';
import FilesDrawer from './sidebar/drawers/FilesDrawer';
import DesktopDrawer from './sidebar/drawers/DesktopDrawer';

interface SidebarProps {
  onViewChange: (view: View) => void;
  onNewChat: () => void;
  onLoadConversation: (conversationId: string, buffer?: Array<{ type: string; data: any }> | null) => void;
  onOpenProcess: (processId: string) => void;
  chatKey: number;
}

export default function Sidebar({
  onViewChange, onNewChat, onLoadConversation, onOpenProcess, chatKey,
}: SidebarProps) {
  const [activeMode, setActiveMode] = useState<DrawerMode>('chat');
  const [drawerOpen, setDrawerOpen] = useState(true);

  // Ctrl+S toggles drawer
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's' && !e.shiftKey) {
        e.preventDefault();
        setDrawerOpen(v => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const handleModeChange = (mode: DrawerMode) => {
    if (activeMode === mode) {
      setDrawerOpen(v => !v); // toggle if clicking active
    } else {
      setActiveMode(mode);
      setDrawerOpen(true);
    }
  };

  const handleAddContext = async (text: string, _filePath: string) => {
    const api = (window as any).clawdia;
    if (!api) return;
    await api.chat.addContext(text).catch(() => {});
  };

  return (
    <nav className="flex h-full flex-shrink-0">
      <Rail
        activeMode={drawerOpen ? activeMode : null}
        onModeChange={handleModeChange}
        onSettings={() => onViewChange('settings')}
      />

      {drawerOpen && (
        <div className="w-[210px] flex-shrink-0 bg-surface-0 border-r border-border flex flex-col overflow-hidden">
          {activeMode === 'chat' && (
            <ChatDrawer
              onNewChat={onNewChat}
              onLoadConversation={onLoadConversation}
              onOpenProcess={onOpenProcess}
              chatKey={chatKey}
            />
          )}
          {activeMode === 'agents' && (
            <AgentsDrawer
              onNewChat={onNewChat}
              onOpenProcess={onOpenProcess}
            />
          )}
          {activeMode === 'browser' && <BrowserDrawer />}
          {activeMode === 'files' && <FilesDrawer onAddContext={handleAddContext} />}
          {activeMode === 'desktop' && <DesktopDrawer />}
        </div>
      )}
    </nav>
  );
}
