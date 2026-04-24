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
  VscDebugStop,
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

// Todo list display - collapsible "To-dos N", arrow for completed, circle for pending (Cursor-style)
function TodoListBlock({ steps, completedIndices }) {
  const [collapsed, setCollapsed] = useState(false);
  if (!steps || steps.length === 0) return null;
  const completedSet = completedIndices instanceof Set
    ? completedIndices
    : new Set(Array.isArray(completedIndices) ? completedIndices : []);
  return (
    <div className="chat-todo-block">
      <button
        type="button"
        className="chat-todo-header"
        onClick={() => setCollapsed(c => !c)}
        aria-expanded={!collapsed}
      >
        <span className="chat-todo-chevron">{collapsed ? <VscChevronRight size={14} /> : <VscChevronDown size={14} />}</span>
        <span className="chat-todo-title">To-dos</span>
        <span className="chat-todo-count">{steps.length}</span>
      </button>
      {!collapsed && (
        <ul className="chat-todo-list">
          {steps.map((step, i) => (
            <li key={i} className={completedSet.has(i) ? 'chat-todo-item completed' : 'chat-todo-item'}>
              <span className="chat-todo-icon" aria-hidden>
                {completedSet.has(i) ? <span className="chat-todo-arrow">→</span> : <span className="chat-todo-circle">○</span>}
              </span>
              <span className="chat-todo-label">{step}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Parse unified diff into { path, added, removed, lines: [{ type: 'add'|'remove'|'context', text }] }
function parseUnifiedDiff(diffText) {
  if (!diffText || typeof diffText !== 'string') return null;
  const lines = diffText.split('\n');
  let path = '';
  const result = { path: '', added: 0, removed: 0, lines: [] };
  for (const line of lines) {
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const p = line.slice(4).trim().replace(/^\s*(?:a\/|b\/)/, '');
      if (p) path = p;
      continue;
    }
    if (line.startsWith('@@')) continue; // hunk header
    if (line.startsWith('-') && !line.startsWith('---')) {
      result.lines.push({ type: 'remove', text: line.slice(1) });
      result.removed++;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      result.lines.push({ type: 'add', text: line.slice(1) });
      result.added++;
    } else {
      result.lines.push({ type: 'context', text: line.startsWith(' ') ? line.slice(1) : line });
    }
  }
  result.path = path;
  return result;
}

// File diff block: filename +N -M and red/green line diff (like source control view)
function FileDiffBlock({ path, added, removed, diffLines, maxLines = 50 }) {
  const [expanded, setExpanded] = useState(true);
  const hasMore = diffLines && diffLines.length > maxLines;
  const displayLines = (diffLines || []).slice(0, maxLines);
  return (
    <div className="chat-file-diff-block">
      <button
        type="button"
        className="chat-file-diff-header"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
      >
        <span className="chat-file-diff-chevron">{expanded ? <VscChevronDown size={12} /> : <VscChevronRight size={12} />}</span>
        <span className="chat-file-diff-path">{path || 'file'}</span>
        <span className="chat-file-diff-stats">
          <span className="diff-add">+{added ?? 0}</span>
          <span className="diff-remove">−{removed ?? 0}</span>
        </span>
      </button>
      {expanded && (
        <div className="chat-file-diff-body">
          {displayLines.map((item, i) => (
            <div key={i} className={`chat-file-diff-line chat-file-diff-line-${item.type}`}>
              <span className="chat-file-diff-line-prefix">{item.type === 'add' ? '+' : item.type === 'remove' ? '−' : ' '}</span>
              <span className="chat-file-diff-line-text">{item.text || ' '}</span>
            </div>
          ))}
          {hasMore && <div className="chat-file-diff-more">{diffLines.length - maxLines} hidden lines</div>}
        </div>
      )}
    </div>
  );
}

// Cursor-style tool steps display - always visible, inline
function ToolStepsBlock({ steps, onConfirmCommand }) {
  const [expandedResults, setExpandedResults] = useState({});
  const [executingCommands, setExecutingCommands] = useState({});

  if (!steps || steps.length === 0) return null;

  // Pair up step + result entries, handle confirmation_required steps
  const pairedSteps = [];
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].type === 'step') {
      // Check if this step needs confirmation (has confirmation_required data)
      const needsConfirmation = steps[i].confirmation_required;
      const result = (i + 1 < steps.length && steps[i + 1].type === 'result') ? steps[i + 1] : null;
      pairedSteps.push({ 
        step: steps[i], 
        result,
        needsConfirmation,
        confirmationData: steps[i].confirmationData,
      });
      if (result) i++; // skip next
    }
  }

  const toggleResult = (idx) => {
    setExpandedResults(prev => ({ ...prev, [idx]: !prev[idx] }));
  };

  const handleApprove = async (confirmationData) => {
    const { commandId, command, tool } = confirmationData;
    setExecutingCommands(prev => ({ ...prev, [commandId]: true }));
    
    try {
      const response = await axios.post(`${API}/ai/command/approve`, null, {
        params: {
          command_id: commandId,
          approved: true,
        },
      });

      if (response.data.status === 'executed') {
        // Call the callback to add result to steps
        if (onConfirmCommand) {
          onConfirmCommand({
            type: 'result',
            tool: tool,
            result: response.data.result,
            command: command,
          });
        }
      }
    } catch (err) {
      if (onConfirmCommand) {
        onConfirmCommand({
          type: 'result',
          tool: tool,
          result: `Error: ${err.response?.data?.error || err.message || 'Failed to execute command'}`,
          command: command,
        });
      }
    } finally {
      setExecutingCommands(prev => {
        const next = { ...prev };
        delete next[commandId];
        return next;
      });
    }
  };

  const handleReject = async (confirmationData) => {
    const { commandId, command, tool } = confirmationData;
    
    try {
      await axios.post(`${API}/ai/command/approve`, null, {
        params: {
          command_id: commandId,
          approved: false,
        },
      });
    } catch (err) {
      console.error('Error rejecting command:', err);
    }
    
    // Add rejection message
    if (onConfirmCommand) {
      onConfirmCommand({
        type: 'result',
        tool: tool,
        result: 'Command was skipped by user.',
        command: command,
      });
    }
  };

  return (
    <div className="tool-steps-block">
      {pairedSteps.map((pair, i) => {
        const { step, result, needsConfirmation, confirmationData } = pair;
        const isExpanded = expandedResults[i];
        const isExecuting = confirmationData && executingCommands[confirmationData.commandId];

        return (
          <div key={i} className={`tool-step-item ${step.tool}`}>
            <div
              className="tool-step-header"
              onClick={() => result && !needsConfirmation && toggleResult(i)}
              style={{ cursor: (result && !needsConfirmation) ? 'pointer' : 'default' }}
            >
              <div className="tool-step-left">
                <ToolIcon tool={step.tool} />
                <span className="tool-step-label">{step.message}</span>
              </div>
              {result && !needsConfirmation && (
                <span className="tool-step-toggle">
                  {isExpanded ? <VscChevronDown size={12} /> : <VscChevronRight size={12} />}
                </span>
              )}
            </div>
            
            {/* Inline confirmation UI - appears below the command */}
            {needsConfirmation && confirmationData && !result && (
              <div className="tool-step-confirmation">
                <div className="tool-step-confirmation-command">
                  <code>{confirmationData.command}</code>
                </div>
                <div className="tool-step-confirmation-actions">
                  <button
                    className="tool-step-confirm-btn tool-step-confirm-btn-skip"
                    onClick={() => handleReject(confirmationData)}
                    disabled={isExecuting}
                  >
                    <VscClose size={14} />
                    Skip
                  </button>
                  <button
                    className="tool-step-confirm-btn tool-step-confirm-btn-run"
                    onClick={() => handleApprove(confirmationData)}
                    disabled={isExecuting}
                  >
                    {isExecuting ? (
                      <>⏳ Executing...</>
                    ) : (
                      <>
                        <VscCheck size={14} />
                        Run
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
            
            {isExpanded && result && (
              <div className="tool-step-result">
                {(() => {
                  const tool = step.tool;
                  const raw = result.result;
                  // edit_file: result may be JSON with .diff (unified diff)
                  if (tool === 'edit_file' && raw) {
                    try {
                      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
                      if (data && data.diff) {
                        const parsed = parseUnifiedDiff(data.diff);
                        const pathFromMsg = (step.message || '').match(/`([^`]+)`/);
                        const path = (parsed && parsed.path) || (pathFromMsg && pathFromMsg[1]) || 'file';
                        const added = parsed ? parsed.added : 0;
                        const removed = parsed ? parsed.removed : 0;
                        const lines = parsed ? parsed.lines : [];
                        return (
                          <FileDiffBlock path={path} added={added} removed={removed} diffLines={lines} />
                        );
                      }
                    } catch (_) { /* not JSON */ }
                  }
                  // write_file: "Created: 'path' (N lines)" or "Written: 'path' (N lines)"
                  if (tool === 'write_file' && typeof raw === 'string') {
                    const m = raw.match(/(?:Created|Written):\s*'([^']+)'\s*\((\d+)\s*lines?\)/i);
                    if (m) {
                      return (
                        <FileDiffBlock path={m[1]} added={parseInt(m[2], 10)} removed={0} diffLines={[]} />
                      );
                    }
                  }
                  return <pre className="tool-step-result-content">{raw}</pre>;
                })()}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ChatMessage({ message, index, isLast, onCopy, onEdit, onResend, loading, onConfirmCommand }) {
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
        {/* Todo list when present */}
        {!isUser && message.todoList && message.todoList.length > 0 && (
          <TodoListBlock
            steps={message.todoList}
            completedIndices={message.todoCompletedIndices || []}
          />
        )}
        {/* Tool steps - always visible, Cursor-style */}
        {!isUser && message.steps && message.steps.length > 0 && (
          <ToolStepsBlock 
            steps={message.steps} 
            onConfirmCommand={onConfirmCommand}
          />
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
  const [mode, setMode] = useState('agent'); // 'agent' or 'chat'
  // liveThinkingExpanded removed — tool steps are always visible in Cursor style
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const abortControllerRef = useRef(null);

  const [sessions, setSessions] = useState(() => loadSessionsFromStorage());
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [todoList, setTodoList] = useState([]);
  const [todoCompletedIndices, setTodoCompletedIndices] = useState(new Set());
  const todoListRef = useRef([]);
  const todoCompletedRef = useRef(new Set());

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

  // Sync with server chat history so messages sent from mobile appear on desktop
  const fetchAndMergeServerHistory = useCallback(async () => {
    if (!visible || loading) return;
    try {
      const res = await fetch(`${API}/ai/chat/history`);
      if (!res.ok) return;
      const { history } = await res.json();
      if (!Array.isArray(history) || history.length === 0) return;
      const mapped = history.map(({ role, content }) => ({ role, text: content || '' }));
      setMessages(prev => {
        if (!activeSessionId) return mapped;
        if (mapped.length >= prev.length) return mapped;
        return prev;
      });
    } catch (e) {
      // ignore
    }
  }, [visible, loading, activeSessionId]);

  useEffect(() => {
    if (!visible) return;
    fetchAndMergeServerHistory();
  }, [visible, fetchAndMergeServerHistory]);

  useEffect(() => {
    if (!visible) return;
    const onFocus = () => fetchAndMergeServerHistory();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [visible, fetchAndMergeServerHistory]);

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
    setTodoList([]);
    setTodoCompletedIndices(new Set());
    thinkingStepsRef.current = [];
    thinkingTextsRef.current = [];
    todoListRef.current = [];
    todoCompletedRef.current = new Set();
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

  const stopGeneration = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  }, []);

  // Core send function (SSE streaming)
  const sendPrompt = useCallback(async (promptText, messagesList) => {
    setLoading(true);
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;
    setThinkingSteps([]);
    setThinkingTexts([]);
    setTodoList([]);
    setTodoCompletedIndices(new Set());
    todoListRef.current = [];
    todoCompletedRef.current = new Set();
    thinkingStepsRef.current = [];
    thinkingTextsRef.current = [];


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

    const modelParam = (() => {
      try {
        const raw = localStorage.getItem('nebula_ide_settings');
        if (!raw) return '';
        const s = JSON.parse(raw);
        if ((s.aiModelSource ?? 'providers') !== 'providers') return '';
        const provider = (s.aiApiKeyProvider ?? 'kimi').toLowerCase();
        const providerToModel = {
          kimi: 'moonshotai/kimi-k2.5',
          openai: 'openai/gpt-4',
          anthropic: 'anthropic/claude-3-sonnet-20240229',
          google: 'google/gemini-pro',
          groq: 'groq/llama-3-70b',
          together: 'together/llama-3-70b',
        };
        return providerToModel[provider] || '';
      } catch (_) { return ''; }
    })();
    const streamUrl = modelParam
      ? `${API}/ai/chat/stream?prompt=${encodeURIComponent(prompt)}&mode=${mode}&model=${encodeURIComponent(modelParam)}`
      : `${API}/ai/chat/stream?prompt=${encodeURIComponent(prompt)}&mode=${mode}`;

    try {
      const response = await fetch(streamUrl, { signal });
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
              } else if (data.type === 'confirmation_required') {
                // Add a step with confirmation data - will show inline confirmation UI
                const step = { 
                  type: 'step', 
                  message: `Running command: \`${data.command}\``, 
                  tool: data.tool,
                  confirmation_required: true,
                  confirmationData: {
                    commandId: data.command_id,
                    command: data.command,
                    message: data.message,
                    tool: data.tool,
                  }
                };
                thinkingStepsRef.current = [...thinkingStepsRef.current, step];
                setThinkingSteps(prev => [...prev, step]);
              } else if (data.type === 'todo') {
                const steps = data.steps || [];
                todoListRef.current = steps;
                todoCompletedRef.current = new Set();
                setTodoList(steps);
                setTodoCompletedIndices(new Set());
              } else if (data.type === 'todo_step_completed') {
                const idx = data.index;
                if (typeof idx === 'number') {
                  todoCompletedRef.current = new Set([...todoCompletedRef.current, idx]);
                  setTodoCompletedIndices(prev => new Set([...prev, idx]));
                }
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

      const finalTodoList = todoListRef.current;
      const finalTodoCompleted = todoListRef.current.length ? Array.from(todoCompletedRef.current) : undefined;
      setMessages([...messagesList, {
        role: 'assistant',
        text: finalAnswer,
        steps: [...thinkingStepsRef.current],
        thinkingTexts: [...thinkingTextsRef.current],
        todoList: finalTodoList.length ? finalTodoList : undefined,
        todoCompletedIndices: finalTodoCompleted,
      }]);
    } catch (err) {
      if (err.name === 'AbortError') {
        // User clicked Stop; do not add an error message
      } else {
        setMessages([...messagesList, {
          role: 'assistant',
          text: `Error: ${err.message}. Make sure the backend server is running.`,
          steps: [],
          thinkingTexts: [],
        }]);
      }
    }

    setLoading(false);
    setThinkingSteps([]);
    setThinkingTexts([]);
    thinkingStepsRef.current = [];
    thinkingTextsRef.current = [];
  }, [currentFile, currentContent, mode]);

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
          <div className="chat-mode-toggle">
            <button
              className={`chat-mode-btn ${mode === 'agent' ? 'active' : ''}`}
              onClick={() => setMode('agent')}
              title="Agent Mode - Can make changes"
            >
              Agent
            </button>
            <button
              className={`chat-mode-btn ${mode === 'chat' ? 'active' : ''}`}
              onClick={() => setMode('chat')}
              title="Chat Mode - Read-only, information only"
            >
              Chat
            </button>
          </div>
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
            onConfirmCommand={(resultStep) => {
              // For completed messages, we can't update steps dynamically
              // This callback is mainly for live thinking steps
              // For completed messages, confirmations should have been handled already
              console.log('Confirmation for completed message:', resultStep);
            }}
          />
        ))}

        {/* Live working display - Cursor style */}
        {loading && (
          <div className="chat-message assistant">
            <div className="chat-message-avatar">
              <div className="avatar-ai"><VscSparkle size={16} /></div>
            </div>
            <div className="chat-message-content">
              <div className="chat-message-header">
                <span className="chat-message-role">AI Assistant</span>
              </div>
              <div className="chat-thinking-live">
                {/* Todo list when agent sent one */}
                {todoList.length > 0 && (
                  <TodoListBlock steps={todoList} completedIndices={todoCompletedIndices} />
                )}
                {/* Tool steps as they happen */}
                <ToolStepsBlock 
                  steps={thinkingSteps}
                  onConfirmCommand={(resultStep) => {
                    // Add result step to thinking steps
                    thinkingStepsRef.current = [...thinkingStepsRef.current, resultStep];
                    setThinkingSteps(prev => [...prev, resultStep]);
                  }}
                />

                {/* Loading indicator + Stop */}
                <div className="chat-loading">
                  <div className="chat-loading-dots">
                    <span></span><span></span><span></span>
                  </div>
                  <span className="chat-loading-text">
                    {thinkingSteps.filter(s => s.type === 'step').length === 0 ? 'Thinking...' : 'Working...'}
                  </span>
                  <button
                    type="button"
                    className="chat-stop-btn"
                    onClick={stopGeneration}
                    title="Stop generating"
                  >
                    <VscDebugStop size={14} />
                    <span>Stop</span>
                  </button>
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
