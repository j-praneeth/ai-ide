/**
 * SearchPanel — VS Code-style streaming search with RunOnceScheduler batching.
 *
 * Mirrors:
 *   src/vs/workbench/services/search/node/ripgrepTextSearchEngine.ts
 *     → results streamed immediately via stdout, not batched
 *   src/vs/workbench/contrib/search/browser/searchView.ts
 *     → RunOnceScheduler(80ms) batches DOM updates to prevent thrashing
 *
 * Key patterns:
 *  1. SSE streaming — each match emitted immediately from the backend;
 *     the frontend receives results before the search completes.
 *  2. RunOnceScheduler (80ms) — accumulate matches in a buffer, flush
 *     to React state at most once per 80ms (same value as VS Code).
 *  3. Cancelable fetch — previous search is aborted when a new one starts
 *     (mirrors createCancelablePromise / CancellationTokenSource).
 *  4. When limit hit, stream closes → no wasted work (same as ripgrep kill()).
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  VscCaseSensitive, VscWholeWord, VscRegex,
  VscReplace, VscReplaceAll, VscChevronRight, VscChevronDown,
} from 'react-icons/vsc';
import axios from 'axios';
import { API_URL as API } from '../config';
import { authFetch } from '../lib/auth';
import { RunOnceScheduler } from '../lib/async';
import { buildMatchRegex } from '../lib/searchMatch';

// VS Code uses 80ms batching for search result DOM updates
const RESULT_BATCH_MS = 80;

/** Parse one SSE `data:` line into JSON; undefined if not a data payload or invalid JSON. */
function parseSseDataLine(rawLine) {
  const trimmed = String(rawLine || '').replace(/\r$/, '');
  if (!trimmed.length || trimmed.startsWith(':')) return undefined;
  if (!trimmed.startsWith('data:')) return undefined;
  const jsonText = trimmed.slice(5).trimStart();
  if (!jsonText) return undefined;
  try {
    return JSON.parse(jsonText);
  } catch {
    return undefined;
  }
}

