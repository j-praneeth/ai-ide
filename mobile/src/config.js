/**
 * Mobile App Configuration
 * -------------------------
 * Admin: Set RELAY_URL before building the app.
 * Users never see or change this.
 */

// The deployed relay server URL — set this before building the APK
export const RELAY_URL = import.meta.env.VITE_RELAY_URL || '';

// App version
export const APP_VERSION = '1.0.0';
