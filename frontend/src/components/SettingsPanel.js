import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { VscSettingsGear } from 'react-icons/vsc';

const API = 'http://127.0.0.1:8000';
const SETTINGS_STORAGE_KEY = 'nebula_ide_settings';

const SETTINGS_GROUPS = [
  {
    id: 'editor',
    label: 'Editor',
    settings: [
      { key: 'fontSize', label: 'Font Size', type: 'number', value: 14, min: 10, max: 24, description: 'Editor font size in pixels.' },
      { key: 'tabSize', label: 'Tab Size', type: 'number', value: 2, min: 1, max: 8, description: 'Number of spaces for a tab.' },
      { key: 'wordWrap', label: 'Word Wrap', type: 'toggle', value: false, description: 'Wrap lines that exceed the editor width.' },
      { key: 'minimap', label: 'Minimap', type: 'toggle', value: true, description: 'Show minimap on the right side.' },
      { key: 'lineNumbers', label: 'Line Numbers', type: 'toggle', value: true, description: 'Show line numbers in the gutter.' },
      { key: 'bracketPairColorization', label: 'Bracket Pair Colorization', type: 'toggle', value: true, description: 'Colorize matching brackets.' },
      { key: 'fontLigatures', label: 'Font Ligatures', type: 'toggle', value: true, description: 'Enable font ligatures.' },
      { key: 'renderWhitespace', label: 'Render Whitespace', type: 'select', value: 'selection', options: [
        { value: 'none', label: 'None' }, { value: 'boundary', label: 'Boundary' },
        { value: 'selection', label: 'Selection' }, { value: 'all', label: 'All' },
      ], description: 'When to render whitespace characters.' },
    ],
  },
  {
    id: 'appearance',
    label: 'Appearance',
    settings: [
      { key: 'theme', label: 'Theme', type: 'select', value: 'Nebula Dark', options: [{ value: 'Nebula Dark', label: 'Nebula Dark' }], description: 'Color theme for the IDE.' },
      { key: 'fontFamily', label: 'Font Family', type: 'text', value: 'JetBrains Mono', description: 'Font family for the editor.' },
    ],
  },
  {
    id: 'terminal',
    label: 'Terminal',
    settings: [
      { key: 'terminalFontSize', label: 'Font Size', type: 'number', value: 13, min: 10, max: 24, description: 'Terminal font size.' },
      { key: 'cursorStyle', label: 'Cursor Style', type: 'select', value: 'bar', options: [{ value: 'bar', label: 'Bar' }, { value: 'block', label: 'Block' }, { value: 'underline', label: 'Underline' }], description: 'Terminal cursor style.' },
    ],
  },
  {
    id: 'ai',
    label: 'AI',
    settings: [
      { key: 'aiModel', label: 'Model', type: 'aiModelDropdown', description: 'Model used for suggestions and chat.' },
      { key: 'autoSuggest', label: 'Auto-suggest', type: 'toggle', value: true, description: 'Show inline suggestions as you type.' },
    ],
  },
];

function getDefaults() {
  const v = {};
  SETTINGS_GROUPS.forEach(g => {
    g.settings.forEach(s => { if (s.type !== 'aiModelDropdown') v[s.key] = s.value; });
  });
  return v;
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      return { ...getDefaults(), ...saved };
    }
  } catch (_) {}
  return getDefaults();
}

function saveSettings(values) {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(values));
  } catch (_) {}
}

const controlStyle = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  color: 'var(--text-primary)',
  padding: '6px 10px',
  fontSize: 'var(--font-size-base)',
  outline: 'none',
};

function SettingRow({ setting, value, onChange }) {
  const { label, type, description, min, max, options } = setting;

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 500, color: 'var(--text-primary)' }}>{label}</span>
        {type === 'toggle' && (
          <button
            type="button"
            role="switch"
            aria-checked={!!value}
            onClick={() => onChange(!value)}
            style={{
              width: 40, height: 22, borderRadius: 11, border: 'none',
              background: value ? 'var(--accent)' : 'var(--bg-elevated)',
              cursor: 'pointer', position: 'relative', transition: 'background var(--duration-fast)',
            }}
          >
            <span style={{
              position: 'absolute', top: 2, left: value ? 20 : 2, width: 18, height: 18,
              borderRadius: '50%', background: 'white', transition: 'left var(--duration-fast)', boxShadow: 'var(--shadow-sm)',
            }} />
          </button>
        )}
        {type === 'number' && (
          <input type="number" min={min} max={max} value={value ?? ''}
            onChange={e => {
              const raw = e.target.value;
              if (raw === '') { onChange(min || 0); return; }
              let num = parseInt(raw, 10);
              if (isNaN(num)) return;
              if (min !== undefined && num < min) num = min;
              if (max !== undefined && num > max) num = max;
              onChange(num);
            }}
            style={{ ...controlStyle, width: 72 }}
          />
        )}
        {type === 'text' && (
          <input type="text" value={value}
            onChange={e => onChange(e.target.value)}
            style={{ ...controlStyle, minWidth: 140, flex: 1, maxWidth: 200 }}
          />
        )}
        {type === 'select' && (
          <select value={value} onChange={e => onChange(e.target.value)}
            style={{ ...controlStyle, minWidth: 120 }}
          >
            {(options || []).map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        )}
      </div>
      {description && (
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', marginTop: 2 }}>{description}</div>
      )}
    </div>
  );
}

