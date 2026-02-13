# Nebula Companion - Mobile App

A companion mobile app for Nebula IDE that lets you monitor, control, and interact with your desktop IDE from your phone.

## Features

- **QR Code Pairing** — Scan a QR code to instantly connect to your IDE
- **Live Activity Feed** — See real-time IDE activity (terminal, AI agent, file changes)
- **AI Chat** — Send prompts to the AI agent from your phone
- **Remote Terminal** — Run terminal commands remotely
- **File Browser** — Browse and read project files

## Prerequisites

- **Node.js** 18+
- **Android Studio** (for building APK)
- **Java 21** (`brew install openjdk@21` on macOS)
- **Android SDK** (installed via Android Studio)

## Quick Start

### Development (Web Browser)

```bash
cd mobile
npm install
npm run dev
```

Open `http://localhost:5173` in your phone's browser (same WiFi network).

### Build Android APK

```bash
cd mobile

# Build the web app + sync to Android
npm run build:android

# Build debug APK
JAVA_HOME=/opt/homebrew/opt/openjdk@21 \
ANDROID_HOME=~/Library/Android/sdk \
npm run build:apk
```

The APK will be at:
```
android/app/build/outputs/apk/debug/app-debug.apk
```

### Open in Android Studio

```bash
npm run android
```

## How to Connect

1. Start Nebula IDE on your desktop
2. Go to **Settings → Mobile Companion** in the IDE
3. Open the Nebula Companion app on your phone
4. Scan the QR code, or enter the IP:Port manually
5. Both devices must be on the **same WiFi network**

## Architecture

```
Phone (Capacitor WebView)
  ↕ WebSocket (ws://local-ip:port/mobile/ws)
Desktop (Nebula IDE Backend - FastAPI)
```

- **WebSocket** for real-time bidirectional communication
- **Event Bus** captures all IDE activity and broadcasts to mobile
- **Simple token auth** prevents unauthorized access
- No cloud server required — everything stays on your local network
