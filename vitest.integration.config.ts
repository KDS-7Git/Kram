import { defineConfig } from 'vitest/config';
import { aliases } from './vitest.config';
export default defineConfig({ resolve: { alias: aliases }, test: { include: ['tests/integration/**/*.test.ts'], setupFiles: ['tests/setup/integration-env.ts'], environment: 'node', testTimeout: 60000, hookTimeout: 120000, fileParallelism: false } });
