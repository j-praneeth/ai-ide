import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  VscFile,
  VscSettingsGear,
  VscTerminal,
  VscSearch,
  VscNewFile,
  VscSave,
  VscSaveAll,
  VscSplitHorizontal,
  VscSourceControl,
  VscExtensions,
  VscComment,
  VscClose,
  VscInfo,
  VscFolderOpened,
  VscEmptyWindow,
} from 'react-icons/vsc';

const COMMANDS = [
  // File
  { id: 'file.newFile', label: 'New File', icon: VscNewFile, category: 'File' },
  { id: 'file.openFolder', label: 'Open Folder...', icon: VscFolderOpened, category: 'File', shortcut: '⌘O' },
  { id: 'file.newWindow', label: 'New Window', icon: VscEmptyWindow, category: 'File', shortcut: '⌘⇧N' },
  { id: 'file.save', label: 'Save File', icon: VscSave, category: 'File', shortcut: '⌘S' },
  { id: 'file.saveAll', label: 'Save All', icon: VscSaveAll, category: 'File', shortcut: '⌘⇧S' },
  { id: 'file.closeTab', label: 'Close Tab', icon: VscClose, category: 'File', shortcut: '⌘W' },
  { id: 'file.closeAllTabs', label: 'Close All Tabs', icon: VscClose, category: 'File' },

  // View
  { id: 'view.terminal', label: 'Toggle Terminal', icon: VscTerminal, category: 'View', shortcut: '⌘`' },
  { id: 'view.sidebar', label: 'Toggle Sidebar', icon: VscSearch, category: 'View', shortcut: '⌘B' },
  { id: 'view.chat', label: 'Toggle AI Chat', icon: VscComment, category: 'View', shortcut: '⌘L' },
  { id: 'view.explorer', label: 'Show Explorer', icon: VscFile, category: 'View', shortcut: '⌘⇧E' },
  { id: 'view.search', label: 'Show Search', icon: VscSearch, category: 'View', shortcut: '⌘⇧F' },
  { id: 'view.sourceControl', label: 'Show Source Control', icon: VscSourceControl, category: 'View', shortcut: '⌘⇧G' },
  { id: 'view.extensions', label: 'Show Extensions', icon: VscExtensions, category: 'View', shortcut: '⌘⇧X' },
  { id: 'view.settings', label: 'Open Settings', icon: VscSettingsGear, category: 'View', shortcut: '⌘,' },

  // Editor
  { id: 'editor.split', label: 'Split Editor', icon: VscSplitHorizontal, category: 'Editor' },
  { id: 'edit.find', label: 'Find in File', icon: VscSearch, category: 'Editor', shortcut: '⌘F' },
  { id: 'edit.replace', label: 'Find and Replace', icon: VscSearch, category: 'Editor', shortcut: '⌘H' },

  // Go
  { id: 'go.goToLine', label: 'Go to Line', icon: VscFile, category: 'Go', shortcut: '⌘G' },
  { id: 'go.goToSymbol', label: 'Go to Symbol', icon: VscFile, category: 'Go', shortcut: '⌘⇧O' },

  // Terminal
  { id: 'terminal.new', label: 'New Terminal', icon: VscTerminal, category: 'Terminal' },

  // Help
  { id: 'help.about', label: 'About Nebula IDE', icon: VscInfo, category: 'Help' },
  { id: 'help.shortcuts', label: 'Keyboard Shortcuts', icon: VscInfo, category: 'Help' },
];

export default function CommandPalette({ visible, onClose, onExecuteCommand, openFiles }) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const filteredCommands = useMemo(() => {
    const isCommandMode = query.startsWith('>');
    const search = isCommandMode ? query.slice(1).trim().toLowerCase() : query.toLowerCase();

    if (isCommandMode) {
      return COMMANDS.filter(cmd =>
        cmd.label.toLowerCase().includes(search) ||
        cmd.category.toLowerCase().includes(search)
      );
    }

    // File mode: search open files + all commands
    const fileResults = (openFiles || [])
      .filter(f => f.toLowerCase().includes(search))
      .map(f => ({
        id: `file:${f}`,
        label: f.split('/').pop(),
        description: f,
        icon: VscFile,
        category: 'Open Files',
        isFile: true,
        path: f,
      }));

    const cmdResults = search
      ? COMMANDS.filter(cmd => cmd.label.toLowerCase().includes(search))
      : [];

    return [...fileResults, ...cmdResults];
  }, [query, openFiles]);

  useEffect(() => {
    if (visible) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [visible]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = (e) => {
    switch (e.key) {
      case 'Escape':
        onClose();
        break;
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(prev => Math.min(prev + 1, filteredCommands.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(prev => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (filteredCommands[selectedIndex]) {
          const cmd = filteredCommands[selectedIndex];
          onExecuteCommand(cmd.isFile ? cmd.path : cmd.id);
          onClose();
        }
        break;
      default:
        break;
    }
  };

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selected = listRef.current.children[selectedIndex];
      if (selected) {
        selected.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex]);

  if (!visible) return null;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette" onClick={e => e.stopPropagation()}>
        <div className="command-palette-input-wrapper">
          <input
            ref={inputRef}
            className="command-palette-input"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type '>' for commands, or search files..."
          />
        </div>
        <div className="command-palette-list" ref={listRef}>
          {filteredCommands.length === 0 && (
            <div className="command-palette-empty">No matching commands</div>
          )}
          {filteredCommands.map((cmd, idx) => (
            <div
              key={cmd.id}
              className={`command-palette-item ${idx === selectedIndex ? 'selected' : ''}`}
              onClick={() => {
                onExecuteCommand(cmd.isFile ? cmd.path : cmd.id);
                onClose();
              }}
              onMouseEnter={() => setSelectedIndex(idx)}
            >
              <div className="command-palette-item-icon">
                <cmd.icon size={16} />
              </div>
              <div className="command-palette-item-content">
                <span className="command-palette-item-label">{cmd.label}</span>
                {cmd.description && (
                  <span className="command-palette-item-desc">{cmd.description}</span>
                )}
              </div>
              {cmd.shortcut && (
                <span className="command-palette-item-shortcut">{cmd.shortcut}</span>
              )}
              <span className="command-palette-item-category">{cmd.category}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
