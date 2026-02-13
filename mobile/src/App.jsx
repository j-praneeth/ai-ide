import { useState, useEffect, Component } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import BottomNav from './components/BottomNav';
import ScanPage from './pages/ScanPage';
import DashboardPage from './pages/DashboardPage';
import ChatPage from './pages/ChatPage';
import TerminalPage from './pages/TerminalPage';
import FilesPage from './pages/FilesPage';
import nebulaWS from './services/websocket';
import './App.css';

/* Error boundary to catch rendering crashes */
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: 32, textAlign: 'center', color: '#E8E8EC',
          background: '#0D0D12', height: '100vh',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⚠</div>
          <h2 style={{ marginBottom: 8 }}>Something went wrong</h2>
          <p style={{ color: '#9898A8', fontSize: 14, marginBottom: 16 }}>
            {this.state.error?.message || 'Unknown error'}
          </p>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); window.location.hash = '/'; }}
            style={{
              padding: '12px 24px', background: '#D4A843', color: '#0D0D12',
              border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 15,
            }}
          >
            Reload App
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [hasConnection, setHasConnection] = useState(false);
  const [currentPage, setCurrentPage] = useState('dashboard');

  useEffect(() => {
    // Listen for connection state changes
    const unsub = nebulaWS.on('connection', ({ connected }) => {
      setIsConnected(connected);
      if (connected) setHasConnection(true);
    });

    // Try to restore previous connection
    const restored = nebulaWS.restore();
    if (restored) setHasConnection(true);

    return unsub;
  }, []);

  // If not connected and no saved connection, show scanner
  if (!hasConnection) {
    return (
      <ErrorBoundary>
        <ScanPage onConnected={() => setHasConnection(true)} />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <div className="app-container">
        <div className="connection-indicator">
          <span className={`dot ${isConnected ? 'dot-green dot-pulse' : 'dot-red'}`} />
          <span className="connection-text">
            {isConnected ? 'Connected' : 'Reconnecting...'}
          </span>
        </div>

        <div className="page-container">
          {currentPage === 'dashboard' && <DashboardPage />}
          {currentPage === 'chat' && <ChatPage />}
          {currentPage === 'terminal' && <TerminalPage />}
          {currentPage === 'files' && <FilesPage />}
          {currentPage === 'scan' && <ScanPage onConnected={() => { setHasConnection(true); setCurrentPage('dashboard'); }} />}
        </div>

        <BottomNav
          currentPage={currentPage}
          onNavigate={setCurrentPage}
          isConnected={isConnected}
          onDisconnect={() => {
            nebulaWS.disconnect();
            setIsConnected(false);
            setHasConnection(false);
          }}
        />
      </div>
    </ErrorBoundary>
  );
}

export default App;
