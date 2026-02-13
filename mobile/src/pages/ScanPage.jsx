import { useState } from 'react';
import nebulaWS from '../services/websocket';
import { RELAY_URL } from '../config';
import './ScanPage.css';

export default function ScanPage({ onConnected }) {
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('');
  const [roomCode, setRoomCode] = useState('');

  const connectRelay = () => {
    const code = roomCode.trim().toUpperCase();
    if (!code) {
      setError('Please enter the room code shown on your desktop IDE.');
      return;
    }
    if (!RELAY_URL) {
      setError('Remote access is not configured.');
      return;
    }

    setStatus('Connecting...');
    setError(null);

    try {
      nebulaWS.connectRelay(RELAY_URL, code);

      const unsub = nebulaWS.on('connection', ({ connected }) => {
        if (connected) {
          setStatus('Connected!');
          unsub();
          setTimeout(() => onConnected(), 500);
        }
      });

      setTimeout(() => {
        if (!nebulaWS.connected) {
          setError('Connection timed out. Check the room code and try again.');
          setStatus('');
          unsub();
        }
      }, 10000);
    } catch (err) {
      setError(err.message || 'Connection failed');
      setStatus('');
    }
  };

  return (
    <div className="page scan-page">
      <div className="scan-header">
        <div className="scan-logo">✦</div>
        <h1>Nebula Companion</h1>
        <p>Connect to your Nebula IDE</p>
      </div>

      <div className="scan-content">
        {status && (
          <div className="scan-status fade-in">
            <span className="dot dot-yellow dot-pulse" />
            {status}
          </div>
        )}

        {error && (
          <div className="scan-error fade-in">{error}</div>
        )}

        <div className="tab-content fade-in">
          <div className="card">
            <div className="card-title">Enter Room Code</div>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
              Enter the 6-character code shown on your desktop IDE.
            </p>

            <input
              className="input room-code-input"
              type="text"
              placeholder="ABC123"
              value={roomCode}
              onChange={e => setRoomCode(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && connectRelay()}
              maxLength={6}
              autoCapitalize="characters"
              autoComplete="off"
              style={{ marginBottom: 16, letterSpacing: 6, textAlign: 'center', fontSize: 28, fontWeight: 700 }}
            />

            <button className="btn btn-primary btn-full" onClick={connectRelay}>
              Connect
            </button>
          </div>

          <div className="scan-instructions">
            <h3>How to get a room code:</h3>
            <ol>
              <li>Open Nebula IDE on your desktop</li>
              <li>Go to <strong>Settings → Mobile Companion</strong></li>
              <li>Click <strong>"Generate Room Code"</strong></li>
              <li>Enter the code above</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
