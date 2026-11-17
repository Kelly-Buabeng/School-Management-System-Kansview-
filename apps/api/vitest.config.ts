import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC so NestJS decorator metadata works in tests.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    projects: [
      { extends: true, test: { name: 'unit', include: ['src/**/*.spec.ts'] } },
      { extends: true, test: { name: 'integration', include: ['src/**/*.int-spec.ts', 'test/**/*.int-spec.ts'], testTimeout: 30000, hookTimeout: 60000 } },
    ],
  },
});
