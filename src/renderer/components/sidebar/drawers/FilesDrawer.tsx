import React, { useState, useEffect, useCallback } from 'react';

interface FsEntry {
  name: string;
  type: 'file' | 'dir';
  path: string;
}

interface FilesDrawerProps {
  onAddContext: (text: string, filePath: string) => void;
}

const PINNED = [
  { label: 'Home', path: '~' },
  { label: 'Desktop', path: '~/Desktop' },
  { label: 'Downloads', path: '~/Downloads' },
];

const FILE_ICON: Record<string, string> = {
  ts: '📘', tsx: '📘', js: '📄', jsx: '📄', json: '📋',
  md: '📝', txt: '📝', py: '🐍', sh: '⚙', css: '🎨',
  html: '🌐', pdf: '📕', png: '🖼', jpg: '🖼', jpeg: '🖼',
  zip: '📦', tar: '📦', gz: '📦',
};

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return FILE_ICON[ext] || '📄';
}

export default function FilesDrawer({ onAddContext }: FilesDrawerProps) {
  const [root, setRoot] = useState('~');
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [expanded, setExpanded] = useState<Record<string, FsEntry[]>>({});
  const [search, setSearch] = useState('');
  const [attaching, setAttaching] = useState<string | null>(null);
  const api = (window as any).clawdia;

  const loadDir = useCallback(async (dirPath: string) => {
    if (!api) return;
    try {
      const items: FsEntry[] = await api.fs.readDir(dirPath);
      // Sort: dirs first, then files, both alphabetical
      items.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setEntries(items);
    } catch {}
  }, []);

  useEffect(() => { loadDir(root); }, [root, loadDir]);

  const toggleDir = async (entry: FsEntry) => {
    if (expanded[entry.path]) {
      setExpanded(prev => { const n = { ...prev }; delete n[entry.path]; return n; });
    } else {
      if (!api) return;
      const children: FsEntry[] = await api.fs.readDir(entry.path) || [];
      children.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setExpanded(prev => ({ ...prev, [entry.path]: children }));
    }
  };

  const handleFileClick = async (entry: FsEntry) => {
    setAttaching(entry.path);
    try {
      const content: string = await api.fs.readFile(entry.path);
      onAddContext(content, entry.path);
    } catch (err: any) {
      if (err?.message?.includes('too large')) {
        alert(`File too large to attach (max 500KB): ${entry.name}`);
      }
    }
    setAttaching(null);
  };

  const filteredEntries = search
    ? entries.filter(e => e.name.toLowerCase().includes(search.toLowerCase()))
    : entries;

  function renderEntry(entry: FsEntry, depth = 0): React.ReactNode {
    const isExpanded = !!expanded[entry.path];
    const children = expanded[entry.path] || [];
    const indent = depth * 12;

    return (
      <React.Fragment key={entry.path}>
        <div
          role="button"
          onClick={() => entry.type === 'dir' ? toggleDir(entry) : handleFileClick(entry)}
          className="flex items-center gap-1.5 px-2 py-[3px] hover:bg-white/[0.04] transition-colors cursor-pointer group"
          style={{ paddingLeft: `${8 + indent}px` }}
        >
          <span className="text-[11px] flex-shrink-0">
            {entry.type === 'dir' ? (isExpanded ? '📂' : '📁') : fileIcon(entry.name)}
          </span>
          <span className={`text-[11px] flex-1 truncate ${entry.type === 'dir' ? 'text-text-secondary/60' : 'text-text-secondary/50'}`}>
            {entry.name}
          </span>
          {entry.type === 'file' && (
            <span className="text-[9px] text-text-secondary/20 flex-shrink-0">
              {entry.name.split('.').pop()?.toLowerCase()}
            </span>
          )}
          {attaching === entry.path && (
            <span className="text-[9px] text-accent flex-shrink-0">...</span>
          )}
        </div>
        {isExpanded && children.map(child => renderEntry(child, depth + 1))}
      </React.Fragment>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-3 border-b border-[#141420] flex-shrink-0">
        <div className="text-[11px] font-semibold text-text-primary mb-2">Files</div>
        <div className="relative">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary/40 pointer-events-none">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text" placeholder="Search files..."
            value={search} onChange={e => setSearch(e.target.value)}
            className="w-full h-[26px] pl-7 pr-2 rounded bg-white/[0.04] border border-[#1a1a2a] text-[11px] text-text-primary placeholder-text-secondary/40 outline-none focus:border-accent/30 transition-all"
          />
        </div>
      </div>

      {/* Pinned */}
      <div className="flex-shrink-0">
        <div className="px-3 py-1.5 text-[9px] font-semibold text-text-secondary/40 uppercase tracking-wider">Pinned</div>
        {PINNED.map(({ label, path }) => (
          <button key={path} onClick={() => { setRoot(path); setExpanded({}); setSearch(''); }}
            className={`no-drag w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-white/[0.04] transition-colors cursor-pointer
              ${root === path ? 'text-text-primary' : 'text-text-secondary/50'}`}>
            <span className="text-[11px]">
              {label === 'Home' ? '🏠' : label === 'Desktop' ? '🖥' : '⬇'}
            </span>
            <span className="text-[11px]">{label}</span>
          </button>
        ))}
        <div className="h-px bg-[#111120] my-1" />
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="px-3 py-1.5 text-[9px] font-semibold text-text-secondary/40 uppercase tracking-wider truncate">{root}</div>
        {filteredEntries.map(entry => renderEntry(entry))}
        {filteredEntries.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-text-secondary/30">
            {search ? 'No matches' : 'Empty folder'}
          </div>
        )}
        <div className="h-px bg-[#111120] my-2" />
        <div className="px-3 pb-3 text-[10px] text-text-secondary/30">Click a file to add it to the current chat as context.</div>
      </div>
    </div>
  );
}
