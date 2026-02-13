/**
 * WebSocket Connection Manager
 * Handles connection to the Nebula IDE backend, auto-reconnect,
 * and event dispatching to the mobile companion UI.
 */

class NebulaWebSocket {
  constructor() {
    this.ws = null;
    this.url = null;
    this.httpUrl = null;
    this.token = null;
    this.listeners = new Map();
    this.connected = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 20;
    this.events = []; // Event history
    this.maxEvents = 200;
  }

  /**
   * Connect using the parsed QR code data
   */
  connect(connectionInfo) {
    if (typeof connectionInfo === 'string') {
      try {
        connectionInfo = JSON.parse(connectionInfo);
      } catch {
        throw new Error('Invalid connection data');
      }
    }

    this.url = connectionInfo.ws_url;
    this.httpUrl = connectionInfo.http_url;
    this.token = connectionInfo.token;

    // Store for reconnect
    localStorage.setItem('nebula_connection', JSON.stringify(connectionInfo));

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
        this.url = info.ws_url;
        this.httpUrl = info.http_url;
        this.token = info.token;
        this._connect();
        return true;
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
      this._emit('connection', { connected: true });
    };

    this.ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        // Store event
        this.events.push(data);
        if (this.events.length > this.maxEvents) {
          this.events.shift();
        }
        // Dispatch by type
        this._emit(data.type, data);
        // Also emit a generic 'message' event
        this._emit('message', data);
      } catch {
        // Ignore non-JSON messages
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      this._emit('connection', { connected: false });
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
   * Send a message to the backend
   */
  send(type, data = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }
    this.ws.send(JSON.stringify({ type, ...data }));
  }

  /**
   * Send an AI prompt
   */
  sendPrompt(message) {
    this.send('prompt', { message });
  }

  /**
   * Send a terminal command
   */
  sendTerminalCommand(command, session = 'mobile') {
    this.send('terminal_command', { command, session });
  }

  /**
   * Request file tree
   */
  requestFiles() {
    this.send('get_files');
  }

  /**
   * Request file content
   */
  requestFileContent(path) {
    this.send('read_file', { path });
  }

  /**
   * Request full IDE status
   */
  requestStatus() {
    this.send('get_status');
  }

  /**
   * Subscribe to events
   */
  on(eventType, callback) {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType).add(callback);
    return () => this.listeners.get(eventType)?.delete(callback);
  }

  /**
   * Emit an event to listeners
   */
  _emit(eventType, data) {
    const cbs = this.listeners.get(eventType);
    if (cbs) {
      cbs.forEach(cb => {
        try { cb(data); } catch (e) { console.error('Listener error:', e); }
      });
    }
  }

  /**
   * Disconnect and clear
   */
  disconnect() {
    clearTimeout(this.reconnectTimer);
    this.maxReconnectAttempts = 0; // Prevent reconnect
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.events = [];
    localStorage.removeItem('nebula_connection');
    this._emit('connection', { connected: false });
  }

  /**
   * Get filtered events by type
   */
  getEventsByType(type) {
    return this.events.filter(e => e.type === type);
  }
}

// Singleton instance
const nebulaWS = new NebulaWebSocket();
export default nebulaWS;
