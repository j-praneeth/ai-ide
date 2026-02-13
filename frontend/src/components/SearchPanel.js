import React, { useState, useCallback } from 'react';
import {
  VscCaseSensitive,
  VscWholeWord,
  VscRegex,
  VscReplace,
  VscReplaceAll,
  VscChevronRight,
  VscChevronDown,
} from 'react-icons/vsc';
import axios from 'axios';
import { API_URL as API } from '../config';

export default function SearchPanel({ onOpenFile }) {
  const [query, setQuery] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState(new Set());
  const [replaceStatus, setReplaceStatus] = useState('');

  const search = useCallback(async () => {
    if (!query.trim()) return;
    setSearching(true);
    setReplaceStatus('');
    try {
      // Build the actual search query based on toggles
      let searchQuery = query;
      if (wholeWord && !useRegex) {
        searchQuery = `\\b${query}\\b`;
      }
      
      const res = await axios.get(`${API}/files/search`, {
        params: { 
          query: searchQuery, 
          case_sensitive: caseSensitive,
          use_regex: useRegex,
        }
      });
      setResults(res.data.results || []);
      const files = new Set((res.data.results || []).map(r => r.file));
      setExpandedFiles(files);
    } catch (err) {
      console.error('Search failed:', err);
      setResults([]);
    }
    setSearching(false);
  }, [query, caseSensitive, wholeWord, useRegex]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') search();
  };

  const toggleFile = (file) => {
    setExpandedFiles(prev => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  };

  // Replace in a single file match
  const handleReplace = useCallback(async (file, line) => {
    if (!replaceText && replaceText !== '') return;
    try {
      // Read the file
      const res = await axios.get(`${API}/files/read`, { params: { path: file } });
      const lines = res.data.content.split('\n');
      // Replace in the specific line
      if (lines[line - 1]) {
        if (caseSensitive) {
          lines[line - 1] = lines[line - 1].replace(query, replaceText);
        } else {
          lines[line - 1] = lines[line - 1].replace(new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), replaceText);
        }
      }
      await axios.post(`${API}/files/write`, null, {
        params: { path: file, content: lines.join('\n') }
      });
      setReplaceStatus(`Replaced in ${file}:${line}`);
      // Re-search
      search();
    } catch (err) {
      console.error('Replace failed:', err);
      setReplaceStatus('Replace failed');
    }
  }, [query, replaceText, caseSensitive, search]);

  // Replace all
  const handleReplaceAll = useCallback(async () => {
    if (results.length === 0) return;
    let count = 0;
    const fileGroups = {};
    results.forEach(r => {
      if (!fileGroups[r.file]) fileGroups[r.file] = [];
      fileGroups[r.file].push(r);
    });

    for (const [file] of Object.entries(fileGroups)) {
      try {
        const res = await axios.get(`${API}/files/read`, { params: { path: file } });
        let content = res.data.content;
        const flags = caseSensitive ? 'g' : 'gi';
        const pattern = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(wholeWord ? `\\b${pattern}\\b` : pattern, flags);
        const newContent = content.replace(regex, replaceText);
        if (newContent !== content) {
          await axios.post(`${API}/files/write`, null, {
            params: { path: file, content: newContent }
          });
          count++;
        }
      } catch (err) {
        console.error(`Replace all failed for ${file}:`, err);
      }
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
  const totalFiles = Object.keys(grouped).length;

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
              <button
                className={`icon-btn tiny ${caseSensitive ? 'active' : ''}`}
                title="Match Case"
                onClick={() => setCaseSensitive(!caseSensitive)}
              >
                <VscCaseSensitive size={14} />
              </button>
              <button
                className={`icon-btn tiny ${wholeWord ? 'active' : ''}`}
                title="Match Whole Word"
                onClick={() => setWholeWord(!wholeWord)}
              >
                <VscWholeWord size={14} />
              </button>
              <button
                className={`icon-btn tiny ${useRegex ? 'active' : ''}`}
                title="Use Regular Expression"
                onClick={() => setUseRegex(!useRegex)}
              >
                <VscRegex size={14} />
              </button>
            </div>
          </div>
          <button
            className="icon-btn"
            title="Toggle Replace"
            onClick={() => setShowReplace(!showReplace)}
          >
            <VscChevronRight size={14} style={{
              transform: showReplace ? 'rotate(90deg)' : 'none',
              transition: 'transform 0.15s'
            }}/>
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
                <button className="icon-btn tiny" title="Replace" onClick={() => {
                  // Replace first occurrence
                  const firstResult = results[0];
                  if (firstResult) handleReplace(firstResult.file, firstResult.line);
                }}>
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
        {searching && <div className="search-message">Searching...</div>}
        {!searching && query && results.length === 0 && (
          <div className="search-message">No results found.</div>
        )}
        {!searching && totalResults > 0 && (
          <div className="search-summary">
            {totalResults} result{totalResults !== 1 ? 's' : ''} in {totalFiles} file{totalFiles !== 1 ? 's' : ''}
          </div>
        )}
        {replaceStatus && (
          <div className="search-summary" style={{ color: 'var(--success)' }}>{replaceStatus}</div>
        )}
        {Object.entries(grouped).map(([file, matches]) => (
          <div key={file} className="search-file-group">
            <div className="search-file-header" onClick={() => toggleFile(file)}>
              {expandedFiles.has(file) ? <VscChevronDown size={14} /> : <VscChevronRight size={14} />}
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
                    onClick={(e) => { e.stopPropagation(); handleReplace(file, match.line); }}
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
