import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3008,
    // Requests arrive proxied through nginx with the public Host header
    // (see /etc/nginx/sites-available/miniapp.smartchainnetwork.online) —
    // Vite's default host check rejects any Host it doesn't recognize.
    allowedHosts: ['miniapp.smartchainnetwork.online'],
  },
});
