import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export const aliases = Object.fromEntries(['shared', 'time', 'recurrence', 'timetable', 'scheduler', 'streaks'].map((name) => [`@kram/${name}`, resolve(`packages/${name === 'shared' ? name : `engine-${name}`}/src/index.ts`)]));
export default defineConfig({ resolve: { alias: aliases }, test: { include: ['packages/**/*.test.ts', 'apps/web/**/*.test.ts', 'tests/unit/**/*.test.ts'], environment: 'node', testTimeout: 10000 } });
