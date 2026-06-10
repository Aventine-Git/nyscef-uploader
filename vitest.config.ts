import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        globals: true,
        // Exclude the existing Playwright E2E specs
        exclude: ['tests/upload.spec.ts', 'tests/invoke.spec.ts', 'tests/queue.spec.ts', 'node_modules/**'],
    },
});
