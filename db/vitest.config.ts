import { defineConfig } from 'vitest/config';

export default defineConfig({
  // seed.test.ts imports API classes (field crypto, TOTP, LedgerService) to prove compatibility; they use Nest decorators.
  esbuild: { tsconfigRaw: { compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true } } },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
});
