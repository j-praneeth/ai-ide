import React from 'react';
import AdminPanel from './components/AdminPanel';
import AuthGate from './components/AuthGate';
import { getAuthUser, logout } from './lib/auth';
import './App.css';

function AdminContent() {
  const user = getAuthUser();
  const isAdmin = user?.role === 'super_admin';

  if (!isAdmin) {
    return (
      <div style={{ 
        display: 'flex', 
        flexDirection: 'column', 
        alignItems: 'center', 
        justifyContent: 'center', 
        height: '80vh',
        padding: 20,
        textAlign: 'center'
      }}>
        <div style={{ fontSize: 48, marginBottom: 20 }}>🔒</div>
        <h2 style={{ color: 'var(--text-primary)', marginBottom: 10 }}>Admin Access Required</h2>
        <p style={{ color: 'var(--text-muted)', maxWidth: 400, marginBottom: 24 }}>
          You are currently signed in as <strong>{user?.email || 'a user'}</strong>, but this area is restricted to Super Admins only.
        </p>
        <button 
          onClick={() => logout(true)}
          style={{
            background: 'var(--accent)',
            color: '#071018',
            border: 'none',
            padding: '12px 24px',
            borderRadius: 8,
            fontWeight: 700,
            cursor: 'pointer',
            fontSize: 14
          }}
        >
          Sign Out & Switch Account
        </button>
      </div>
    );
  }

  return <AdminPanel />;
}

export default function AdminApp() {
  return (
    <AuthGate requireAuth={true}>
      <div style={{ 
        width: '100vw', 
        height: '100vh', 
        background: 'var(--bg-main)', 
        color: 'var(--text-primary)',
        display: 'flex',
        flexDirection: 'column'
      }}>
        <div style={{ 
          padding: '16px 24px', 
          background: 'var(--bg-elevated)', 
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 24 }}>✦</span>
            <h1 style={{ fontSize: 18, margin: 0, fontWeight: 700 }}>Nebula Super Admin</h1>
          </div>
          <button 
            onClick={() => logout(true)}
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--text-muted)',
              padding: '6px 12px',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 12
            }}
          >
            Log Out
          </button>
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <AdminContent />
        </div>
      </div>
    </AuthGate>
  );
}
