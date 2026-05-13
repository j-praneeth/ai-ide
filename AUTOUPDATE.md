# Nebula IDE — Auto-Update Pipeline

## How It Works End-to-End

```
Developer machine                GitHub Actions / CI
──────────────────               ─────────────────────────────────
npm run dist                 →   electron-builder packages the app
  └─ sets GH_TOKEN env var   →   publishes release to GitHub Releases
                                   └─ uploads: .exe (win), .dmg (mac)
                                   └─ uploads: latest.yml (win),
                                              latest-mac.yml (mac)

Running app (user's machine)
─────────────────────────────
1. On launch (after 8 s delay):
   autoUpdater.checkForUpdatesAndNotify()
   └─ downloads latest.yml / latest-mac.yml from GitHub Releases
   └─ compares remote version with current app version

2. If newer version found:
   → event: update-available  → renderer shows info (optional toast)
   → download starts automatically (autoDownload: true)
   → events: download-progress  → renderer shows progress bar in title bar

3. When download complete:
   → event: update-downloaded  → renderer shows "Restart to Update" button

4. User clicks "Restart to Update":
   → calls autoUpdater.quitAndInstall(false, true)
   → app quits, installer runs silently, app relaunches automatically
```

---

## Setup Steps

### 1. Create a GitHub Personal Access Token

```
GitHub → Settings → Developer settings → Personal access tokens (classic)
Scopes needed:  repo  (full control of private repos)
                     OR
               public_repo  (for public repos)
```

Save the token — you'll use it as `GH_TOKEN`.

---

### 2. Configure electron-builder (already done)

`package.json` "build" section already contains:

```json
"publish": {
  "provider": "github",
  "owner": "j-praneeth",
  "repo": "ai-ide",
  "releaseType": "release"
}
```

Change `owner` / `repo` to match your GitHub repository.

---

### 3. Build & Publish a Release

#### macOS
```bash
GH_TOKEN=your_token_here npm run dist -- --mac --publish always
```

#### Windows (cross-compile from macOS needs wine; build on Windows instead)
```bash
set GH_TOKEN=your_token_here
npm run dist -- --win --publish always
```

#### Both platforms
```bash
GH_TOKEN=your_token_here npm run dist -- --publish always
```

`--publish always` uploads the artifacts to a GitHub Draft Release automatically.

After the command completes:
- Go to **GitHub → Releases**
- You'll see a Draft release with `Nebula.IDE.Setup.x.x.x.exe`, `Nebula.IDE-x.x.x.dmg`, `latest.yml`, `latest-mac.yml`
- Click **Publish release** to make it live

---

### 4. Deliver the Initial Installer to Users

Users download the installer **once** from the GitHub Releases page (or your landing page):

| Platform | File |
|----------|------|
| Windows  | `Nebula IDE Setup x.x.x.exe` (NSIS installer) |
| macOS    | `Nebula IDE-x.x.x.dmg` (drag-to-Applications) |

After that first install, **all future updates are delivered automatically**.

---

### 5. Publish Future Updates

1. Bump the version in `package.json` (root):
   ```json
   "version": "1.1.0"
   ```
2. Build and publish:
   ```bash
   GH_TOKEN=your_token npm run dist -- --publish always
   ```
3. Publish the GitHub Draft Release → users get the update within minutes of their next app launch.

---

## What Files Are Generated

| File | Purpose |
|------|---------|
| `release/Nebula IDE Setup x.x.x.exe` | Windows NSIS installer (distribute to users) |
| `release/Nebula IDE-x.x.x.dmg` | macOS disk image (distribute to users) |
| `release/latest.yml` | Windows update manifest (read by electron-updater) |
| `release/latest-mac.yml` | macOS update manifest (read by electron-updater) |
| `release/builder-effective-config.yaml` | Debug build config |

---

## How the "Restart to Update" Button Works

1. `electron-updater` fires `update-downloaded` event in main process  
2. Main sends IPC `update:downloaded` to renderer  
3. `App.js` sets `updateState = 'ready'` → renders the green banner  
4. User clicks **"Restart to Update"**  
5. Renderer calls `window.electronAPI.updates.restartAndInstall()`  
6. Main calls `autoUpdater.quitAndInstall(false, true)`:
   - `false` = don't close all windows before install (handled internally)
   - `true` = force install immediately  
7. On **Windows**: NSIS silent installer runs (`/S` flag), replaces app, relaunches  
8. On **macOS**: `electron-updater` replaces `.app` bundle, relaunches

The whole process takes ~3-5 seconds. Users never see a browser or manual install step.

---

## macOS Code Signing (for production)

Without code signing, macOS shows a Gatekeeper warning.  
For a signed build:

```json
// package.json "mac" section
"mac": {
  "hardenedRuntime": true,
  "gatekeeperAssess": false,
  "entitlements": "assets/entitlements.mac.plist",
  "entitlementsInherit": "assets/entitlements.mac.plist",
  "identity": "Developer ID Application: Your Name (TEAMID)"
}
```

Set env vars before building:
```bash
CSC_LINK=/path/to/certificate.p12
CSC_KEY_PASSWORD=your_p12_password
APPLE_ID=your@appleid.com
APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
APPLE_TEAM_ID=YOURTEAMID
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `electron-updater` not found at runtime | Run `npm install` at project root (it's in `dependencies`) |
| Updates not found | Check that `latest.yml` / `latest-mac.yml` are in the GitHub Release |
| `GH_TOKEN` 401 errors | Token needs `repo` scope; check token is not expired |
| macOS: "app is damaged" | App needs code signing + notarization for public distribution |
| Windows: SmartScreen warning | Normal for unsigned apps; users click "More info → Run anyway" |
| Version not incrementing | Bump `"version"` in root `package.json` before building |
