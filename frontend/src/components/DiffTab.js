import React, { useEffect, useRef, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import axios from 'axios';
import { API_URL as API } from '../config';

// ─── Synthetic-path encoding for diff tabs ───────────────────────────────────
//
// The editor's openFiles array stores plain string paths. Diff tabs share that
// array so users can switch between them via the regular tab bar, but they
// need extra metadata (which side to compare against). We encode that as a
// synthetic path:
//
//     __nebula_diff__::<against>::<encoded path>
//
// against:  HEAD     — working tree vs HEAD     (unstaged change)
//           STAGE    — staged vs HEAD           (staged change)
//
// All helpers below treat this scheme as opaque; nothing outside this file
// should hand-construct the strings.

const PREFIX = '__nebula_diff__::';

export function buildDiffTabKey(path, against = 'HEAD') {
  const a = String(against || 'HEAD').toUpperCase();
  return `${PREFIX}${a}::${encodeURIComponent(path)}`;
}

export function isDiffTabKey(key) {
  return typeof key === 'string' && key.startsWith(PREFIX);
}

export function parseDiffTabKey(key) {
  if (!isDiffTabKey(key)) return null;
  const rest = key.slice(PREFIX.length);
  const idx = rest.indexOf('::');
  if (idx < 0) return null;
  const against = rest.slice(0, idx).toUpperCase();
  const path = decodeURIComponent(rest.slice(idx + 2));
  return { path, against };
}

export function diffTabLabel(key) {
  const parsed = parseDiffTabKey(key);
  if (!parsed) return key;
  const name = parsed.path.split(/[\\/]/).filter(Boolean).pop() || parsed.path;
  const suffix = parsed.against === 'STAGE' ? '(Index)' : '(Working Tree)';
  return `${name} ${suffix}`;
}

// ─── Language inference (mirrors App.getLanguage but local so DiffTab is self-
//     contained) ────────────────────────────────────────────────────────────
const LANG_BY_EXT = {
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', json: 'json', html: 'html', htm: 'html', css: 'css',
  scss: 'scss', less: 'less', md: 'markdown', yaml: 'yaml', yml: 'yaml',
  xml: 'xml', svg: 'xml', sh: 'shell', bash: 'shell', sql: 'sql',
  java: 'java', go: 'go', rs: 'rust', rb: 'ruby', php: 'php',
  swift: 'swift', kt: 'kotlin', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  cs: 'csharp', dockerfile: 'dockerfile', toml: 'ini', ini: 'ini',
};
function languageFor(filename) {
  if (!filename) return 'plaintext';
  const ext = filename.split('.').pop().toLowerCase();
  return LANG_BY_EXT[ext] || 'plaintext';
}

// ─── Content fetchers ────────────────────────────────────────────────────────
async function fetchRefContent(path, ref) {
  try {
    const res = await axios.get(`${API}/files/git-show`, {
      params: { path, ref },
      timeout: 30000,
    });
    if (!res.data || res.data.ok === false) {
      return { content: '', exists: false, error: res.data?.error };
    }
    if (res.data.binary) {
      return { content: '(binary file — diff not shown)', exists: true, binary: true };
    }
    return { content: res.data.content || '', exists: !!res.data.exists };
  } catch (e) {
    return { content: '', exists: false, error: e?.message || String(e) };
  }
}

async function fetchWorkingTreeContent(path) {
  try {
    // The Electron renderer has direct filesystem access via IPC. Fall back to
    // the backend route otherwise (browser dev).
    const elAPI = typeof window !== 'undefined' ? window.electronAPI : null;
    if (elAPI && typeof elAPI.readProjectFile === 'function') {
      const r = await elAPI.readProjectFile(path);
      if (r && r.ok && typeof r.content === 'string') return { content: r.content, exists: true };
    }
    const res = await axios.get(`${API}/files/read`, {
      params: { path },
      timeout: 30000,
    });
    const data = res.data || {};
    if (typeof data.content === 'string') return { content: data.content, exists: true };
    if (data.error) return { content: '', exists: false, error: data.error };
    return { content: '', exists: false };
  } catch (e) {
    return { content: '', exists: false, error: e?.message || String(e) };
  }
}

// ─── Diff tab ────────────────────────────────────────────────────────────────
//
// Renders a Monaco DiffEditor for one of:
//   - against === 'HEAD'  → left: HEAD,  right: working tree
//   - against === 'STAGE' → left: HEAD,  right: index (staged)
//
// Working tree fetches go through electronAPI.readProjectFile (or
// /files/content as a fallback) so the diff stays in sync with what the user
// just saved on disk.
export default function DiffTab({
  path,
  against = 'HEAD',
  monacoTheme = 'nebula',
  ideSettings = {},
}) {
  const [left, setLeft]   = useState('');
  const [right, setRight] = useState('');
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState(null);
  const [meta, setMeta] = useState({ leftExists: false, rightExists: false, binary: false });
  const reqIdRef = useRef(0);

  useEffect(() => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setErrorMsg(null);

    (async () => {
      try {
        const isStage = against === 'STAGE';
        const [leftRes, rightRes] = await Promise.all([
          fetchRefContent(path, 'HEAD'),
          isStage ? fetchRefContent(path, 'STAGE') : fetchWorkingTreeContent(path),
        ]);

        // Guard against out-of-order requests (user switches paths quickly).
        if (reqIdRef.current !== reqId) return;

        setLeft(leftRes.content || '');
        setRight(rightRes.content || '');
        setMeta({
          leftExists: !!leftRes.exists,
          rightExists: !!rightRes.exists,
          binary: !!(leftRes.binary || rightRes.binary),
        });
        if (leftRes.error && rightRes.error) {
          setErrorMsg(`${leftRes.error} / ${rightRes.error}`);
        }
      } catch (e) {
        if (reqIdRef.current !== reqId) return;
        setErrorMsg(e?.message || String(e));
      } finally {
        if (reqIdRef.current === reqId) setLoading(false);
      }
    })();
  }, [path, against]);

  const language = languageFor(path);

  if (loading) {
    return (
      <div className="diff-tab-loading" style={{ padding: 24, color: 'var(--text-muted, #888)' }}>
        Loading diff for {path}…
      </div>
    );
  }

  if (errorMsg) {
    return (
      <div className="diff-tab-error" style={{ padding: 24, color: '#f14c4c' }}>
        Failed to load diff: {errorMsg}
      </div>
    );
  }

  if (meta.binary) {
    return (
      <div className="diff-tab-error" style={{ padding: 24, color: 'var(--text-muted, #888)' }}>
        Binary file — diff not shown.
      </div>
    );
  }

  return (
    <div className="diff-tab" style={{ height: '100%', width: '100%' }}>
      <div
        className="diff-tab-header"
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '4px 12px', fontSize: 12,
          color: 'var(--text-muted, #888)',
          borderBottom: '1px solid var(--border, #2b2b2b)',
        }}
      >
        <span>{path}</span>
        <span style={{ opacity: 0.6 }}>·</span>
        <span>
          {against === 'STAGE' ? 'HEAD ↔ Index (staged)' : 'HEAD ↔ Working Tree'}
        </span>
        {!meta.leftExists && (
          <span style={{ opacity: 0.6, marginLeft: 'auto' }}>new file</span>
        )}
      </div>
      <DiffEditor
        height="calc(100% - 26px)"
        language={language}
        original={left}
        modified={right}
        theme={monacoTheme}
        options={{
          fontSize: ideSettings.fontSize || 14,
          fontFamily: ideSettings.fontFamily
            ? `'${ideSettings.fontFamily}', 'Fira Code', 'Cascadia Code', 'SF Mono', Menlo, Monaco, monospace`
            : "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', Menlo, Monaco, monospace",
          fontLigatures: ideSettings.fontLigatures !== undefined ? ideSettings.fontLigatures : true,
          lineHeight: 22,
          readOnly: true,
          originalEditable: false,
          renderSideBySide: true,
          renderOverviewRuler: true,
          ignoreTrimWhitespace: false,
          renderIndicators: true,
          enableSplitViewResizing: true,
          minimap: { enabled: false },
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
          automaticLayout: true,
          wordWrap: ideSettings.wordWrap ? 'on' : 'off',
          tabSize: ideSettings.tabSize || 2,
        }}
      />
    </div>
  );
}
