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

const TOP_ITEMS = [
  { id: 'explorer', icon: VscFiles, label: 'Explorer (⌘⇧E)' },
  { id: 'search', icon: VscSearch, label: 'Search (⌘⇧F)' },
  { id: 'source-control', icon: VscSourceControl, label: 'Source Control (⌘⇧G)' },
  { id: 'extensions', icon: VscExtensions, label: 'Extensions (⌘⇧X)' },
  { id: 'usage', icon: VscGraph, label: 'Token Usage' },
  { id: 'chat', icon: VscComment, label: 'AI Chat (⌘L)' },
];

const BOTTOM_ITEMS = [
  { id: 'settings', icon: VscSettingsGear, label: 'Settings (⌘,)' },
  { id: 'account', icon: VscAccount, label: 'Account' },
];

export default function ActivityBar({ activePanel, onPanelChange, chatOpen, onToggleChat }) {
  const showAccountMenu = (e) => {
    const u = getAuthUser();
    const existing = document.getElementById('account-context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'account-context-menu';
    menu.style.cssText = `
      position: fixed; bottom: 60px; left: 58px; z-index: 10001;
      background: var(--bg-elevated); border: 1px solid var(--border);
      border-radius: 6px; padding: 4px; min-width: 200px;
      box-shadow: var(--shadow-lg); animation: fadeInUp 0.12s ease;
    `;

    const info = document.createElement('div');
    info.style.cssText = 'padding: 8px 10px; font-size: 11px; color: var(--text-muted); border-bottom: 1px solid var(--border); margin-bottom: 4px;';
    info.textContent = u?.email ? `Signed in as ${u.email}` : 'Not signed in';
    menu.appendChild(info);

    if (u) {
      if (u.role === 'super_admin') {
        const adminBtn = document.createElement('div');
        adminBtn.style.cssText = 'padding: 7px 10px; font-size: 12px; color: var(--accent); cursor: pointer; border-radius: 3px; font-weight: 600;';
        adminBtn.textContent = 'Open Admin Panel';
        adminBtn.onmouseenter = () => adminBtn.style.background = 'var(--bg-hover)';
        adminBtn.onmouseleave = () => adminBtn.style.background = 'transparent';
        adminBtn.onclick = () => {
          const url = window.location.origin + window.location.pathname + '#/admin';
          window.open(url, '_blank');
          menu.remove();
        };
        menu.appendChild(adminBtn);
      }
      const logoutBtn = document.createElement('div');
      logoutBtn.style.cssText = 'padding: 7px 10px; font-size: 12px; color: var(--text-primary); cursor: pointer; border-radius: 3px;';
      logoutBtn.textContent = 'Log Out';
      logoutBtn.onmouseenter = () => logoutBtn.style.background = 'var(--bg-hover)';
      logoutBtn.onmouseleave = () => logoutBtn.style.background = 'transparent';
      logoutBtn.onclick = () => { logout(); menu.remove(); };
      menu.appendChild(logoutBtn);
    } else {
      const loginBtn = document.createElement('div');
      loginBtn.style.cssText = 'padding: 7px 10px; font-size: 12px; color: var(--text-primary); cursor: pointer; border-radius: 3px;';
      loginBtn.textContent = 'Log In';
      loginBtn.onmouseenter = () => loginBtn.style.background = 'var(--bg-hover)';
      loginBtn.onmouseleave = () => loginBtn.style.background = 'transparent';
      loginBtn.onclick = () => {
        startSsoLoginFlow(AUTH, { redirectUri: 'nebula://auth' }).catch(() => { window.location.search = '?login=true'; });
        menu.remove();
      };
      menu.appendChild(loginBtn);
    }

    document.body.appendChild(menu);
    const closeMenu = (ev) => {
      if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', closeMenu); }
    };
    setTimeout(() => document.addEventListener('mousedown', closeMenu), 10);
  };

  const handleItemClick = (e, item) => {
    if (item.id === 'chat') {
      if (typeof onToggleChat === 'function') onToggleChat();
      else onPanelChange(activePanel === item.id ? null : item.id);
    } else if (item.id === 'account') {
      showAccountMenu(e);
    } else {
      onPanelChange(activePanel === item.id ? null : item.id);
    }
  };

  const isActive = (item) =>
    (item.id === 'chat' && (chatOpen || activePanel === 'chat')) ||
    (item.id !== 'chat' && activePanel === item.id);

  const renderItem = (item) => (
    <button
      key={item.id}
      className={`activity-bar-item ${isActive(item) ? 'active' : ''}`}
      onClick={(e) => handleItemClick(e, item)}
      title={item.label}
    >
      <item.icon size={22} />
    </button>
  );

  return (
    <div className="activity-bar-vertical">
      <div className="activity-bar-top">
        {TOP_ITEMS.map(renderItem)}
      </div>
      <div className="activity-bar-bottom">
        {BOTTOM_ITEMS.map(renderItem)}
      </div>
    </div>
  );
}
