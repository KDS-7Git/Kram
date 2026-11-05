import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { execFileSync } from 'node:child_process';
import { devNull } from 'node:os';
import { performance } from 'node:perf_hooks';
import { v7 as uuid } from 'uuid';
import type { PrismaClient } from '@prisma/client';
import { defaultSettings } from '@kram/shared';

let container: StartedTestContainer, db: PrismaClient, userId: string, skillId: string;
let clock: { now: () => string }, originalNow: () => string;
let goals: typeof import('../../apps/api/src/modules/goals/service').goals;
let materialize: typeof import('../../apps/api/src/modules/tasks/materialization').materializeTasks;

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-bookworm')
    .withEnvironment({ POSTGRES_USER: 'kram', POSTGRES_PASSWORD: 'scale-disposable-only', POSTGRES_DB: 'kram' }).withExposedPorts(5432)
    .withHealthCheck({ test: ['CMD-SHELL', 'pg_isready -U kram -d kram'], interval: 1000, timeout: 3000, retries: 30, startPeriod: 1000 }).withWaitStrategy(Wait.forHealthCheck()).start();
  Object.assign(process.env, { DOTENV_CONFIG_PATH: devNull, DATABASE_URL: `postgresql://kram:scale-disposable-only@${container.getHost()}:${container.getMappedPort(5432)}/kram`, DATABASE_URL_FILE: '', NODE_ENV: 'test', SESSION_SECRET: 'scale-test-session-secret-at-least32', SESSION_SECRET_FILE: '', ENCRYPTION_KEY: '77'.repeat(32), ENCRYPTION_KEY_FILE: '', OWNER_SETUP_TOKEN_FILE: '', NTFY_BASE_URL: '', NTFY_TOPIC: '', NTFY_TOKEN: '', NTFY_TOKEN_FILE: '', LOG_LEVEL: 'silent' });
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'apps/api/prisma/schema.prisma'], { env: process.env, stdio: 'pipe' });
  ({ db } = await import('../../apps/api/src/db')); ({ goals } = await import('../../apps/api/src/modules/goals/service'));
  ({ materializeTasks: materialize } = await import('../../apps/api/src/modules/tasks/materialization'));
  ({ clock } = await import('../../apps/api/src/calendar')); originalNow = clock.now; clock.now = () => '2026-11-06T12:00:00Z';
  const settings = { ...defaultSettings, timezone: 'UTC', dayRollover: 0 };
  const owner = await db.user.create({ data: { id: uuid(), email: 'scale-owner@kram.test', passwordHash: 'synthetic-unused-hash', settings, timezone: 'UTC', dayRollover: 0 } }); userId = owner.id;
  const profile = await db.profile.create({ data: { id: uuid(), userId, name: 'Synthetic scale profile' } });
  skillId = (await db.skill.create({ data: { id: uuid(), userId, profileId: profile.id, name: 'Synthetic scale skill' } })).id;
}, 120000);
afterAll(async () => { if (clock && originalNow) clock.now = originalNow; await db?.$disconnect(); await container?.stop(); });

describe('maximum supported source quota', () => {
  it('creates the fourteen-day maximum minute quota in the normal goal transaction and reruns without duplicate rows', async () => {
    const targetQty = 1000000, startedAt = performance.now();
    const goal = await goals.create(userId, { skillId, type: 'daily', title: 'Synthetic maximum minute quota', unit: 'minutes', targetQty, startDate: '2026-11-06', availableDays: [1, 2, 3, 4, 5, 6, 7] });
    const creationMs = performance.now() - startedAt;
    const rows = await db.task.findMany({ where: { goalId: goal.id }, select: { id: true, earliestDate: true, estMinutes: true, remainingMinutes: true, qty: true, materializationKey: true } });
    const chunksPerDay = Math.ceil(targetQty / 960);
    expect(rows).toHaveLength(14 * chunksPerDay); expect(new Set(rows.map(row => row.materializationKey)).size).toBe(rows.length);
    const days = new Map<string, typeof rows>();
    for (const row of rows) {
      const date = row.earliestDate.toISOString().slice(0, 10);
      days.set(date, [...(days.get(date) ?? []), row]);
      expect(row.estMinutes).toBeGreaterThan(0); expect(row.estMinutes).toBeLessThanOrEqual(960);
      expect(row.remainingMinutes).toBe(row.estMinutes);
    }
    expect(days.size).toBe(14);
    for (const day of days.values()) {
      expect(day).toHaveLength(chunksPerDay);
      expect(day.reduce((sum, row) => sum + row.estMinutes, 0)).toBe(targetQty);
      expect(day.reduce((sum, row) => sum + row.qty, 0)).toBeCloseTo(targetQty, 6);
    }
    const rerunAt = performance.now(); expect(await materialize(userId, '2026-11-06')).toMatchObject({ created: 0, updated: 0, archived: 0 });
    const rerunMs = performance.now() - rerunAt;
    expect(await db.task.count({ where: { goalId: goal.id } })).toBe(rows.length);
    console.info(`Maximum quota fixture: ${rows.length} tasks; create ${Math.round(creationMs)} ms; rerun ${Math.round(rerunMs)} ms on this PC.`);
  }, 60000);
});
