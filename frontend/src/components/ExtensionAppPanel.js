import React, { useState, useEffect, useRef } from 'react';
import { VscExtensions, VscLinkExternal, VscRefresh, VscClose, VscChevronDown, VscChevronRight } from 'react-icons/vsc';
import { extensionRegistry } from '../lib/extensionRegistry';

/**
 * Renders the sidebar panel for an installed extension.
 *
 * For extensions whose vsix has been extracted by the Electron host, we load
 * the extension's webview HTML inside an <iframe> with a VS Code API shim
 * injected via postMessage handshake. For all other extensions (or in browser
 * mode) we show a rich info / settings panel.
 */
export default function ExtensionAppPanel({ extensionId, onClose }) {
  const ext = extensionRegistry.find(extensionId);
  const [webviewUrl, setWebviewUrl] = useState(null);
  const [webviewReady, setWebviewReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const iframeRef = useRef(null);
  const stateKey = `nebula_ext_state_${extensionId}`;

  // Ask Electron host for the extracted webview URL
  useEffect(() => {
    setWebviewUrl(null);
    setWebviewReady(false);
    setLoadError('');
    if (!ext) return;
    if (window.electronAPI?.extensions?.getWebviewUrl) {
      window.electronAPI.extensions.getWebviewUrl(extensionId)
        .then(url => { if (url) setWebviewUrl(url); })
        .catch(() => {});
    }
  }, [extensionId, ext]);

  // Inject VS Code API shim once the iframe loads
  useEffect(() => {
    if (!webviewUrl) return;
    const frame = iframeRef.current;
    if (!frame) return;

    const onLoad = () => {
      try {
        const savedState = (() => { try { return JSON.parse(localStorage.getItem(stateKey) || 'null'); } catch { return null; } })();
        const shim = `
          (function() {
            let _state = ${JSON.stringify(savedState)};
            window.acquireVsCodeApi = function() {
              return {
                postMessage: function(msg) {
                  window.parent.postMessage({ __nebulaExtMsg: true, extId: "${extensionId}", payload: msg }, '*');
                },
                setState: function(s) {
                  _state = s;
                  window.parent.postMessage({ __nebulaExtState: true, extId: "${extensionId}", state: s }, '*');
                },
                getState: function() { return _state; },
              };
            };
            window.__nebula_ready = true;
          })();
        `;
        frame.contentWindow.eval(shim);
        setWebviewReady(true);
      } catch (_) {
        setWebviewReady(true); // still show even if shim fails (e.g. cross-origin)
      }
    };
    frame.addEventListener('load', onLoad);
    return () => frame.removeEventListener('load', onLoad);
  }, [webviewUrl, extensionId, stateKey]);

  // Handle messages back from the extension webview
  useEffect(() => {
    const handler = (ev) => {
      if (!ev.data) return;
      if (ev.data.__nebulaExtState && ev.data.extId === extensionId) {
        try { localStorage.setItem(stateKey, JSON.stringify(ev.data.state)); } catch (_) {}
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [extensionId, stateKey]);

  if (!ext) {
    return (
      <div className="ext-app-panel">
        <div className="search-message">Extension not found.</div>
      </div>
    );
  }

  const openMarketplace = () => {
    const url = ext.marketplaceUrl || `https://marketplace.visualstudio.com/items?itemName=${ext.publisherId || ext.publisher}.${ext.name}`;
    if (window.electronAPI?.openExternal) window.electronAPI.openExternal(url);
    else window.open(url, '_blank', 'noopener');
  };

  return (
    <div className="ext-app-panel">
      {/* Header */}
      <div className="ext-app-header">
        <div className="ext-app-icon">
          {ext.iconUrl
            ? <img src={ext.iconUrl} alt="" onError={e => { e.target.style.display = 'none'; }} />
            : <VscExtensions size={28} style={{ color: 'var(--accent)' }} />}
        </div>
        <div className="ext-app-meta">
          <div className="ext-app-title">{ext.displayName || ext.name}</div>
          <div className="ext-app-sub">{ext.publisher} · v{ext.version}</div>
        </div>
        {typeof onClose === 'function' && (
          <button className="icon-btn" onClick={onClose} title="Close panel"><VscClose size={14} /></button>
        )}
      </div>

      {/* Webview (Electron only, after vsix extraction) */}
      {webviewUrl ? (
        <div className="ext-webview-wrap">
          {!webviewReady && (
            <div className="ext-loading" style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)' }}>
              <VscRefresh size={16} className="spin" /> Loading…
            </div>
          )}
          <iframe
            ref={iframeRef}
            src={webviewUrl}
            title={`Extension: ${ext.displayName || ext.name}`}
            className="ext-webview-frame"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            onError={() => setLoadError('Failed to load extension webview.')}
          />
        </div>
      ) : (
        /* Info panel for web mode or extensions without webview */
        <div className="ext-app-body">
          {loadError && <div className="ext-error">{loadError}</div>}

          <div className="ext-app-desc">{ext.description}</div>

          {/* Action buttons */}
          <div className="ext-app-actions">
            <button className="ext-app-link-btn" onClick={openMarketplace}>
              <VscLinkExternal size={12} /> View on Marketplace
            </button>
            {!window.electronAPI && (
              <div className="ext-app-note">
                ⚡ Full webview execution requires the Nebula desktop app.
                Download it from the menu to run this extension natively.
              </div>
            )}
            {window.electronAPI && (
              <div className="ext-app-note">
                Extension installed. Restart Nebula IDE to fully activate language features and commands.
              </div>
            )}
          </div>

          {/* Collapsible details */}
          <button className="ext-app-section-hdr" onClick={() => setShowDetails(p => !p)}>
            {showDetails ? <VscChevronDown size={12} /> : <VscChevronRight size={12} />}
            Extension Details
          </button>
          {showDetails && (
            <div className="ext-app-details">
              <div className="ext-app-detail-row">
                <span>ID</span><span>{ext.id}</span>
              </div>
              <div className="ext-app-detail-row">
                <span>Publisher</span><span>{ext.publisher}</span>
              </div>
              <div className="ext-app-detail-row">
                <span>Version</span><span>{ext.version}</span>
              </div>
              {ext.installs > 0 && (
                <div className="ext-app-detail-row">
                  <span>Downloads</span><span>{ext.installs?.toLocaleString()}</span>
                </div>
              )}
              {ext.lastUpdated && (
                <div className="ext-app-detail-row">
                  <span>Updated</span>
                  <span>{new Date(ext.lastUpdated).toLocaleDateString()}</span>
                </div>
              )}
              {(ext.categories || []).length > 0 && (
                <div className="ext-app-detail-row">
                  <span>Category</span><span>{ext.categories.join(', ')}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
