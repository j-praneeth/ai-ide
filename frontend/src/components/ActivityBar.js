import React from 'react';
import {
  VscFiles,
  VscSearch,
  VscSourceControl,
  VscExtensions,
  VscSettingsGear,
  VscAccount,
  VscComment,
  VscGraph,
} from 'react-icons/vsc';
import { getAuthUser, logout } from '../lib/auth';
import { AUTH_URL as AUTH } from '../config';
import { startSsoLogin as startSsoLoginFlow } from '../lib/sso';

const ACTIVITY_ITEMS = [
  { id: 'explorer', icon: VscFiles, label: 'Explorer (⌘⇧E)' },
  { id: 'search', icon: VscSearch, label: 'Search (⌘⇧F)' },
  { id: 'source-control', icon: VscSourceControl, label: 'Source Control (⌘⇧G)' },
  { id: 'extensions', icon: VscExtensions, label: 'Extensions (⌘⇧X)' },
  { id: 'usage', icon: VscGraph, label: 'Token Usage' },
  { id: 'settings', icon: VscSettingsGear, label: 'Settings (⌘,)' },
  { id: 'account', icon: VscAccount, label: 'Account' },
  { id: 'chat', icon: VscComment, label: 'AI Chat (⌘L)' },
];

export default function ActivityBar({ activePanel, onPanelChange, chatOpen, onToggleChat }) {
  const items = ACTIVITY_ITEMS;

  const showAccountMenu = (e) => {
    const u = getAuthUser();
    const existing = document.getElementById('account-context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'account-context-menu';
    menu.style.cssText = `
      position: fixed; bottom: 50px; left: 10px; z-index: 10001;
      background: var(--bg-elevated); border: 1px solid var(--border);
      border-radius: 8px; padding: 6px; min-width: 200px;
      box-shadow: var(--shadow-lg); animation: fadeInUp 0.15s ease;
    `;

    const info = document.createElement('div');
    info.style.cssText = 'padding: 8px 12px; font-size: 11px; color: var(--text-muted); border-bottom: 1px solid var(--border); margin-bottom: 4px;';
    info.textContent = u?.email ? `Logged in as ${u.email}` : 'Not signed in';
    menu.appendChild(info);

    if (u) {
      if (u.role === 'super_admin') {
        const adminBtn = document.createElement('div');
        adminBtn.className = 'menu-item';
        adminBtn.style.cssText = 'padding: 8px 12px; font-size: 12px; color: var(--accent); cursor: pointer; border-radius: 4px; font-weight: 700;';
        adminBtn.textContent = 'Open Admin Panel ↗';
        adminBtn.onmouseenter = () => adminBtn.style.background = 'var(--bg-surface)';
        adminBtn.onmouseleave = () => adminBtn.style.background = 'transparent';
        adminBtn.onclick = () => {
          const url = window.location.origin + window.location.pathname + '#/admin';
          window.open(url, '_blank');
          menu.remove();
        };
        menu.appendChild(adminBtn);
      }

      const logoutBtn = document.createElement('div');
      logoutBtn.className = 'menu-item';
      logoutBtn.style.cssText = 'padding: 8px 12px; font-size: 12px; color: var(--text-primary); cursor: pointer; border-radius: 4px;';
      logoutBtn.textContent = 'Log Out';
      logoutBtn.onmouseenter = () => logoutBtn.style.background = 'var(--bg-surface)';
      logoutBtn.onmouseleave = () => logoutBtn.style.background = 'transparent';
      logoutBtn.onclick = () => {
        logout();
        menu.remove();
      };
      menu.appendChild(logoutBtn);
    } else {
      const loginBtn = document.createElement('div');
      loginBtn.className = 'menu-item';
      loginBtn.style.cssText = 'padding: 8px 12px; font-size: 12px; color: var(--text-primary); cursor: pointer; border-radius: 4px;';
      loginBtn.textContent = 'Log In';
      loginBtn.onmouseenter = () => loginBtn.style.background = 'var(--bg-surface)';
      loginBtn.onmouseleave = () => loginBtn.style.background = 'transparent';
      loginBtn.onclick = () => {
        startSsoLoginFlow(AUTH, { redirectUri: 'nebula://auth' }).catch(() => {
          window.location.search = '?login=true';
        });
        menu.remove();
      };
      menu.appendChild(loginBtn);
    }

    document.body.appendChild(menu);

    const closeMenu = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener('mousedown', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', closeMenu), 10);
  };

  return (
    <div className="activity-bar-horizontal">
      {items.map(item => {
        const isActive =
          (item.id === 'chat' && (chatOpen || activePanel === 'chat')) ||
          (item.id !== 'chat' && activePanel === item.id);

        return (
          <button
            key={item.id}
            className={`activity-bar-h-item ${isActive ? 'active' : ''}`}
            onClick={(e) => {
              if (item.id === 'chat') {
                if (typeof onToggleChat === 'function') onToggleChat();
                else onPanelChange(activePanel === item.id ? null : item.id);
              } else if (item.id === 'account') {
                showAccountMenu(e);
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
