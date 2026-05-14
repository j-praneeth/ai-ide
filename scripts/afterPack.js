/**
 * afterPack.js — electron-builder afterPack hook
 *
 * Runs immediately after the app is packed but BEFORE the DMG/installer is
 * created, so the signature is baked into the DMG that users download.
 *
 * WHY THIS EXISTS
 * ───────────────
 * macOS Catalina 10.15+ refuses to open apps that are BOTH:
 *   (a) completely unsigned, AND
 *   (b) carry the com.apple.quarantine xattr (set automatically on any file
 *       downloaded from the internet).
 *
 * The result is the hard-blocked "is damaged and can't be opened" dialog —
 * no "Open Anyway" button, no workaround except the terminal xattr command.
 *
 * Ad-hoc signing (`codesign --sign -`) creates a local self-signed signature
 * that satisfies macOS's minimum requirement.  The app still shows the
 * "unidentified developer" Gatekeeper warning on first launch, but that
 * dialog HAS an "Open Anyway" button users can click.
 *
 * This requires NO Apple Developer account and NO certificate.
 *
 * WHAT IT DOES
 * ────────────
 *   macOS builds  → codesign --force --deep --sign -  (ad-hoc)
 *   Windows builds → no-op (SmartScreen handles unsigned .exe differently)
 *   Linux builds   → no-op
 */

'use strict';

const { execSync }  = require('child_process');
const path          = require('path');
const fs            = require('fs');

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const productName = context.packager.appInfo.productFilename;

  // ── Determine resources directory per-platform ────────────────────
  let resourcesDir;
  if (platform === 'darwin') {
    const appPath = path.join(context.appOutDir, `${productName}.app`);
    if (!fs.existsSync(appPath)) {
      console.warn(`[afterPack] .app not found at: ${appPath}`);
      return;
    }
    resourcesDir = path.join(appPath, 'Contents', 'Resources');
  } else {
    // Windows / Linux flat layout
    resourcesDir = path.join(context.appOutDir, 'resources');
    if (!fs.existsSync(resourcesDir)) {
      fs.mkdirSync(resourcesDir, { recursive: true });
    }
  }

  // ── Embed GH_TOKEN (ALL platforms) ────────────────────────────────
  // electron-updater needs a token to authenticate with the private
  // GitHub repo at runtime.  The token is stripped from builds that
  // run without GH_TOKEN.
  const ghToken = process.env.GH_TOKEN || process.env.GH_REPO_TOKEN || '';
  if (ghToken) {
    try {
      const cfg = { githubToken: ghToken };
      fs.writeFileSync(path.join(resourcesDir, 'update-config.json'), JSON.stringify(cfg), 'utf-8');
      console.log('[afterPack] update-config.json written (GH_TOKEN embedded) ✓');
    } catch (e) {
      console.warn('[afterPack] failed to write update-config.json:', e.message);
    }
  } else {
    console.log('[afterPack] GH_TOKEN not set — update-config.json not written (public repo only)');
  }

  // ── Ad-hoc signing (macOS only) ───────────────────────────────────
  // Without ANY signature, ditto fails with "Couldn't read PKZip Signature"
  // when extracting from DMG.  Ad-hoc signing (+ the one-time xattr command)
  // is the minimum needed for Gatekeeper to show "Open Anyway".
  if (platform === 'darwin') {
    const appPath = path.join(context.appOutDir, `${productName}.app`);
    try {
      execSync(`codesign --remove-signature "${appPath}" 2>/dev/null || true`, { stdio: 'pipe' });
      execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'pipe' });
      execSync(`codesign --verify --deep --strict "${appPath}"`, { stdio: 'pipe' });
      console.log('[afterPack] Ad-hoc signing complete ✓');
    } catch (err) {
      console.warn('[afterPack] codesign failed (build continues):', err.message);
    }
  }
};
