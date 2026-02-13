import { useState, useEffect, useRef } from 'react';
import nebulaWS from '../services/websocket';
import './ChatPage.css';

export default function ChatPage() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isAgentWorking, setIsAgentWorking] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const unsubThinking = nebulaWS.on('thinking', (data) => {
      setIsAgentWorking(true);
      setMessages(prev => {
        // Update or add thinking message
        const last = prev[prev.length - 1];
        if (last && last.type === 'thinking') {
          return [...prev.slice(0, -1), { type: 'thinking', text: data.text, timestamp: data.timestamp }];
        }
        return [...prev, { type: 'thinking', text: data.text, timestamp: data.timestamp }];
      });
    });

    const unsubStep = nebulaWS.on('step', (data) => {
      setMessages(prev => [...prev, {
        type: 'step',
        text: data.message || `Using ${data.tool}...`,
        tool: data.tool,
        timestamp: data.timestamp,
      }]);
    });

    const unsubResult = nebulaWS.on('tool_result', (data) => {
      setMessages(prev => [...prev, {
        type: 'tool_result',
        text: data.result || '',
        tool: data.tool,
        timestamp: data.timestamp,
      }]);
    });

    const unsubDone = nebulaWS.on('done', (data) => {
      setIsAgentWorking(false);
      setMessages(prev => {
        // Remove the last thinking message and add the final answer
        const filtered = prev.filter((m, i) => !(i === prev.length - 1 && m.type === 'thinking'));
        return [...filtered, {
          type: 'assistant',
          text: data.answer || 'Done.',
          timestamp: data.timestamp,
        }];
      });
    });

    const unsubError = nebulaWS.on('agent_error', (data) => {
      setIsAgentWorking(false);
      setMessages(prev => [...prev, {
        type: 'error',
        text: data.message || 'Agent error occurred.',
        timestamp: data.timestamp,
      }]);
    });

    return () => {
      unsubThinking();
      unsubStep();
      unsubResult();
      unsubDone();
      unsubError();
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = () => {
    const text = input.trim();
    if (!text || isAgentWorking) return;

    setMessages(prev => [...prev, {
      type: 'user',
      text,
      timestamp: Date.now() / 1000,
    }]);
    setInput('');

    try {
      nebulaWS.sendPrompt(text);
      setIsAgentWorking(true);
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
        <h1>AI Chat</h1>
        <p>Send prompts to the Nebula AI agent</p>
      </div>

      <div className="chat-messages">
        {messages.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">◉</div>
            <div className="empty-state-text">
              Send a prompt to control your IDE remotely.<br />
              Try: "Create a new component called Header"
            </div>
          </div>
        ) : (
          messages.map((msg, i) => (
            <ChatBubble key={`${msg.timestamp}-${i}`} message={msg} />
          ))
        )}
        {isAgentWorking && (
          <div className="agent-working fade-in">
            <span className="dot dot-yellow dot-pulse" />
            Agent is working...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area">
        <div className="input-group">
          <input
            ref={inputRef}
            className="input"
            type="text"
            placeholder={isAgentWorking ? 'Agent is working...' : 'Send a prompt...'}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && sendMessage()}
            disabled={isAgentWorking}
          />
          <button
            className="btn btn-primary send-btn"
            onClick={sendMessage}
            disabled={isAgentWorking || !input.trim()}
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({ message }) {
  const { type, text, tool } = message;

  if (type === 'user') {
    return (
      <div className="chat-bubble user-bubble fade-in">
        <div className="bubble-content">{text}</div>
      </div>
    );
  }

  if (type === 'assistant') {
    return (
      <div className="chat-bubble assistant-bubble fade-in">
        <div className="bubble-content">{text}</div>
      </div>
    );
  }

  if (type === 'thinking') {
    return (
      <div className="chat-bubble thinking-bubble fade-in">
        <span className="bubble-label">Thinking</span>
        <div className="bubble-content">{text}</div>
      </div>
    );
  }

  if (type === 'step') {
    return (
      <div className="chat-bubble step-bubble fade-in">
        <span className="bubble-label">▸ {tool || 'Step'}</span>
        <div className="bubble-content">{text}</div>
      </div>
    );
  }

  if (type === 'tool_result') {
    return (
      <div className="chat-bubble result-bubble fade-in">
        <span className="bubble-label">Result: {tool}</span>
        <div className="code-block">{text}</div>
      </div>
    );
  }

  if (type === 'error') {
    return (
      <div className="chat-bubble error-bubble fade-in">
        <span className="bubble-label">Error</span>
        <div className="bubble-content">{text}</div>
      </div>
    );
  }

  return null;
}
