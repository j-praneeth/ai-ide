import { useState, useEffect, Component } from 'react';
import BottomNav from './components/BottomNav';
import ScanPage from './pages/ScanPage';
import LiveViewPage from './pages/LiveViewPage';
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
  const [currentPage, setCurrentPage] = useState(null); // null = show live stream only

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

  // Toggle page: tap same tab again to go back to live view
  const handleNavigate = (page) => {
    setCurrentPage(prev => prev === page ? null : page);
  };

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
          {/* Live stream is always rendered in the background */}
          <div style={{ display: currentPage ? 'none' : 'flex', flexDirection: 'column', height: '100%' }}>
            <LiveViewPage />
          </div>

          {/* Other pages overlay on top */}
          {currentPage === 'dashboard' && <DashboardPage />}
          {currentPage === 'chat' && <ChatPage />}
          {currentPage === 'terminal' && <TerminalPage />}
          {currentPage === 'files' && <FilesPage />}
          {currentPage === 'scan' && <ScanPage onConnected={() => { setHasConnection(true); setCurrentPage(null); }} />}
        </div>

        <BottomNav
          currentPage={currentPage}
          onNavigate={handleNavigate}
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
