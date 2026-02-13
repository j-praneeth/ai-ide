import React from 'react';
import {
  VscFiles,
  VscSearch,
  VscSourceControl,
  VscExtensions,
  VscSettingsGear,
  VscAccount,
  VscComment,
} from 'react-icons/vsc';

const ACTIVITY_ITEMS = [
  { id: 'explorer', icon: VscFiles, label: 'Explorer (⌘⇧E)' },
  { id: 'search', icon: VscSearch, label: 'Search (⌘⇧F)' },
  { id: 'source-control', icon: VscSourceControl, label: 'Source Control (⌘⇧G)' },
  { id: 'extensions', icon: VscExtensions, label: 'Extensions (⌘⇧X)' },
  { id: 'settings', icon: VscSettingsGear, label: 'Settings (⌘,)' },
  { id: 'account', icon: VscAccount, label: 'Account' },
  { id: 'chat', icon: VscComment, label: 'AI Chat (⌘L)' },
];

export default function ActivityBar({ activePanel, onPanelChange, chatOpen, onToggleChat }) {
  return (
    <div className="activity-bar-horizontal">
      {ACTIVITY_ITEMS.map(item => {
        const isActive =
          (item.id === 'chat' && chatOpen) ||
          (item.id !== 'chat' && activePanel === item.id);

        return (
          <button
            key={item.id}
            className={`activity-bar-h-item ${isActive ? 'active' : ''}`}
            onClick={() => {
              if (item.id === 'chat') {
                onToggleChat();
              } else if (item.id === 'account') {
                const el = document.createElement('div');
                el.className = 'toast-notification';
                el.textContent = 'Signed in as Local User';
                el.style.cssText = `
                  position: fixed; bottom: 40px; right: 16px; z-index: 10000;
                  background: var(--bg-elevated); color: var(--text-primary);
                  padding: 10px 18px; border-radius: var(--radius-md);
                  border: 1px solid var(--border); font-size: var(--font-size-sm);
                  box-shadow: var(--shadow-lg); animation: fadeInUp 0.2s ease;
                `;
                document.body.appendChild(el);
                setTimeout(() => el.remove(), 2500);
              } else {
                onPanelChange(activePanel === item.id ? null : item.id);
              }
            }}
            title={item.label}
          >
            <item.icon size={18} />
          </button>
        );
      })}
    </div>
  );
}