function AIModelRow({ models, loading, currentModel, feedback, onRefresh, onSelect }) {
  const [selectValue, setSelectValue] = useState(currentModel || '');
  const [setting, setSetting] = useState(false);

  useEffect(() => { setSelectValue(currentModel || ''); }, [currentModel]);

  const handleChange = async (e) => {
    const name = e.target.value;
    if (!name) return;
    setSelectValue(name);
    setSetting(true);
    try {
      const res = await fetch(`${API}/ai/model/set?model=${encodeURIComponent(name)}`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (data.status === 'ok') onSelect(data.model);
      else onSelect(null, { type: 'error', message: data.message || 'Failed to set model' });
    } catch (err) {
      onSelect(null, { type: 'error', message: err.message || 'Network error' });
    } finally { setSetting(false); }
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 500, color: 'var(--text-primary)' }}>
          Model
          {currentModel && <span style={{ marginLeft: 6, fontSize: 'var(--font-size-xs)', color: 'var(--accent)', fontWeight: 400 }}>&#10003; Active</span>}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {loading ? (
            <span style={{ ...controlStyle, minWidth: 140, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
              Loading...
            </span>
          ) : (
            <>
              <select value={selectValue} onChange={handleChange}
                disabled={setting || !models.length}
                style={{ ...controlStyle, minWidth: 160 }}
                title={currentModel ? `Active: ${currentModel}` : 'Select model'}
              >
                <option value="">Select model...</option>
                {models.map(m => (
                  <option key={m.name} value={m.name}>
                    {m.name === currentModel ? `✓ ${m.name}` : m.name}
                  </option>
                ))}
              </select>
              <button type="button" onClick={onRefresh} disabled={loading}
                style={{ ...controlStyle, cursor: loading ? 'not-allowed' : 'pointer' }} title="Refresh model list"
              >Refresh</button>
            </>
          )}
        </div>
      </div>
      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', marginTop: 2 }}>Model used for suggestions and chat.</div>
      {feedback && (
        <div style={{ marginTop: 6, fontSize: 'var(--font-size-xs)', color: feedback.type === 'success' ? 'var(--accent)' : 'var(--error, #e5534b)' }}>
          {feedback.message}
        </div>
      )}
    </div>
  );
}

export default function SettingsPanel({ onSettingsChange }) {
  const [search, setSearch] = useState('');
  const [values, setValues] = useState(() => loadSettings());

  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [currentModel, setCurrentModel] = useState(null);
  const [modelFeedback, setModelFeedback] = useState(null);

  const fetchModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const res = await fetch(`${API}/ai/models`);
      const data = await res.json().catch(() => ({}));
      setModels(data.models || []);
    } catch (_) { setModels([]); }
    finally { setModelsLoading(false); }
  }, []);

  const fetchCurrentModel = useCallback(async () => {
    try {
      const res = await fetch(`${API}/ai/model/current`);
      const data = await res.json().catch(() => ({}));
      setCurrentModel(data.model || null);
    } catch (_) { setCurrentModel(null); }
  }, []);

  const handleModelFeedback = useCallback((newModel, feedback) => {
    if (feedback) {
      setModelFeedback(feedback);
      setTimeout(() => setModelFeedback(null), 4000);
      return;
    }
    if (newModel != null) {
      setCurrentModel(newModel);
      setModelFeedback({ type: 'success', message: `Model set to ${newModel}` });
      setTimeout(() => setModelFeedback(null), 4000);
    }
  }, []);

  useEffect(() => { fetchModels(); fetchCurrentModel(); }, [fetchModels, fetchCurrentModel]);

  const refreshModels = useCallback(() => { fetchModels(); fetchCurrentModel(); }, [fetchModels, fetchCurrentModel]);

  const update = useCallback((key, value) => {
    setValues(prev => {
      const next = { ...prev, [key]: value };
      saveSettings(next);
      // Notify parent about settings change
      if (onSettingsChange) onSettingsChange(next);
      return next;
    });
  }, [onSettingsChange]);

  // Notify parent on mount with initial settings
  useEffect(() => {
    if (onSettingsChange) onSettingsChange(values);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return SETTINGS_GROUPS;
    return SETTINGS_GROUPS.map(group => ({
      ...group,
      settings: group.settings.filter(s =>
        s.label.toLowerCase().includes(q) || (s.description && s.description.toLowerCase().includes(q))
      ),
    })).filter(g => g.settings.length > 0);
  }, [search]);

  return (
    <div className="file-explorer">
      <div className="sidebar-header">
        <span className="sidebar-title">SETTINGS</span>
      </div>
      <div className="search-inputs" style={{ padding: '0 12px 10px' }}>
        <div className="search-input-wrapper">
          <input className="search-input" placeholder="Search settings" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      </div>
      <div className="file-tree" style={{ padding: '8px 12px 16px' }}>
        {filteredGroups.map(group => (
          <div key={group.id} style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <VscSettingsGear size={14} style={{ color: 'var(--text-muted)' }} />
              <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.5px', textTransform: 'uppercase' }}>
                {group.label}
              </span>
            </div>
            {group.settings.map(setting =>
              setting.type === 'aiModelDropdown' ? (
                <AIModelRow key={setting.key} models={models} loading={modelsLoading}
                  currentModel={currentModel} feedback={modelFeedback}
                  onRefresh={refreshModels} onSelect={handleModelFeedback}
                />
              ) : (
                <SettingRow key={setting.key} setting={setting} value={values[setting.key]} onChange={v => update(setting.key, v)} />
              )
            )}
          </div>
        ))}
        {filteredGroups.length === 0 && (
          <div className="search-message">No settings match your search.</div>
        )}
      </div>
    </div>
  );
}
