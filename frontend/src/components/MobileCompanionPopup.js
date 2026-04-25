import React, { useState, useEffect, useCallback } from 'react';
import { VscClose } from 'react-icons/vsc';
import QRCode from 'qrcode';
import { API_URL as API } from '../config';
import './MobileCompanionPopup.css';

export default function MobileCompanionPopup({ onClose }) {
  const [relayStatus, setRelayStatus] = useState(null);
  const [relayQr, setRelayQr] = useState(null);
  const [relayConnecting, setRelayConnecting] = useState(false);
  const [error, setError] = useState(null);

  const fetchRelayStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API}/mobile/relay/status`);
      const data = await res.json();
      setRelayStatus(data);
      if (data.room_code) {
        const relayUrl = (data.relay_url || '').replace(/\/$/, '');
        const payload = JSON.stringify({ mode: 'relay', relay_url: relayUrl, room_code: data.room_code });
        try {
          const qrRes = await fetch(`${API}/mobile/relay/qr`);
          if (qrRes.ok) {
            const qrData = await qrRes.json();
            if (qrData.qr_image) {
              setRelayQr({ qr_image: qrData.qr_image });
              return;
            }
          }
        } catch (_) {
          // Backend /mobile/relay/qr missing or failed — generate client-side
        }
        const dataUrl = await QRCode.toDataURL(payload, { margin: 2, width: 260 });
        setRelayQr({ qr_data_url: dataUrl });
      } else {
        setRelayQr(null);
      }
    } catch (_) {
      setRelayStatus({ connected: false });
      setRelayQr(null);
    }
  }, []);

  const generateRoomCode = async () => {
    setRelayConnecting(true);
    setError(null);
    try {
      const res = await fetch(`${API}/mobile/relay/connect`, { method: 'POST' });
      const data = await res.json();
      if (data.status === 'connected') {
        await fetchRelayStatus();
      } else {
        setError(data.message || 'Failed to generate room code');
      }
    } catch (e) {
      setError('Failed to connect');
    } finally {
      setRelayConnecting(false);
    }
  };

  useEffect(() => {
    fetchRelayStatus();
  }, [fetchRelayStatus]);

  const handleClose = useCallback(() => {
    setRelayQr(null);
    setRelayStatus({ connected: false, room_code: null });
    setError(null);
    fetch(`${API}/mobile/relay/disconnect`, { method: 'POST' }).catch(() => {});
    onClose();
  }, [onClose]);

  const hasRoomCode = !!relayStatus?.room_code;

  return (
    <div className="mobile-companion-popup-overlay" onClick={handleClose}>
      <div className="mobile-companion-popup" onClick={e => e.stopPropagation()}>
        <div className="mobile-companion-popup-header">
          <span className="mobile-companion-popup-title">Connect Mobile</span>
          <button type="button" className="mobile-companion-popup-close" onClick={handleClose} aria-label="Close">
            <VscClose size={18} />
          </button>
        </div>
        {error && <div className="mobile-companion-error">{error}</div>}
        <div className="mobile-companion-content">
          {!hasRoomCode ? (
            <>
              <p className="mobile-companion-hint">Generate a room code; it will be shown as a QR code for the app to scan.</p>
              <button type="button" className="mobile-companion-btn-primary" onClick={generateRoomCode} disabled={relayConnecting}>
                {relayConnecting ? 'Generating…' : 'Generate Room Code'}
              </button>
            </>
          ) : (
            <>
              <p className="mobile-companion-hint">Scan this QR code with the Nebula Companion app</p>
              {(relayQr?.qr_image || relayQr?.qr_data_url) ? (
                <div className="mobile-companion-qr-container">
                  <img
                    src={relayQr.qr_data_url || `data:image/png;base64,${relayQr.qr_image}`}
                    alt="QR Code"
                    className="mobile-companion-qr"
                  />
                  <div className="mobile-companion-room-code">
                    Room Code: <span>{relayStatus.room_code}</span>
                  </div>
                  <div className={`mobile-companion-status ${relayStatus.connected ? 'connected' : 'connecting'}`}>
                    {relayStatus.connected ? '● Connected' : '○ Connecting to relay...'}
                  </div>
                </div>
              ) : (
                <div className="mobile-companion-qr-placeholder">Loading QR…</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
