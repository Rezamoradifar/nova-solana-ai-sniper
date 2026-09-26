import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served by the nginx image under /app/ (see apps/dashboard/Dockerfile and
// docker/nginx/nginx.conf); the bot opens it via MINIAPP_URL.
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3008,
  },
});
