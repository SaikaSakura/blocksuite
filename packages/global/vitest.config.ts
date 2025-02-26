import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@blocksuite/global': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/*.unit.ts'],
    testTimeout: 500,
  },
});
