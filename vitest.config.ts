import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { globalSetup: ['tests/global-setup.ts'], include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 30000 },
});
