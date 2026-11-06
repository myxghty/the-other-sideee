import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In mock mode (default) the app never calls a server.
// When VITE_USE_MOCK=false, /api calls go to your backend (FastAPI on :8000 by default).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_PROXY_TARGET || 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
});
