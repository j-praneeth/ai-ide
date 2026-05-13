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

import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  VscCaseSensitive, VscWholeWord, VscRegex,
  VscReplace, VscReplaceAll, VscChevronRight, VscChevronDown,
} from 'react-icons/vsc';
import axios from 'axios';
import { API_URL as API } from '../config';
import { RunOnceScheduler } from '../lib/async';

// VS Code uses 80ms batching for search result DOM updates
const RESULT_BATCH_MS = 80;

export default function SearchPanel({ onOpenFile }) {
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

  // Initialise scheduler once
  useEffect(() => {
    const sched = new RunOnceScheduler(() => {
      const batch = resultBuffer.current.splice(0);
      if (batch.length === 0) return;
      setResults(prev => {
        const next = [...prev, ...batch];
        // Auto-expand newly seen files (VS Code opens first group automatically)
        setExpandedFiles(exp => {
          const n = new Set(exp);
          batch.forEach(r => n.add(r.file));
          return n;
        });
        return next;
      });
    }, RESULT_BATCH_MS);
    scheduler.current = sched;
    return () => sched.dispose();
  }, []);

  const search = useCallback(async () => {
    const q = query.trim();
    if (!q) return;

    // Cancel previous in-flight search (createCancelablePromise equivalent)
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    scheduler.current?.cancel();
    resultBuffer.current = [];

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
      const response = await fetch(url, { signal: ctrl.signal });
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
          if (!line.startsWith('data: ')) continue;
          try {
            const payload = JSON.parse(line.slice(6));
            if (payload.done) {
              setTruncated(!!payload.truncated);
              // Flush remaining buffered results immediately on stream end
              scheduler.current?.cancel();
              const remaining = resultBuffer.current.splice(0);
              if (remaining.length > 0) {
                setResults(prev => {
                  const next = [...prev, ...remaining];
                  setExpandedFiles(exp => {
                    const n = new Set(exp);
                    remaining.forEach(r => n.add(r.file));
                    return n;
                  });
                  return next;
                });
              }
            } else {
              // Buffer the match and schedule a flush (80ms RunOnceScheduler)
              resultBuffer.current.push(payload);
              if (!scheduler.current.isScheduled()) {
                scheduler.current.schedule();
              }
            }
          } catch (_) {}
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        // SSE not available — fall back to batch endpoint
        try {
          const res = await axios.get(`${API}/files/search`, {
            params: { query: searchQuery, case_sensitive: caseSensitive, use_regex: useRegex },
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
  }, [query, caseSensitive, wholeWord, useRegex]);

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
      await axios.post(`${API}/files/write`, null, { params: { path: file, content: lines.join('\n') } });
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
          await axios.post(`${API}/files/write`, null, { params: { path: file, content: updated } });
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
        {searching && (
          <div className="search-message">
            Searching{totalResults > 0 ? ` — ${totalResults} result${totalResults !== 1 ? 's' : ''} so far` : '...'}
          </div>
        )}
        {!searching && query && results.length === 0 && (
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
                onClick={() => onOpenFile(file, match.line)}
              >
                <span className="search-line-number">{match.line}</span>
                <span className="search-line-text">{match.text}</span>
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
