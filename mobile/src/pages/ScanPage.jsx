import { useState, useEffect, useRef } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import nebulaWS from '../services/websocket';
import './ScanPage.css';

export default function ScanPage({ onConnected }) {
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('');
  const [manualInput, setManualInput] = useState('');
  const [showManual, setShowManual] = useState(false);
  const scannerRef = useRef(null);
  const html5QrRef = useRef(null);

  const startScanner = async () => {
    setError(null);
    setStatus('Starting camera...');

    try {
      const html5Qr = new Html5Qrcode('qr-reader');
      html5QrRef.current = html5Qr;

      await html5Qr.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: { width: 250, height: 250 },
          aspectRatio: 1,
        },
        (decodedText) => {
          // Success - try to connect
          handleQRData(decodedText);
          html5Qr.stop().catch(() => {});
          setScanning(false);
        },
        () => {} // Ignore scan failures
      );
      setScanning(true);
      setStatus('Point camera at QR code on your desktop IDE');
    } catch (err) {
      setError('Camera access denied. Please allow camera permissions or use manual input.');
      setStatus('');
      setShowManual(true);
    }
  };

  const stopScanner = () => {
    if (html5QrRef.current) {
      html5QrRef.current.stop().catch(() => {});
      html5QrRef.current = null;
    }
    setScanning(false);
    setStatus('');
  };

  const handleQRData = (data) => {
    setStatus('Connecting to IDE...');
    try {
      nebulaWS.connect(data);

      const unsub = nebulaWS.on('connection', ({ connected }) => {
        if (connected) {
          setStatus('Connected!');
          unsub();
          setTimeout(() => onConnected(), 500);
        }
      });

      // Timeout if connection doesn't establish
      setTimeout(() => {
        if (!nebulaWS.connected) {
          setError('Connection timed out. Make sure you are on the same WiFi network as your computer.');
          setStatus('');
          unsub();
        }
      }, 8000);
    } catch (err) {
      setError('Invalid QR code. Please scan the code shown in your Nebula IDE.');
      setStatus('');
    }
  };

  const handleManualConnect = () => {
    if (!manualInput.trim()) return;
    // Try to build connection info from IP:Port
    const parts = manualInput.trim().split(':');
    let ip, port;
    if (parts.length === 2) {
      ip = parts[0];
      port = parts[1];
    } else {
      ip = manualInput.trim();
      port = '8000';
    }

    // Need to get the token from the backend first
    setStatus('Fetching connection token...');
    fetch(`http://${ip}:${port}/mobile/qr`)
      .then(r => r.json())
      .then(data => {
        handleQRData(JSON.stringify(data.connection_info));
      })
      .catch(() => {
        setError('Could not reach IDE at that address. Check IP and port.');
        setStatus('');
      });
  };

  useEffect(() => {
    return () => {
      if (html5QrRef.current) {
        html5QrRef.current.stop().catch(() => {});
      }
    };
  }, []);

  return (
    <div className="page scan-page">
      <div className="scan-header">
        <div className="scan-logo">✦</div>
        <h1>Nebula Companion</h1>
        <p>Connect to your Nebula IDE</p>
      </div>

      <div className="scan-content">
        {/* QR Scanner Area */}
        <div className="scanner-container">
          <div id="qr-reader" ref={scannerRef} className="qr-reader" />
          {!scanning && !status && (
            <div className="scanner-overlay">
              <div className="scanner-frame">
                <span className="scanner-icon">⊞</span>
              </div>
            </div>
          )}
        </div>

        {status && (
          <div className="scan-status fade-in">
            <span className="dot dot-yellow dot-pulse" />
            {status}
          </div>
        )}

        {error && (
          <div className="scan-error fade-in">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="scan-actions">
          {!scanning ? (
            <button className="btn btn-primary btn-full" onClick={startScanner}>
              Scan QR Code
            </button>
          ) : (
            <button className="btn btn-secondary btn-full" onClick={stopScanner}>
              Stop Scanner
            </button>
          )}

          <button
            className="btn btn-secondary btn-full"
            onClick={() => setShowManual(!showManual)}
          >
            {showManual ? 'Hide Manual Input' : 'Enter IP Manually'}
          </button>
        </div>

        {/* Manual Input */}
        {showManual && (
          <div className="manual-section fade-in">
            <p className="manual-hint">
              Enter your computer's local IP address (shown in the IDE)
            </p>
            <div className="input-group">
              <input
                className="input"
                type="text"
                placeholder="192.168.1.100:8000"
                value={manualInput}
                onChange={e => setManualInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleManualConnect()}
              />
              <button className="btn btn-primary" onClick={handleManualConnect}>
                Connect
              </button>
            </div>
          </div>
        )}

        <div className="scan-instructions">
          <h3>How to connect:</h3>
          <ol>
            <li>Open Nebula IDE on your computer</li>
            <li>Both devices must be on the same WiFi</li>
            <li>Go to Settings and find "Mobile Companion"</li>
            <li>Scan the QR code or enter the IP address</li>
          </ol>
        </div>
      </div>
    </div>
  );
}
