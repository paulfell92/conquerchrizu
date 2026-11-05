import { defineConfig } from 'vitest/config';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Single-file build: dist/index.html contains everything, so the game can be
// published as one page and opened on any phone.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: { target: 'es2020', assetsInlineLimit: 100_000_000 },
  test: { include: ['tests/**/*.test.ts'] },
});
