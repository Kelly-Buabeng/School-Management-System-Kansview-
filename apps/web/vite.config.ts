/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': r('./src'),
      // The shared kernel is published as CommonJS for the API; the web app compiles its ES source directly.
      '@sms/shared': r('../../packages/shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    // Real API mode: proxy same-origin /api/v1 to the API server during development.
    proxy: process.env.VITE_API_MODE === 'real' ? { '/api': process.env.SMS_API_ORIGIN ?? 'http://localhost:3000' } : undefined,
  },
  preview: { port: 4173 },
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 400,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-dom/client', 'react-router'],
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    testTimeout: 20000,
  },
});
