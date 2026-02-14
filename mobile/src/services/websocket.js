/**
 * WebSocket Connection Manager
 * Supports two connection modes:
 * 1. Local (direct LAN) — ws://192.168.x.x:8000/mobile/ws
 * 2. Relay (cloud via Railway) — wss://your-relay.up.railway.app/ws/mobile
 */

class NebulaWebSocket {
  constructor() {
    this.ws = null;
    this.url = null;
    this.httpUrl = null;
    this.mode = null; // 'local' or 'relay'
    this.roomCode = null;
    this.connected = false;
    this.desktopOnline = false;
    this.listeners = new Map();
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 30;
    this.events = [];
    this.maxEvents = 200;
  }

  /**
   * Connect via local network (QR code scan)
   */
  connectLocal(connectionInfo) {
    if (typeof connectionInfo === 'string') {
      try {
        connectionInfo = JSON.parse(connectionInfo);
      } catch {
        throw new Error('Invalid connection data');
      }
    }

    this.mode = 'local';
    this.url = connectionInfo.ws_url;
    this.httpUrl = connectionInfo.http_url;
    this.roomCode = null;

    localStorage.setItem('nebula_connection', JSON.stringify({
      mode: 'local',
      ...connectionInfo,
    }));

    this._connect();
  }

  /**
   * Connect via cloud relay (room code)
   */
  connectRelay(relayUrl, roomCode) {
    this.mode = 'relay';
    const wsBase = relayUrl.replace('https://', 'wss://').replace('http://', 'ws://');
    this.url = `${wsBase}/ws/mobile?room=${roomCode}`;
    this.httpUrl = relayUrl;
    this.roomCode = roomCode;

    localStorage.setItem('nebula_connection', JSON.stringify({
      mode: 'relay',
      relay_url: relayUrl,
      room_code: roomCode,
      ws_url: this.url,
    }));

    this._connect();
  }

  /**
   * Try to restore a previous connection
   */
  restore() {
    const stored = localStorage.getItem('nebula_connection');
    if (stored) {
      try {
        const info = JSON.parse(stored);
        if (info.mode === 'relay' && info.relay_url && info.room_code) {
          this.connectRelay(info.relay_url, info.room_code);
          return true;
        } else if (info.ws_url) {
          this.mode = info.mode || 'local';
          this.url = info.ws_url;
          this.httpUrl = info.http_url;
          this.roomCode = info.room_code || null;
          this._connect();
          return true;
        }
      } catch {
        return false;
      }
    }
    return false;
  }

  _connect() {
    if (this.ws) {
      this.ws.close();
    }

    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      this._emit('error', { message: 'Failed to create WebSocket: ' + e.message });
      return;
    }

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this._emit('connection', { connected: true, mode: this.mode });
    };

    this.ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);

        // Track desktop online status for relay mode
        if (data.type === 'desktop_status') {
          this.desktopOnline = data.online;
          this._emit('desktop_status', data);
        }

        if (data.type === 'connected' && data.desktop_online !== undefined) {
          this.desktopOnline = data.desktop_online;
        }

        // Don't store screen frames in event buffer (too large, would fill memory)
        if (data.type !== 'screen_frame') {
          this.events.push(data);
          if (this.events.length > this.maxEvents) {
            this.events.shift();
          }
        }

        // Dispatch by type
        this._emit(data.type, data);
        this._emit('message', data);
      } catch {
        // Ignore non-JSON messages
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      this._emit('connection', { connected: false, mode: this.mode });
      this._scheduleReconnect();
    };

    this.ws.onerror = () => {
      this._emit('error', { message: 'WebSocket connection error' });
    };
  }

  _scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this._emit('error', { message: 'Max reconnect attempts reached' });
      return;
    }
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 15000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this._connect(), delay);
  }

  /**
   * Send a message to the backend (or relay)
   */
  send(type, data = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }
    this.ws.send(JSON.stringify({ type, ...data }));
  }

  sendPrompt(message) {
    this.send('prompt', { message });
  }

  sendTerminalCommand(command, session = 'mobile') {
    this.send('terminal_command', { command, session });
  }

  requestFiles() {
    this.send('get_files');
  }

  requestTreeChildren(path) {
    this.send('get_tree_children', { path });
  }

  requestFileContent(path) {
    this.send('read_file', { path });
  }

  requestStatus() {
    this.send('get_status');
  }

  requestChatHistory() {
    this.send('get_chat_history');
  }

  on(eventType, callback) {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType).add(callback);
    return () => this.listeners.get(eventType)?.delete(callback);
  }

  _emit(eventType, data) {
    const cbs = this.listeners.get(eventType);
    if (cbs) {
      cbs.forEach(cb => {
        try { cb(data); } catch (e) { console.error('Listener error:', e); }
      });
    }
  }

  disconnect() {
    clearTimeout(this.reconnectTimer);
    this.maxReconnectAttempts = 0;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.desktopOnline = false;
    this.events = [];
    this.mode = null;
    this.roomCode = null;
    localStorage.removeItem('nebula_connection');
    this._emit('connection', { connected: false });
  }

  getEventsByType(type) {
    return this.events.filter(e => e.type === type);
  }
}

// Singleton instance
const nebulaWS = new NebulaWebSocket();
export default nebulaWS;
