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
// against:  HEAD            — working tree vs HEAD     (unstaged change)
//           STAGE           — staged vs HEAD           (staged change)
//           COMMIT:<hash>   — <hash>^ vs <hash>        (single commit's diff)
//
// All helpers below treat this scheme as opaque; nothing outside this file
// should hand-construct the strings. The COMMIT: prefix is NOT uppercased so
// the hex hash survives the round-trip intact (git accepts uppercase hashes
// too, but tooling everywhere else expects lowercase, so keep it lowercase).

const PREFIX = '__nebula_diff__::';

function _normalizeAgainst(against) {
  const s = String(against || 'HEAD');
  if (s.toUpperCase().startsWith('COMMIT:')) {
    // Preserve original casing of the hash so future readers don't get
    // tripped up by `git log` output that's all-lowercase.
    return 'COMMIT:' + s.slice(7);
  }
  return s.toUpperCase();
}

export function buildDiffTabKey(path, against = 'HEAD') {
  return `${PREFIX}${_normalizeAgainst(against)}::${encodeURIComponent(path)}`;
}

export function isDiffTabKey(key) {
  return typeof key === 'string' && key.startsWith(PREFIX);
}

export function parseDiffTabKey(key) {
  if (!isDiffTabKey(key)) return null;
  const rest = key.slice(PREFIX.length);
  const idx = rest.indexOf('::');
  if (idx < 0) return null;
  const rawAgainst = rest.slice(0, idx);
  const against = rawAgainst.toUpperCase().startsWith('COMMIT:')
    ? 'COMMIT:' + rawAgainst.slice(7)
    : rawAgainst.toUpperCase();
  const path = decodeURIComponent(rest.slice(idx + 2));
  return { path, against };
}

export function diffTabLabel(key) {
  const parsed = parseDiffTabKey(key);
  if (!parsed) return key;
  const name = parsed.path.split(/[\\/]/).filter(Boolean).pop() || parsed.path;
  if (parsed.against === 'STAGE') return `${name} (Index)`;
  if (parsed.against === 'HEAD')  return `${name} (Working Tree)`;
  if (parsed.against.startsWith('COMMIT:')) {
    return `${name} (${parsed.against.slice(7, 14)})`;
  }
  return `${name} (${parsed.against})`;
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
        const isStage  = against === 'STAGE';
        const isCommit = typeof against === 'string' && against.startsWith('COMMIT:');

        // Decide what to fetch for each side based on the comparison mode.
        //   HEAD          : HEAD          vs working tree
        //   STAGE         : HEAD          vs index
        //   COMMIT:<hash> : <hash>^       vs <hash>     (the diff that commit introduced)
        let leftPromise;
        let rightPromise;
        if (isCommit) {
          const hash = against.slice(7);
          // hash^ may not exist for the very first commit — DiffTab renders
          // (left = empty, right = full file) as "new file" in that case,
          // which is exactly what git itself shows for the initial commit.
          leftPromise  = fetchRefContent(path, `${hash}^`);
          rightPromise = fetchRefContent(path, hash);
        } else {
          leftPromise  = fetchRefContent(path, 'HEAD');
          rightPromise = isStage ? fetchRefContent(path, 'STAGE') : fetchWorkingTreeContent(path);
        }

        const [leftRes, rightRes] = await Promise.all([leftPromise, rightPromise]);

        // Guard against out-of-order requests (user switches paths quickly).
        if (reqIdRef.current !== reqId) return;

        setLeft(leftRes.content || '');
        setRight(rightRes.content || '');
        setMeta({
          leftExists: !!leftRes.exists,
          rightExists: !!rightRes.exists,
          binary: !!(leftRes.binary || rightRes.binary),
        });
        // For commit diffs, a missing-on-the-left side is normal (added file)
        // and a missing-on-the-right side is normal (deleted file). Only show
        // an error if BOTH sides failed — that's a real problem.
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
      <ManagedDiffEditor
        left={left}
        right={right}
        language={language}
        theme={monacoTheme}
        ideSettings={ideSettings}
      />
    </div>
  );
}

// ─── ManagedDiffEditor ─────────────────────────────────────────────────────
//
// Wraps @monaco-editor/react's <DiffEditor> with explicit TextModel lifecycle
// management. The library disposes its auto-created models when `original` or
// `modified` props change, and that disposal can race with Monaco's internal
// `_onModelChanged` listener, producing:
//
//   "TextModel got disposed before DiffEditorWidget model got reset"
//
// during React unmount. The race is most easily triggered by rapid tab
// switching, React 18 StrictMode's effect double-invocation, or fast
// successive prop updates.
//
// Strategy: pass empty strings for initial props, then on `onMount` create
// our own models. From then on we update the existing models via
// `.setValue()` so the DiffEditor never sees its model reference change.
// On unmount we schedule disposal on a microtask so any pending Monaco
// listeners have already run.
function ManagedDiffEditor({ left, right, language, theme, ideSettings }) {
  const editorRef = useRef(null);     // monaco DiffEditor instance
  const monacoRef = useRef(null);     // monaco namespace from onMount
  const modelsRef = useRef(null);     // { original, modified }
  const mountedRef = useRef(false);

  // Update the model values whenever left/right/language change. We compare
  // against the current model value to avoid no-op .setValue() calls (which
  // still trigger render passes).
  useEffect(() => {
    const models = modelsRef.current;
    if (!models) return;
    try {
      if (models.original && models.original.getValue() !== (left || '')) {
        models.original.setValue(left || '');
      }
      if (models.modified && models.modified.getValue() !== (right || '')) {
        models.modified.setValue(right || '');
      }
      // Keep the language in sync. Monaco accepts a setModelLanguage call
      // on already-attached models without triggering full re-init.
      const m = monacoRef.current;
      if (m && language) {
        if (models.original) m.editor.setModelLanguage(models.original, language);
        if (models.modified) m.editor.setModelLanguage(models.modified, language);
      }
    } catch (_) { /* model already disposed in a strict-mode replay; ignore */ }
  }, [left, right, language]);

  const handleMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    mountedRef.current = true;

    // Create our own pair of models so the wrapper doesn't manage them.
    const original = monaco.editor.createModel(left || '', language);
    const modified = monaco.editor.createModel(right || '', language);
    modelsRef.current = { original, modified };
    editor.setModel({ original, modified });
  };

  // Cleanup: dispose models AFTER React has finished unmounting the editor.
  // The microtask delay is the crucial bit — it lets Monaco's _onModelChanged
  // listener finish processing the editor's own dispose() before we yank the
  // models out from under it. Without the delay we hit the original error.
  useEffect(() => {
    return () => {
      const models = modelsRef.current;
      modelsRef.current = null;
      mountedRef.current = false;
      // Defer one microtask + one macrotask. Microtask drains the synchronous
      // dispose chain Monaco fires; the setTimeout gives any queued layout
      // listeners a chance to settle.
      Promise.resolve().then(() => setTimeout(() => {
        try { models?.original?.dispose(); } catch (_) {}
        try { models?.modified?.dispose(); } catch (_) {}
      }, 0));
    };
  }, []);

  return (
    <DiffEditor
      height="calc(100% - 26px)"
      // Initial models are placeholders — handleMount immediately replaces
      // them with our managed pair. Pass empty strings to avoid pre-mount
      // model creation by the wrapper itself.
      original=""
      modified=""
      language={language}
      theme={theme}
      // Tell @monaco-editor/react NOT to touch our models when this React
      // component unmounts. We dispose them ourselves with the right timing.
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      onMount={handleMount}
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
  );
}
