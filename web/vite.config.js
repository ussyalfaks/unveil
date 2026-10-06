import { defineConfig } from 'vite';

export default defineConfig({
  define: { global: 'globalThis' },
  server: {
    // During `npm run dev`, send /api to the storage server (npm run server).
    proxy: { '/api': 'http://localhost:8787' },
  },
  build: { target: 'es2022' },
});
