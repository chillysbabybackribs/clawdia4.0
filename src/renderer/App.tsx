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

  // When browser panel is hidden, send zero bounds to hide the native BrowserView
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
