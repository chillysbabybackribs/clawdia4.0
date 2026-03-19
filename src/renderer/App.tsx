import React, { useState, useCallback, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import ChatPanel from './components/ChatPanel';
import BrowserPanel from './components/BrowserPanel';
import ConversationsView from './components/ConversationsView';
import SettingsView from './components/SettingsView';
import WelcomeScreen from './components/WelcomeScreen';

export type View = 'chat' | 'conversations' | 'settings';

export default function App() {
  const [activeView, setActiveView] = useState<View>('chat');
  const [browserVisible, setBrowserVisible] = useState(true);
  const [chatKey, setChatKey] = useState(0);
  const [loadConversationId, setLoadConversationId] = useState<string | null>(null);
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null); // null = loading

  // Check for API key on mount
  useEffect(() => {
    const api = (window as any).clawdia;
    if (!api) return;
    api.settings.getApiKey().then((key: string) => {
      setHasApiKey(!!key);
    });
  }, []);

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

  const handleWelcomeComplete = useCallback(() => {
    setHasApiKey(true);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === 'n') { e.preventDefault(); handleNewChat(); }
      if (ctrl && e.key === 'l') { e.preventDefault(); handleNewChat(); }
      if (ctrl && e.key === ',') { e.preventDefault(); setActiveView(v => v === 'settings' ? 'chat' : 'settings'); }
      if (ctrl && e.key === 'h') { e.preventDefault(); setActiveView(v => v === 'conversations' ? 'chat' : 'conversations'); }
      if (ctrl && e.key === 'b') { e.preventDefault(); handleToggleBrowser(); }
      if (e.key === 'Escape' && activeView !== 'chat') setActiveView('chat');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleNewChat, handleToggleBrowser, activeView]);

  // Still loading — show nothing (prevents flash)
  if (hasApiKey === null) {
    return <div className="h-screen w-screen bg-surface-0" />;
  }

  // No API key — show welcome/onboarding
  if (!hasApiKey) {
    return (
      <div className="flex h-screen w-screen overflow-hidden rounded-[10px] border-[2px] border-white/[0.04] bg-surface-0">
        <WelcomeScreen onComplete={handleWelcomeComplete} />
      </div>
    );
  }

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
