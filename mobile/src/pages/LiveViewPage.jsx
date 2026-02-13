import { useState, useEffect, useRef, useCallback } from 'react';
import nebulaWS from '../services/websocket';
import './LiveViewPage.css';

export default function LiveViewPage() {
  const [frame, setFrame] = useState(null);
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const [isDesktopOnline, setIsDesktopOnline] = useState(nebulaWS.desktopOnline);
  const [fps, setFps] = useState(0);
  const [controlMode, setControlMode] = useState(false);
  const imgRef = useRef(null);
  const frameCountRef = useRef(0);
  const lastFpsUpdateRef = useRef(Date.now());

  useEffect(() => {
    // Listen for screen frames
    const unsubFrame = nebulaWS.on('screen_frame', (data) => {
      if (data.frame) {
        setFrame(data.frame);
        setFrameSize({ width: data.width || 720, height: data.height || 0 });

        // Track FPS
        frameCountRef.current++;
        const now = Date.now();
        if (now - lastFpsUpdateRef.current >= 2000) {
          setFps(Math.round(frameCountRef.current / ((now - lastFpsUpdateRef.current) / 1000) * 10) / 10);
          frameCountRef.current = 0;
          lastFpsUpdateRef.current = now;
        }
      }
    });

    const unsubDesktop = nebulaWS.on('desktop_status', (data) => {
      setIsDesktopOnline(data.online);
    });

    return () => {
      unsubFrame();
      unsubDesktop();
    };
  }, []);

  const handleTap = useCallback((e) => {
    if (!controlMode || !imgRef.current) return;

    const rect = imgRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    // Clamp to 0-1
    const nx = Math.max(0, Math.min(1, x));
    const ny = Math.max(0, Math.min(1, y));

    try {
      nebulaWS.send('remote_click', { x: nx, y: ny });
    } catch (err) {
      console.error('Failed to send click:', err);
    }

    // Visual feedback
    showTapFeedback(e.clientX, e.clientY);
  }, [controlMode]);

  const showTapFeedback = (cx, cy) => {
    const dot = document.createElement('div');
    dot.className = 'tap-feedback';
    dot.style.left = `${cx}px`;
    dot.style.top = `${cy}px`;
    document.body.appendChild(dot);
    setTimeout(() => dot.remove(), 500);
  };

  return (
    <div className="page live-view-page">
      <div className="live-header">
        <div className="live-title">
          <span className={`live-dot ${isDesktopOnline ? 'live' : ''}`} />
          <span>Live View</span>
        </div>
        <div className="live-controls">
          {fps > 0 && (
            <span className="live-fps">{fps} fps</span>
          )}
          <button
            className={`control-toggle ${controlMode ? 'active' : ''}`}
            onClick={() => setControlMode(!controlMode)}
          >
            {controlMode ? '🖱 Control ON' : '👁 Watch'}
          </button>
        </div>
      </div>

      <div className="live-stream-container">
        {frame ? (
          <img
            ref={imgRef}
            src={`data:image/jpeg;base64,${frame}`}
            alt="Desktop IDE"
            className={`live-stream-image ${controlMode ? 'control-mode' : ''}`}
            onClick={handleTap}
            draggable={false}
          />
        ) : (
          <div className="live-placeholder">
            <div className="placeholder-icon">📺</div>
            <h3>Waiting for stream...</h3>
            <p>
              {isDesktopOnline
                ? 'Desktop is online. Stream will start shortly.'
                : 'Desktop IDE is offline. Open it to start streaming.'}
            </p>
          </div>
        )}
      </div>

      {controlMode && (
        <div className="control-hint">
          Tap on the screen to interact with the desktop IDE
        </div>
      )}
    </div>
  );
}
