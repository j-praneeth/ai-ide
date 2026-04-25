import { useState, useEffect, useRef } from 'react';
import nebulaWS from '../services/websocket';
import './ChatPage.css';

// Simple ANSI stripper to keep the "chat" view clean
const stripAnsi = (str) => {
  if (typeof str !== 'string') return str;
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
};

export default function ChatPage({ isVisible }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isCliActive, setIsCliActive] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    // Listen for CLI output from desktop
    const unsubCliData = nebulaWS.on('cli_data', (data) => {
      setIsCliActive(true);
      const cleanText = stripAnsi(data.data);
      if (!cleanText.trim()) return;

      setMessages((prev) => {
        const last = prev[prev.length - 1];
        // If last message was assistant/cli, append to it to group output
        if (last && last.type === 'assistant') {
          return [...prev.slice(0, -1), { ...last, text: last.text + cleanText }];
        }
        return [...prev, { 
          type: 'assistant', 
          text: cleanText, 
          timestamp: data.timestamp || Date.now() / 1000 
        }];
      });
    });

    // Handle initial state/reconnect
    const unsubConnection = nebulaWS.on('connection', (status) => {
      if (status.connected) {
        // Maybe request status or similar?
      }
    });

    return () => {
      unsubCliData();
      unsubConnection();
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = () => {
    const text = input.trim();
    if (!text) return;

    setMessages(prev => [...prev, {
      type: 'user',
      text,
      timestamp: Date.now() / 1000,
    }]);
    setInput('');

    try {
      // Send as CLI input (with newline)
      nebulaWS.sendCliInput(text + '\n');
    } catch {
      setMessages(prev => [...prev, {
        type: 'error',
        text: 'Not connected to IDE. Please reconnect.',
        timestamp: Date.now() / 1000,
      }]);
    }
  };

  return (
    <div className="page chat-page">
      <div className="page-header">
        <h1>Claude CLI</h1>
        <p>Live interaction with the IDE via Claude CLI</p>
      </div>

      <div className="chat-messages">
        {messages.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">✦</div>
            <div className="empty-state-text">
              Waiting for Claude CLI activity...<br />
              Open the CLI Panel in your Desktop IDE to begin.
            </div>
          </div>
        ) : (
          messages.map((msg, i) => (
            <ChatBubble key={`${msg.timestamp}-${i}`} message={msg} />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area">
        <div className="input-group">
          <input
            ref={inputRef}
            className="input"
            type="text"
            placeholder="Type message to Claude..."
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && sendMessage()}
          />
          <button
            className="btn btn-primary send-btn"
            onClick={sendMessage}
            disabled={!input.trim()}
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({ message }) {
  const { type, text } = message;

  if (type === 'user') {
    return (
      <div className="chat-bubble user-bubble fade-in">
        <div className="bubble-content">{text}</div>
      </div>
    );
  }

  if (type === 'error') {
    return (
      <div className="chat-bubble error-bubble fade-in">
        <div className="bubble-content">{text}</div>
      </div>
    );
  }

  return (
    <div className="chat-bubble assistant-bubble fade-in">
      <div className="bubble-content">
        <pre style={{ whiteSpace: 'pre-wrap', margin: 0, font: 'inherit' }}>
          {text}
        </pre>
      </div>
    </div>
  );
}
