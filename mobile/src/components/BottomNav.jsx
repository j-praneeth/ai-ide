import './BottomNav.css';

const tabs = [
  { id: 'chat', icon: '◉', label: 'Chat' },
  { id: 'terminal', icon: '⌘', label: 'Terminal' },
  { id: 'files', icon: '◧', label: 'Files' },
  { id: 'dashboard', icon: '◈', label: 'Activity' },
];

export default function BottomNav({ currentPage, onNavigate, isConnected, onDisconnect }) {
  return (
    <nav className="bottom-nav">
      {tabs.map(tab => (
        <button
          key={tab.id}
          className={`nav-tab ${currentPage === tab.id ? 'active' : ''}`}
          onClick={() => onNavigate(tab.id)}
        >
          <span className="nav-icon">{tab.icon}</span>
          <span className="nav-label">{tab.label}</span>
        </button>
      ))}
      <button
        className="nav-tab nav-tab-scan"
        onClick={() => {
          if (isConnected) {
            onDisconnect();
          } else {
            onNavigate('scan');
          }
        }}
      >
        <span className="nav-icon">{isConnected ? '⊗' : '⊕'}</span>
        <span className="nav-label">{isConnected ? 'Exit' : 'Scan'}</span>
      </button>
    </nav>
  );
}
