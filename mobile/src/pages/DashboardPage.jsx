import { useState, useEffect, useRef } from 'react';
import nebulaWS from '../services/websocket';
import './DashboardPage.css';

function timeAgo(ts) {
  if (!ts) return '';
  const diff = (Date.now() / 1000) - ts;
  if (diff < 5) return 'just now';
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function eventIcon(type) {
  switch (type) {
    case 'terminal_output': return '⌘';
    case 'thinking': return '◌';
    case 'step': return '▸';
    case 'tool_result': return '◈';
    case 'done': return '✓';
    case 'error': case 'agent_error': return '✗';
    case 'mobile_prompt': return '◉';
    case 'file_change': return '◧';
    case 'connected': return '●';
    default: return '·';
  }
}

function eventColor(type) {
  switch (type) {
    case 'done': return 'var(--success)';
    case 'error': case 'agent_error': return 'var(--error)';
    case 'thinking': return 'var(--warning)';
    case 'step': case 'tool_result': return 'var(--blue)';
    case 'terminal_output': return 'var(--purple)';
    case 'mobile_prompt': return 'var(--accent)';
    default: return 'var(--text-muted)';
  }
}

export default function DashboardPage() {
  const [events, setEvents] = useState([]);
  const [workspace, setWorkspace] = useState('');
  const [desktopOnline, setDesktopOnline] = useState(nebulaWS.desktopOnline);
  const feedRef = useRef(null);

  useEffect(() => {
    // Load existing events
    setEvents([...nebulaWS.events].reverse().slice(0, 100));

    // Request IDE status
    if (nebulaWS.connected) {
      nebulaWS.requestStatus();
    }

    // Listen for new events
    const unsub = nebulaWS.on('message', (data) => {
      if (data.type === 'ide_status') {
        setWorkspace(data.workspace_name || '');
      }
      if (data.type === 'desktop_status') {
        setDesktopOnline(data.online);
      }
      setEvents(prev => [data, ...prev].slice(0, 100));
    });

    return unsub;
  }, []);

  useEffect(() => {
    // Auto-scroll to top on new events (newest first)
    if (feedRef.current) {
      feedRef.current.scrollTop = 0;
    }
  }, [events]);

  return (
    <div className="page dashboard-page">
      <div className="page-header">
        <h1>Live Activity</h1>
        {workspace && <p>Workspace: {workspace}</p>}
        {nebulaWS.mode === 'relay' && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, marginTop: 6,
            fontSize: 12, color: desktopOnline ? 'var(--success)' : 'var(--text-muted)',
          }}>
            <span className={`dot ${desktopOnline ? 'dot-green dot-pulse' : 'dot-red'}`} />
            Desktop {desktopOnline ? 'online' : 'offline'}
            {nebulaWS.roomCode && <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>Room: {nebulaWS.roomCode}</span>}
          </div>
        )}
      </div>

      <div className="page-content" ref={feedRef}>
        {events.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">◈</div>
            <div className="empty-state-text">
              No activity yet.<br />
              Start using Nebula IDE on your desktop to see live updates here.
            </div>
          </div>
        ) : (
          <div className="activity-feed">
            {events.map((event, i) => (
              <ActivityCard key={`${event.timestamp}-${i}`} event={event} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ActivityCard({ event }) {
  const icon = eventIcon(event.type);
  const color = eventColor(event.type);

  let title = '';
  let detail = '';

  switch (event.type) {
    case 'terminal_output':
      title = `Terminal: ${event.command || ''}`;
      detail = event.output || '';
      break;
    case 'thinking':
      title = 'Agent Thinking';
      detail = event.text || '';
      break;
    case 'step':
      title = event.message || 'Agent Step';
      detail = event.tool ? `Tool: ${event.tool}` : '';
      break;
    case 'tool_result':
      title = `Tool Result: ${event.tool || ''}`;
      detail = event.result || '';
      break;
    case 'done':
      title = 'Agent Complete';
      detail = (event.answer || '').slice(0, 200);
      break;
    case 'error':
    case 'agent_error':
      title = 'Error';
      detail = event.message || '';
      break;
    case 'mobile_prompt':
      title = 'Mobile Prompt';
      detail = event.message || '';
      break;
    case 'connected':
      title = 'Connected';
      detail = event.message || 'Connected to Nebula IDE';
      break;
    case 'ide_status':
      title = 'IDE Status';
      detail = `Workspace: ${event.workspace_name || 'Unknown'}`;
      break;
    default:
      title = event.type || 'Event';
      detail = JSON.stringify(event).slice(0, 150);
  }

  return (
    <div className="activity-card fade-in">
      <div className="activity-icon" style={{ color }}>
        {icon}
      </div>
      <div className="activity-body">
        <div className="activity-title">{title}</div>
        {detail && <div className="activity-detail">{detail}</div>}
        <div className="activity-time">{timeAgo(event.timestamp)}</div>
      </div>
    </div>
  );
}
