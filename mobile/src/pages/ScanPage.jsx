import { useState, useEffect, useRef } from 'react';
import nebulaWS from '../services/websocket';
import { RELAY_URL } from '../config';
import './ScanPage.css';

const SCANNER_DIV_ID = 'nebula-qr-reader';

export default function ScanPage({ onConnected }) {
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [roomCode, setRoomCode] = useState('');
  const scannerRef = useRef(null);

  const tryConnect = (payload) => {
    setError(null);
    setStatus('Connecting...');
    try {
      if (payload.mode === 'relay' && payload.relay_url && payload.room_code) {
        nebulaWS.connectRelay(payload.relay_url, payload.room_code);
      } else if (payload.ws_url) {
        nebulaWS.connectLocal(payload);
      } else {
        setError('Invalid QR code');
        setStatus('');
        return;
      }
      const unsub = nebulaWS.on('connection', ({ connected }) => {
        if (connected) {
          setStatus('Connected!');
          unsub();
          setTimeout(() => onConnected(), 500);
        }
      });
      setTimeout(() => {
        if (!nebulaWS.connected) {
          setError('Connection timed out.');
          setStatus('');
          unsub();
        }
      }, 12000);
    } catch (err) {
      setError(err.message || 'Connection failed');
      setStatus('');
    }
  };

  const connectRelay = () => {
    const code = roomCode.trim().toUpperCase();
    if (!code) {
      setError('Please enter the room code.');
      return;
    }
    if (!RELAY_URL) {
      setError('Remote access is not configured.');
      return;
    }
    tryConnect({ mode: 'relay', relay_url: RELAY_URL, room_code: code });
  };

  useEffect(() => {
    if (showManual) return;
    let html5QrCode = null;
    const startScanner = async () => {
      try {
        const { Html5Qrcode } = await import('html5-qrcode');
        html5QrCode = new Html5Qrcode(SCANNER_DIV_ID);
        await html5QrCode.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          (decodedText) => {
            try {
              const payload = JSON.parse(decodedText);
              if (payload.mode === 'relay' || payload.ws_url) {
                html5QrCode?.stop().catch(() => {});
                scannerRef.current = null;
                tryConnect(payload);
              }
            } catch (_) {
              // not JSON, ignore
            }
          },
          () => {},
        );
        scannerRef.current = html5QrCode;
      } catch (e) {
        setError('Camera not available. Use manual code.');
        setShowManual(true);
      }
    };
    startScanner();
    return () => {
      if (scannerRef.current) {
        scannerRef.current.stop().catch(() => {});
        scannerRef.current = null;
      }
    };
  }, [showManual]);

  return (
    <div className="page scan-page">
      <div className="scan-header">
        <div className="scan-logo">✦</div>
        <h1>Nebula Companion</h1>
        <p>Scan QR code from desktop IDE</p>
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

        {!showManual ? (
          <>
            <div id={SCANNER_DIV_ID} className="scan-qr-container" />
            <button
              type="button"
              className="btn btn-secondary btn-full"
              style={{ marginTop: 16 }}
              onClick={() => setShowManual(true)}
            >
              Enter code manually
            </button>
          </>
        ) : (
          <div className="tab-content fade-in">
            <div className="card">
              <div className="card-title">Enter Room Code</div>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
                For remote connection, enter the code from the desktop IDE.
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
                style={{
                  marginBottom: 16,
                  letterSpacing: 6,
                  textAlign: 'center',
                  fontSize: 28,
                  fontWeight: 700,
                  width: '100%',
                  display: 'block',
                }}
              />
              <button className="btn btn-primary btn-full" onClick={connectRelay}>
                Connect
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-full"
                style={{ marginTop: 8 }}
                onClick={() => { setShowManual(false); setError(null); }}
              >
                Back to scanner
              </button>
            </div>
            <div className="scan-instructions">
              <h3>How to connect:</h3>
              <ol>
                <li>Open Nebula IDE on your desktop</li>
                <li>Click the <strong>phone icon</strong> (top right)</li>
                <li>Scan the QR code, or use Same network / Remote tab</li>
              </ol>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
