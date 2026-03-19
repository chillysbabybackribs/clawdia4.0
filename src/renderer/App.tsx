import React, { useState, useCallback, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import ChatPanel from './components/ChatPanel';
import BrowserPanel from './components/BrowserPanel';
import ConversationsView from './components/ConversationsView';
import SettingsView from './components/SettingsView';

export type View = 'chat' | 'conversations' | 'settings';

export default function App() {
  const [activeView, setActiveView] = useState<View>('chat');
  const [browserVisible, setBrowserVisible] = useState(true);
  const [chatKey, setChatKey] = useState(0);
  const [loadConversationId, setLoadConversationId] = useState<string | null>(null);

  // Hide native BrowserView when panel is toggled off
  useEffect(() => {
    if (!browserVisible) {
      (window as any).clawdia?.browser.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
  }, [browserVisible]);

  const handleNewChat = useCallback(async () => {
    const api = (window as any).clawdia;
    if (api) await api.chat.new();
    setLoadConversationId(null);
    setChatKey(k => k + 1);
    setActiveView('chat');
  }, []);

  const handleLoadConversation = useCallback(async (id: string) => {
    setLoadConversationId(id);
    setChatKey(k => k + 1);
    setActiveView('chat');
  }, []);

  const handleToggleBrowser = useCallback(() => {
    setBrowserVisible(v => !v);
  }, []);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;

      // Ctrl+N — New chat
      if (ctrl && e.key === 'n') {
        e.preventDefault();
        handleNewChat();
      }
      // Ctrl+L — Clear / new chat (same as Ctrl+N)
      if (ctrl && e.key === 'l') {
        e.preventDefault();
        handleNewChat();
      }
      // Ctrl+, — Settings
      if (ctrl && e.key === ',') {
        e.preventDefault();
        setActiveView(v => v === 'settings' ? 'chat' : 'settings');
      }
      // Ctrl+H — History / Conversations
      if (ctrl && e.key === 'h') {
        e.preventDefault();
        setActiveView(v => v === 'conversations' ? 'chat' : 'conversations');
      }
      // Ctrl+B — Toggle browser panel
      if (ctrl && e.key === 'b') {
        e.preventDefault();
        handleToggleBrowser();
      }
      // Escape — Back to chat from any view
      if (e.key === 'Escape' && activeView !== 'chat') {
        setActiveView('chat');
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleNewChat, handleToggleBrowser, activeView]);

  return (
    <div className="flex h-screen w-screen overflow-hidden rounded-[10px] border-[2px] border-white/[0.04]">
      <Sidebar
        activeView={activeView}
        onViewChange={setActiveView}
        onNewChat={handleNewChat}
      />

      <div
        className="relative flex flex-col min-w-0 h-full"
        style={{ flex: browserVisible ? '35 0 0' : '1 0 0' }}
      >
        {activeView === 'chat' && (
          <ChatPanel
            key={chatKey}
            browserVisible={browserVisible}
            onToggleBrowser={handleToggleBrowser}
            loadConversationId={loadConversationId}
          />
        )}
        {activeView === 'conversations' && (
          <ConversationsView
            onBack={() => setActiveView('chat')}
            onLoadConversation={handleLoadConversation}
          />
        )}
        {activeView === 'settings' && (
          <SettingsView onBack={() => setActiveView('chat')} />
        )}
      </div>

      {browserVisible && (
        <div
          className="flex flex-col min-w-0 h-full border-l-[2px] border-white/[0.04]"
          style={{ flex: '65 0 0' }}
        >
          <BrowserPanel />
        </div>
      )}
    </div>
  );
}