export default function SearchPanel({ onOpenFile, hasWorkspace = true }) {
  const [query,         setQuery]         = useState('');
  const [replaceText,   setReplaceText]   = useState('');
  const [showReplace,   setShowReplace]   = useState(false);
  const [results,       setResults]       = useState([]);
  const [searching,     setSearching]     = useState(false);
  const [truncated,     setTruncated]     = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord,     setWholeWord]     = useState(false);
  const [useRegex,      setUseRegex]      = useState(false);
  const [expandedFiles, setExpandedFiles] = useState(new Set());
  const [replaceStatus, setReplaceStatus] = useState('');

  // Accumulation buffer — matches stream in here; RunOnceScheduler flushes to state
  const resultBuffer = useRef([]);
  // AbortController for the active SSE stream (cancel on new search)
  const abortRef     = useRef(null);
  // RunOnceScheduler — flushes buffered results to React state every 80ms
  const scheduler    = useRef(null);

  const highlightRegex = useMemo(
    () => buildMatchRegex(query, { caseSensitive, wholeWord, useRegex }),
    [query, caseSensitive, wholeWord, useRegex],
  );

  const renderHighlightedLine = (text) => {
    try {
      const s = String(text ?? '');
      if (!highlightRegex) return s;
      const parts = [];
      let last = 0;
      const r = new RegExp(
        highlightRegex.source,
        highlightRegex.flags.includes('g') ? highlightRegex.flags : `${highlightRegex.flags}g`,
      );
      let guard = 0;
      let m;
      while ((m = r.exec(s)) !== null && guard++ < 200) {
        parts.push(s.slice(last, m.index));
        parts.push(
          <mark key={`${m.index}-${parts.length}`} className="search-hit">{m[0]}</mark>,
        );
        last = m.index + m[0].length;
        if (m.index === r.lastIndex) r.lastIndex += 1;
      }
      parts.push(s.slice(last));
      return parts.length === 1 ? parts[0] : parts;
    } catch {
      return String(text ?? '');
    }
  };

  const flushRef = useRef(() => {});
  flushRef.current = () => {
    const batch = resultBuffer.current.splice(0);
    if (batch.length === 0) return;
    setResults((prev) => {
      const next = [...prev, ...batch];
      setExpandedFiles((exp) => {
        const n = new Set(exp);
        batch.forEach((r) => {
          if (r && r.file) n.add(r.file);
        });
        return n;
      });
      return next;
    });
  };

  // Initialise scheduler once
  useEffect(() => {
    const sched = new RunOnceScheduler(() => flushRef.current(), RESULT_BATCH_MS);
    scheduler.current = sched;
    return () => {
      sched.dispose();
      scheduler.current = null;
    };
  }, []);

  const search = useCallback(async () => {
    const q = query.trim();
    if (!q) return;

    if (!hasWorkspace) {
      setResults([]);
      setExpandedFiles(new Set());
      setTruncated(false);
      setSearching(false);
      setReplaceStatus('');
      return;
    }

    // Cancel previous in-flight search (createCancelablePromise equivalent)
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    scheduler.current?.cancel();
    resultBuffer.current = [];

    if (!scheduler.current) {
      scheduler.current = new RunOnceScheduler(() => flushRef.current(), RESULT_BATCH_MS);
    }

    setResults([]);
    setExpandedFiles(new Set());
    setTruncated(false);
    setSearching(true);
    setReplaceStatus('');

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    let searchQuery = q;
    if (wholeWord && !useRegex) searchQuery = `\\b${q}\\b`;

    const url = `${API}/files/search-stream?query=${encodeURIComponent(searchQuery)}&case_sensitive=${caseSensitive}&use_regex=${useRegex}`;

    try {
      // fetch() with ReadableStream — streams SSE results without blocking
      const response = await authFetch(url, { signal: ctrl.signal });
      if (!response.ok || !response.body) {
        throw new Error('Stream unavailable');
      }

      const reader  = response.body.getReader();
      const decoder = new TextDecoder();
      let   partial = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        partial += decoder.decode(value, { stream: true });
        const lines = partial.split('\n');
        partial = lines.pop(); // keep incomplete line

        for (const line of lines) {
          const payload = parseSseDataLine(line);
          if (payload === undefined) continue;

          if (payload.done === true) {
            setTruncated(!!payload.truncated);
            scheduler.current?.cancel();
            const remaining = resultBuffer.current.splice(0);
            if (remaining.length > 0) {
              setResults((prev) => {
                const next = [...prev, ...remaining];
                setExpandedFiles((exp) => {
                  const n = new Set(exp);
                  remaining.forEach((r) => {
                    if (r && r.file) n.add(r.file);
                  });
                  return n;
                });
                return next;
              });
            }
          } else if (payload.file != null && payload.line != null) {
            resultBuffer.current.push(payload);
            const sch = scheduler.current;
            if (sch && !sch.isScheduled()) {
              sch.schedule();
            } else if (!sch) {
              flushRef.current();
            }
          }
        }
      }

      if (partial.trim()) {
        const tailLines = partial.split('\n');
        for (const line of tailLines) {
          const payload = parseSseDataLine(line);
          if (payload === undefined) continue;
          if (payload.done === true) {
            setTruncated(!!payload.truncated);
            scheduler.current?.cancel();
            const remaining = resultBuffer.current.splice(0);
            if (remaining.length > 0) {
              setResults((prev) => {
                const next = [...prev, ...remaining];
                setExpandedFiles((exp) => {
                  const n = new Set(exp);
                  remaining.forEach((r) => {
                    if (r && r.file) n.add(r.file);
                  });
                  return n;
                });
                return next;
              });
            }
          } else if (payload.file != null && payload.line != null) {
            resultBuffer.current.push(payload);
            const sch = scheduler.current;
            if (sch && !sch.isScheduled()) sch.schedule();
            else if (!sch) flushRef.current();
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        // SSE not available — fall back to batch endpoint
        try {
          const res = await axios.get(`${API}/files/search`, {
            params: { query: searchQuery, case_sensitive: caseSensitive, use_regex: useRegex },
            timeout: 120000,
          });
          const items = res.data.results || [];
          setResults(items);
          setExpandedFiles(new Set(items.map(r => r.file)));
          setTruncated(!!res.data.truncated);
        } catch (_) {
          setResults([]);
        }
      }
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setSearching(false);
    }
  }, [query, caseSensitive, wholeWord, useRegex, hasWorkspace]);

  // Cancel stream on unmount
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const handleKeyDown = (e) => { if (e.key === 'Enter') search(); };

  const toggleFile = (file) => {
    setExpandedFiles(prev => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  };

  const handleReplace = useCallback(async (file, line) => {
    if (replaceText === undefined) return;
    try {
      const res = await axios.get(`${API}/files/read`, { params: { path: file } });
      const lines = res.data.content.split('\n');
      if (lines[line - 1]) {
        if (caseSensitive) {
          lines[line - 1] = lines[line - 1].replace(query, replaceText);
        } else {
          lines[line - 1] = lines[line - 1].replace(
            new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
            replaceText
          );
        }
      }
      await axios.post(`${API}/files/write`, { path: file, content: lines.join('\n') });
      setReplaceStatus(`Replaced in ${file}:${line}`);
      search();
    } catch (err) {
      setReplaceStatus('Replace failed');
    }
  }, [query, replaceText, caseSensitive, search]);

  const handleReplaceAll = useCallback(async () => {
    if (results.length === 0) return;
    const fileGroups = {};
    results.forEach(r => {
      if (!fileGroups[r.file]) fileGroups[r.file] = [];
      fileGroups[r.file].push(r);
    });
    let count = 0;
    for (const [file] of Object.entries(fileGroups)) {
      try {
        const res = await axios.get(`${API}/files/read`, { params: { path: file } });
        let content = res.data.content;
        const flags   = caseSensitive ? 'g' : 'gi';
        const pattern = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex   = new RegExp(wholeWord ? `\\b${pattern}\\b` : pattern, flags);
        const updated = content.replace(regex, replaceText);
        if (updated !== content) {
          await axios.post(`${API}/files/write`, { path: file, content: updated });
          count++;
        }
      } catch (_) {}
    }
    setReplaceStatus(`Replaced in ${count} file(s)`);
    search();
  }, [results, query, replaceText, caseSensitive, wholeWord, useRegex, search]);

  // Group results by file
  const grouped = {};
  results.forEach(r => {
    if (!grouped[r.file]) grouped[r.file] = [];
    grouped[r.file].push(r);
  });

  const totalResults = results.length;
  const totalFiles   = Object.keys(grouped).length;

  return (
    <div className="search-panel">
      <div className="sidebar-header">
        <span className="sidebar-title">SEARCH</span>
      </div>

      <div className="search-inputs">
        <div className="search-input-row">
          <div className="search-input-wrapper">
            <input
              className="search-input"
              placeholder="Search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <div className="search-input-actions">
              <button className={`icon-btn tiny ${caseSensitive ? 'active' : ''}`}
                title="Match Case" onClick={() => setCaseSensitive(v => !v)}>
                <VscCaseSensitive size={14} />
              </button>
              <button className={`icon-btn tiny ${wholeWord ? 'active' : ''}`}
                title="Match Whole Word" onClick={() => setWholeWord(v => !v)}>
                <VscWholeWord size={14} />
              </button>
              <button className={`icon-btn tiny ${useRegex ? 'active' : ''}`}
                title="Use Regular Expression" onClick={() => setUseRegex(v => !v)}>
                <VscRegex size={14} />
              </button>
            </div>
          </div>
          <button className="icon-btn" title="Toggle Replace" onClick={() => setShowReplace(v => !v)}>
            <VscChevronRight size={14} style={{
              transform: showReplace ? 'rotate(90deg)' : 'none',
              transition: 'transform 0.15s',
            }} />
          </button>
        </div>

        {showReplace && (
          <div className="search-input-row">
            <div className="search-input-wrapper">
              <input
                className="search-input"
                placeholder="Replace"
                value={replaceText}
                onChange={e => setReplaceText(e.target.value)}
              />
              <div className="search-input-actions">
                <button className="icon-btn tiny" title="Replace"
                  onClick={() => { const f = results[0]; if (f) handleReplace(f.file, f.line); }}>
                  <VscReplace size={14} />
                </button>
                <button className="icon-btn tiny" title="Replace All" onClick={handleReplaceAll}>
                  <VscReplaceAll size={14} />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="search-results">
        {!hasWorkspace && query.trim() && (
          <div className="search-message">Open a folder to search in this workspace.</div>
        )}
        {searching && (
          <div className="search-message">
            Searching{totalResults > 0 ? ` — ${totalResults} result${totalResults !== 1 ? 's' : ''} so far` : '...'}
          </div>
        )}
        {!searching && query && results.length === 0 && hasWorkspace && (
          <div className="search-message">No results found.</div>
        )}
        {totalResults > 0 && (
          <div className="search-summary">
            {totalResults} result{totalResults !== 1 ? 's' : ''} in {totalFiles} file{totalFiles !== 1 ? 's' : ''}
            {truncated && ' (showing first 500)'}
          </div>
        )}
        {replaceStatus && (
          <div className="search-summary" style={{ color: 'var(--success)' }}>{replaceStatus}</div>
        )}

        {Object.entries(grouped).map(([file, matches]) => (
          <div key={file} className="search-file-group">
            <div className="search-file-header" onClick={() => toggleFile(file)}>
              {expandedFiles.has(file)
                ? <VscChevronDown size={14} />
                : <VscChevronRight size={14} />}
              <span className="search-file-name">{file}</span>
              <span className="search-file-count">{matches.length}</span>
            </div>
            {expandedFiles.has(file) && matches.map((match, idx) => (
              <div
                key={idx}
                className="search-result-line"
                onClick={() => onOpenFile(file, {
                  line: match.line,
                  search: { query, caseSensitive, wholeWord, useRegex },
                })}
              >
                <span className="search-line-number">{match.line}</span>
                <span className="search-line-text">{renderHighlightedLine(match.text)}</span>
                {showReplace && (
                  <button
                    className="icon-btn tiny"
                    title="Replace this occurrence"
                    onClick={e => { e.stopPropagation(); handleReplace(file, match.line); }}
                    style={{ marginLeft: 'auto', flexShrink: 0 }}
                  >
                    <VscReplace size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
