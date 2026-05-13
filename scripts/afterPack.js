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
  // Only applies to macOS
  if (context.electronPlatformName !== 'darwin') return;

  const productName = context.packager.appInfo.productFilename;
  const appPath     = path.join(context.appOutDir, `${productName}.app`);

  if (!fs.existsSync(appPath)) {
    console.warn(`[afterPack] .app not found at expected path: ${appPath}`);
    return;
  }

  console.log(`[afterPack] Ad-hoc signing + quarantine removal: ${appPath}`);

  try {
    // 1. Strip quarantine and provenance xattrs that macOS applies to
    //    downloaded files.  If these are present at launch time Gatekeeper
    //    will hard-block the app even when ad-hoc signed.
    execSync(`xattr -cr "${appPath}"`, { stdio: 'pipe' });

    // 2. Remove any existing (possibly broken) signature first
    execSync(`codesign --remove-signature "${appPath}" 2>/dev/null || true`, { stdio: 'pipe' });

    // 3. Sign recursively — frameworks, helpers, and the main bundle.
    //    No --options runtime: that flag requires a real Apple certificate.
    //    Ad-hoc (-) signing with --deep is enough to lift the "damaged" error.
    execSync(
      `codesign --force --deep --sign - "${appPath}"`,
      { stdio: 'pipe' }
    );

    // 4. Verify the signature was applied
    execSync(`codesign --verify --deep --strict "${appPath}"`, { stdio: 'pipe' });

    console.log('[afterPack] Ad-hoc signing complete ✓');
  } catch (err) {
    // Log but don't abort the build — the app will still be created,
    // users just have the xattr workaround available.
    console.error('[afterPack] Signing/xattr step failed:', err.message);
    console.error('[afterPack] Build continues; users may see the "damaged" error.');
    console.error('[afterPack] Workaround: xattr -cr "/Applications/Nebula IDE.app"');
  }
};
