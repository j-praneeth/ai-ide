import React, { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  VscSend,
  VscClose,
  VscTrash,
  VscCopy,
  VscCheck,
  VscAccount,
  VscSparkle,
  VscEdit,
  VscRefresh,
  VscChevronDown,
  VscChevronRight,
  VscFile,
  VscSearch,
  VscTerminal,
  VscBook,
  VscAdd,
  VscHistory,
} from 'react-icons/vsc';
import axios from 'axios';
import { API_URL as API } from '../config';
const CHAT_SESSIONS_KEY = 'nebula_chat_sessions';

function loadSessionsFromStorage() {
  try {
    const raw = localStorage.getItem(CHAT_SESSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveSessionsToStorage(sessions) {
  try {
    localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(sessions));
  } catch (e) {
    console.warn('Failed to save chat sessions', e);
  }
}

function getTitleFromMessages(messages) {
  const firstUser = (messages || []).find(m => m.role === 'user');
  if (!firstUser || !firstUser.text) return 'New Chat';
  const t = String(firstUser.text).trim();
  return t.length > 50 ? t.slice(0, 50) + '…' : t;
}

function createSessionId() {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function CodeBlock({ children, className }) {
  const [copied, setCopied] = useState(false);
  const language = className ? className.replace('language-', '') : '';

  const handleCopy = () => {
    navigator.clipboard.writeText(String(children));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="chat-code-block">
      <div className="chat-code-header">
        <span className="chat-code-lang">{language || 'code'}</span>
        <button className="chat-code-copy" onClick={handleCopy}>
          {copied ? <VscCheck size={14} /> : <VscCopy size={14} />}
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="chat-code-content">
        <code>{children}</code>
      </pre>
    </div>
  );
}

// Tool icon mapper
function ToolIcon({ tool }) {
  if (!tool) return <VscSparkle size={13} />;
  if (tool === 'read_file' || tool === 'write_file' || tool === 'edit_file' || tool === 'delete_file')
    return <VscFile size={13} />;
  if (tool === 'grep_search' || tool === 'codebase_search' || tool === 'file_search')
    return <VscSearch size={13} />;
  if (tool === 'run_command') return <VscTerminal size={13} />;
  if (tool === 'list_dir') return <VscBook size={13} />;
  return <VscSparkle size={13} />;
}

// Cursor-style "Thinking" collapsible block
function ThinkingBlock({ thinkingTexts, steps }) {
  const [expanded, setExpanded] = useState(false);
  if ((!thinkingTexts || thinkingTexts.length === 0) && (!steps || steps.length === 0)) return null;

  const toolSteps = (steps || []).filter(s => s.type === 'step' && s.tool);
  const fileActions = toolSteps.filter(s =>
    ['read_file', 'write_file', 'edit_file', 'delete_file'].includes(s.tool));

  return (
    <div className="thinking-block">
      <div className="thinking-header" onClick={() => setExpanded(!expanded)}>
        <span className="thinking-label">Thinking</span>
        <span className="thinking-toggle">
          {expanded ? <VscChevronDown size={14} /> : <VscChevronRight size={14} />}
        </span>
      </div>
      {expanded && (
        <div className="thinking-content">
          {(thinkingTexts || []).map((text, i) => (
            <p key={i} className="thinking-text">{text}</p>
          ))}
        </div>
      )}
      {/* File action boxes - always visible below thinking */}
      {fileActions.length > 0 && (
        <div className="thinking-file-actions">
          {fileActions.map((fa, i) => (
            <div key={i} className={`thinking-file-box ${fa.tool}`}>
              <ToolIcon tool={fa.tool} />
              <span>{fa.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChatMessage({ message, index, isLast, onCopy, onEdit, onResend, loading }) {
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);
  const [hovering, setHovering] = useState(false);

  const handleCopy = () => {
    onCopy(message.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={`chat-message ${isUser ? 'user' : 'assistant'}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <div className="chat-message-avatar">
        {isUser ? (
          <div className="avatar-user"><VscAccount size={16} /></div>
        ) : (
          <div className="avatar-ai"><VscSparkle size={16} /></div>
        )}
      </div>
      <div className="chat-message-content">
        <div className="chat-message-header">
          <span className="chat-message-role">{isUser ? 'You' : 'AI Assistant'}</span>
          <div className={`chat-msg-hover-actions ${hovering ? 'visible' : ''}`}>
            <button className="chat-hover-btn" title="Copy message" onClick={handleCopy}>
              {copied ? <VscCheck size={13} /> : <VscCopy size={13} />}
            </button>
            {isUser && (
              <button className="chat-hover-btn" title="Edit & resend" onClick={() => onEdit(index, message.text)}>
                <VscEdit size={13} />
              </button>
            )}
            {isUser && isLast && !loading && (
              <button className="chat-hover-btn" title="Resend message" onClick={() => onResend(index)}>
                <VscRefresh size={13} />
              </button>
            )}
          </div>
        </div>
        {/* Thinking block (collapsible) for assistant messages */}
        {!isUser && ((message.thinkingTexts && message.thinkingTexts.length > 0) ||
          (message.steps && message.steps.length > 0)) && (
          <ThinkingBlock thinkingTexts={message.thinkingTexts} steps={message.steps} />
        )}
        <div className="chat-message-body">
          {isUser ? (
            <p>{message.text}</p>
          ) : (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code({ node, inline, className, children, ...props }) {
                  if (inline) {
                    return <code className="inline-code" {...props}>{children}</code>;
                  }
                  return <CodeBlock className={className}>{children}</CodeBlock>;
                },
                p({ children }) {
                  return <p className="chat-paragraph">{children}</p>;
                },
              }}
            >
              {message.text}
            </ReactMarkdown>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ChatPanel({ visible, onClose, currentFile, currentContent }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [thinkingSteps, setThinkingSteps] = useState([]);
  const [thinkingTexts, setThinkingTexts] = useState([]);
  const thinkingStepsRef = useRef([]);
  const thinkingTextsRef = useRef([]);
  const [editingIndex, setEditingIndex] = useState(null);
  const [liveThinkingExpanded, setLiveThinkingExpanded] = useState(true);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  const [sessions, setSessions] = useState(() => loadSessionsFromStorage());
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [showHistory, setShowHistory] = useState(false);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, thinkingSteps, thinkingTexts, scrollToBottom]);

  useEffect(() => {
    if (visible && inputRef.current) {
      inputRef.current.focus();
    }
  }, [visible]);

  // Auto-save current conversation to active session
  useEffect(() => {
    if (!activeSessionId) return;
    setSessions(prev => {
      const next = prev.map(s =>
        s.id === activeSessionId
          ? { ...s, messages, title: getTitleFromMessages(messages), timestamp: Date.now() }
          : s
      );
      saveSessionsToStorage(next);
      return next;
    });
  }, [messages, activeSessionId]);

  const createNewSession = useCallback(() => {
    const newId = createSessionId();
    setSessions(prev => {
      const updated = activeSessionId && messages.length > 0
        ? prev.map(s =>
            s.id === activeSessionId
              ? { ...s, messages, title: getTitleFromMessages(messages), timestamp: Date.now() }
              : s
          )
        : prev;
      const next = [...updated, { id: newId, title: 'New Chat', messages: [], timestamp: Date.now() }];
      saveSessionsToStorage(next);
      return next;
    });
    setActiveSessionId(newId);
    setMessages([]);
    setEditingIndex(null);
    setInput('');
    setThinkingSteps([]);
    setThinkingTexts([]);
    thinkingStepsRef.current = [];
    thinkingTextsRef.current = [];
  }, [activeSessionId, messages]);

  const loadSession = useCallback((id) => {
    const session = sessions.find(s => s.id === id);
    if (!session) return;
    setActiveSessionId(id);
    setMessages(session.messages || []);
    setEditingIndex(null);
    setInput('');
    setShowHistory(false);
  }, [sessions]);

  const deleteSession = useCallback((id, e) => {
    e.stopPropagation();
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id);
      saveSessionsToStorage(next);
      return next;
    });
    if (activeSessionId === id) {
      setActiveSessionId(null);
      setMessages([]);
      setEditingIndex(null);
      setInput('');
    }
  }, [activeSessionId]);

  // Core send function (SSE streaming)
  const sendPrompt = useCallback(async (promptText, messagesList) => {
    setLoading(true);
    setThinkingSteps([]);
    setThinkingTexts([]);
    thinkingStepsRef.current = [];
    thinkingTextsRef.current = [];
    setLiveThinkingExpanded(true);

    let prompt = promptText;
    const contextParts = [];
    if (currentFile) {
      contextParts.push(`[Current file: ${currentFile}]`);
    }
    if (currentContent) {
      const lines = currentContent.split('\n');
      const snippet = lines.slice(0, 100).join('\n');
      if (snippet.trim()) {
        contextParts.push(`[File content (first ${Math.min(lines.length, 100)} of ${lines.length} lines)]:\n${snippet}`);
      }
    }
    if (contextParts.length > 0) {
      prompt = contextParts.join('\n') + '\n\n' + prompt;
    }

    try {
      const response = await fetch(`${API}/ai/chat/stream?prompt=${encodeURIComponent(prompt)}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finalAnswer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'thinking') {
                thinkingTextsRef.current = [...thinkingTextsRef.current, data.text];
                setThinkingTexts(prev => [...prev, data.text]);
              } else if (data.type === 'step') {
                const step = { type: 'step', message: data.message, tool: data.tool };
                thinkingStepsRef.current = [...thinkingStepsRef.current, step];
                setThinkingSteps(prev => [...prev, step]);
              } else if (data.type === 'tool_result') {
                const step = { type: 'result', tool: data.tool, result: data.result };
                thinkingStepsRef.current = [...thinkingStepsRef.current, step];
                setThinkingSteps(prev => [...prev, step]);
              } else if (data.type === 'done') {
                finalAnswer = data.answer || 'Done.';
              } else if (data.type === 'error') {
                finalAnswer = `Error: ${data.message}`;
              }
            } catch (e) {
              // ignore parse errors
            }
          }
        }
      }

      setMessages([...messagesList, {
        role: 'assistant',
        text: finalAnswer,
        steps: [...thinkingStepsRef.current],
        thinkingTexts: [...thinkingTextsRef.current],
      }]);
    } catch (err) {
      setMessages([...messagesList, {
        role: 'assistant',
        text: `Error: ${err.message}. Make sure the backend server is running.`,
        steps: [],
        thinkingTexts: [],
      }]);
    }

    setLoading(false);
    setThinkingSteps([]);
    setThinkingTexts([]);
    thinkingStepsRef.current = [];
    thinkingTextsRef.current = [];
  }, [currentFile, currentContent]);

  const sendMessage = async () => {
    if (!input.trim() || loading) return;
    const text = input.trim();

    if (!activeSessionId) {
      const newId = createSessionId();
      setSessions(prev => {
        const next = [...prev, { id: newId, title: 'New Chat', messages: [], timestamp: Date.now() }];
        saveSessionsToStorage(next);
        return next;
      });
      setActiveSessionId(newId);
    }

    if (editingIndex !== null) {
      const newMessages = messages.slice(0, editingIndex);
      const userMessage = { role: 'user', text };
      newMessages.push(userMessage);
      setMessages(newMessages);
      setInput('');
      setEditingIndex(null);
      await sendPrompt(text, newMessages);
    } else {
      const userMessage = { role: 'user', text };
      const newMessages = [...messages, userMessage];
      setMessages(newMessages);
      setInput('');
      await sendPrompt(text, newMessages);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
    if (e.key === 'Escape' && editingIndex !== null) {
      setEditingIndex(null);
      setInput('');
    }
  };

  const handleCopyMessage = useCallback((text) => {
    navigator.clipboard.writeText(text);
  }, []);

  const handleEditMessage = useCallback((msgIndex, text) => {
    setEditingIndex(msgIndex);
    setInput(text);
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.setSelectionRange(text.length, text.length);
      }
    }, 50);
  }, []);

  const handleResendMessage = useCallback(async (msgIndex) => {
    if (loading) return;
    const userMsg = messages[msgIndex];
    if (!userMsg || userMsg.role !== 'user') return;
    const newMessages = messages.slice(0, msgIndex + 1);
    setMessages(newMessages);
    await sendPrompt(userMsg.text, newMessages);
  }, [messages, loading, sendPrompt]);

  const clearChat = async () => {
    setMessages([]);
    setEditingIndex(null);
    setInput('');
    setThinkingSteps([]);
    setThinkingTexts([]);
    thinkingStepsRef.current = [];
    thinkingTextsRef.current = [];
    try {
      await axios.post(`${API}/ai/chat/clear`);
    } catch (err) {
      // Silently ignore
    }
  };

  const newChat = () => {
    createNewSession();
    axios.post(`${API}/ai/chat/clear`).catch(() => {});
  };

  const lastUserMsgIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return i;
    }
    return -1;
  })();

  if (!visible) return null;

  return (
    <div className="chat-panel">
      {/* Chat history sidebar — slides in from left */}
      <div className={`chat-history-sidebar ${showHistory ? 'open' : ''}`}>
        <div className="chat-history-header">
          <span className="chat-history-title">History</span>
          <button className="icon-btn" title="Close history" onClick={() => setShowHistory(false)}>
            <VscClose size={14} />
          </button>
        </div>
        <div className="chat-history-list">
          {sessions.length === 0 && (
            <div className="chat-history-empty">No conversations yet</div>
          )}
          {[...sessions].reverse().map((session) => (
            <div
              key={session.id}
              className={`chat-history-item ${session.id === activeSessionId ? 'active' : ''}`}
              onClick={() => loadSession(session.id)}
            >
              <div className="chat-history-item-main">
                <span className="chat-history-item-title" title={session.title}>
                  {session.title || 'New Chat'}
                </span>
                <span className="chat-history-item-date">
                  {session.timestamp
                    ? new Date(session.timestamp).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        year: session.timestamp > Date.now() - 86400000 * 365 ? undefined : 'numeric',
                      })
                    : ''}
                </span>
              </div>
              <button
                className="chat-history-item-delete"
                title="Delete"
                onClick={(e) => deleteSession(session.id, e)}
              >
                <VscTrash size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="chat-panel-main">
      <div className="chat-header">
        <div className="chat-header-left">
          <button
            className="icon-btn chat-history-toggle"
            title="History"
            onClick={() => setShowHistory(!showHistory)}
          >
            <VscHistory size={14} />
          </button>
          <VscSparkle size={16} className="chat-header-icon" />
          <span className="chat-header-title">Nebula AI</span>
          {messages.length > 0 && (
            <span className="chat-msg-count">{messages.length} messages</span>
          )}
        </div>
        <div className="chat-header-actions">
          <button className="icon-btn" title="New Chat" onClick={newChat}>
            <VscAdd size={14} />
          </button>
          <button className="icon-btn" title="Clear History" onClick={clearChat}>
            <VscTrash size={14} />
          </button>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <VscClose size={14} />
          </button>
        </div>
      </div>

      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-icon">
              <VscSparkle size={48} />
            </div>
            <h3>Nebula AI</h3>
            <p>Ask me anything about your code. I can help with:</p>
            <div className="chat-suggestions">
              <button className="chat-suggestion" onClick={() => setInput('Explain what this code does')}>
                Explain this code
              </button>
              <button className="chat-suggestion" onClick={() => setInput('Find and fix bugs in this code')}>
                Find bugs
              </button>
              <button className="chat-suggestion" onClick={() => setInput('Refactor this code for better readability')}>
                Refactor code
              </button>
              <button className="chat-suggestion" onClick={() => setInput('Write unit tests for this code')}>
                Write tests
              </button>
            </div>
          </div>
        )}

        {messages.map((msg, idx) => (
          <ChatMessage
            key={idx}
            message={msg}
            index={idx}
            isLast={msg.role === 'user' && idx === lastUserMsgIndex}
            onCopy={handleCopyMessage}
            onEdit={handleEditMessage}
            onResend={handleResendMessage}
            loading={loading}
          />
        ))}

        {/* Live thinking/working display */}
        {loading && (
          <div className="chat-message assistant">
            <div className="chat-message-avatar">
              <div className="avatar-ai"><VscSparkle size={16} /></div>
            </div>
            <div className="chat-message-content">
              <div className="chat-thinking-live">
                {/* Thinking collapsible */}
                {thinkingTexts.length > 0 && (
                  <div className="thinking-block live">
                    <div className="thinking-header" onClick={() => setLiveThinkingExpanded(!liveThinkingExpanded)}>
                      <span className="thinking-label">Thinking</span>
                      <span className="thinking-toggle">
                        {liveThinkingExpanded ? <VscChevronDown size={14} /> : <VscChevronRight size={14} />}
                      </span>
                    </div>
                    {liveThinkingExpanded && (
                      <div className="thinking-content">
                        {thinkingTexts.map((text, i) => (
                          <p key={i} className="thinking-text">{text}</p>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Tool action steps */}
                {thinkingSteps.filter(s => s.type === 'step' && s.tool).map((step, i) => (
                  <div key={i} className="thinking-file-box live">
                    <ToolIcon tool={step.tool} />
                    <span>{step.message}</span>
                  </div>
                ))}

                {/* Loading indicator */}
                <div className="chat-loading">
                  <div className="chat-loading-dots">
                    <span></span><span></span><span></span>
                  </div>
                  <span className="chat-loading-text">
                    {thinkingSteps.length === 0 ? 'Thinking...' : 'Working...'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area">
        {currentFile && (
          <div className="chat-context">
            <VscFile size={12} />
            <span className="chat-context-file" title={currentFile}>{currentFile.split('/').pop()}</span>
            {messages.length > 0 && (
              <span className="chat-context-thread">Thread active</span>
            )}
          </div>
        )}
        {editingIndex !== null && (
          <div className="chat-editing-indicator">
            <VscEdit size={12} />
            <span>Editing message</span>
            <button
              className="chat-editing-cancel"
              onClick={() => { setEditingIndex(null); setInput(''); }}
            >
              Cancel
            </button>
          </div>
        )}
        <div className="chat-input-wrapper">
          <textarea
            ref={inputRef}
            className={`chat-input ${editingIndex !== null ? 'editing' : ''}`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={editingIndex !== null ? 'Edit your message...' : 'Ask AI anything... (Enter to send)'}
            rows={1}
          />
          <button
            className={`chat-send-btn ${input.trim() ? 'active' : ''}`}
            onClick={sendMessage}
            disabled={!input.trim() || loading}
            title={editingIndex !== null ? 'Send edited message' : 'Send message'}
          >
            <VscSend size={16} />
          </button>
        </div>
        <div className="chat-input-hint">
          <kbd>Enter</kbd> to send, <kbd>Shift+Enter</kbd> for new line{editingIndex !== null && <>, <kbd>Esc</kbd> to cancel edit</>}
        </div>
      </div>
      </div>
    </div>
  );
}
