/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // noVNC 1.7 (`@novnc/novnc/core/rfb.js`) probes WebCodecs with top-level
    // await, which needs the es2022 target baseline (default is es2020).
    target: 'es2022',
  },
  optimizeDeps: {
    esbuildOptions: {
      // Same es2022 baseline for dev-server dependency pre-bundling: noVNC's
      // top-level await crashes `vite dev` with the default es2020 target.
      target: 'es2022',
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8700',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
