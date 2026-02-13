import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.nebula.companion',
  appName: 'Nebula Companion',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: true,          // Allow HTTP for local network
  },
  android: {
    allowMixedContent: true,  // Allow WS + HTTP on local network
  },
  plugins: {
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0D0D12',
    },
  },
};

export default config;
