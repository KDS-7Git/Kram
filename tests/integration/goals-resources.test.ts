import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { execFileSync } from 'node:child_process';
import { devNull } from 'node:os';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import request, { type Agent, type Test } from 'supertest';
import { DateTime } from 'luxon';
import { v7 as uuid } from 'uuid';
import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { defaultSettings, goalTypes, resourceTypes, type Goal, type GoalRuleVersion, type Resource, type ResourceItem } from '@kram/shared';
import { studyDate } from '@kram/time';

const origin = 'http://localhost:8420';
const today = studyDate(DateTime.utc().toISO()!, 'Asia/Kolkata', 240);
const tomorrow = DateTime.fromISO(today).plus({ days: 1 }).toISODate()!;
const yesterday = DateTime.fromISO(today).minus({ days: 1 }).toISODate()!;
const deadline = DateTime.fromISO(today).plus({ days: 30 }).toISODate()!;
let container: StartedTestContainer, db: PrismaClient, app: Express, agent: Agent, server: Server;
let csrf = '', ownerId = '', skillId = '', foreignSkillId = '', foreignOwnerId = '';
let foreignGoalId = '', foreignResourceId = '', foreignItemId = '';

function mutation(method: 'post' | 'patch', path: string, body: Record<string, unknown> = {}): Test {
  return (method === 'post' ? agent.post(path) : agent.patch(path)).set('Origin', origin).set('X-CSRF-Token', csrf).send(body);
}
const get = (path: string) => agent.get(`/api/v1${path}`);
const post = (path: string, body: Record<string, unknown> = {}) => mutation('post', `/api/v1${path}`, body);
const patch = (path: string, body: Record<string, unknown> = {}) => mutation('patch', `/api/v1${path}`, body);

async function makeGoal(fields: Record<string, unknown> = {}): Promise<Goal> {
  const response = await post('/goals', { skillId, type: 'daily', title: 'Synthetic reading goal', targetQty: 30, unit: 'minutes', startDate: today, dueDate: deadline, ...fields }).expect(201);
  return response.body as Goal;
}
async function makeResource(fields: Record<string, unknown> = {}): Promise<Resource> {
  return (await post('/resources', { skillId, type: 'course', title: 'Synthetic course', ...fields }).expect(201)).body as Resource;
}
async function makeItem(resourceId: string, fields: Record<string, unknown> = {}): Promise<ResourceItem> {
  return (await post(`/resources/${resourceId}/items`, { title: 'Synthetic lesson', estMinutes: 30, ...fields }).expect(201)).body as ResourceItem;
}
function expectRejected(status: number) { expect([400, 409]).toContain(status); }

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-bookworm')
    .withEnvironment({ POSTGRES_USER: 'kram', POSTGRES_PASSWORD: 'goals-disposable-test', POSTGRES_DB: 'kram' })
    .withExposedPorts(5432)
    .withHealthCheck({ test: ['CMD-SHELL', 'pg_isready -U kram -d kram'], interval: 1000, timeout: 3000, retries: 30, startPeriod: 1000 })
    .withWaitStrategy(Wait.forHealthCheck()).start();
  const url = `postgresql://kram:goals-disposable-test@${container.getHost()}:${container.getMappedPort(5432)}/kram`;
  Object.assign(process.env, { DOTENV_CONFIG_PATH: devNull, DATABASE_URL: url, DATABASE_URL_FILE: '', NODE_ENV: 'test', APP_URL: origin,
    COOKIE_SECURE: 'false', DEFAULT_TIMEZONE: 'Asia/Kolkata', SESSION_SECRET: 'goals-resource-session-test-key-at-least32', SESSION_SECRET_FILE: '',
    ENCRYPTION_KEY: '33'.repeat(32), ENCRYPTION_KEY_FILE: '', OWNER_SETUP_TOKEN: '', OWNER_SETUP_TOKEN_FILE: '', LOG_LEVEL: 'silent' });
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'apps/api/prisma/schema.prisma'], { env: process.env, stdio: 'pipe' });
  ({ db } = await import('../../apps/api/src/db'));
  const { createApp } = await import('../../apps/api/src/app'); app = createApp();
  server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  agent = request.agent(server);
  csrf = (await get('/auth/me').expect(200)).body.csrfToken;
  const setup = await post('/auth/setup', { email: 'goals-owner@kram.test', password: 'synthetic-goal-owner-password-42', timezone: 'Asia/Kolkata' }).expect(201);
  csrf = setup.body.csrfToken; ownerId = setup.body.user.id;
  const profile = await post('/profiles', { name: 'Synthetic goals profile' }).expect(201);
  skillId = (await post('/skills', { profileId: profile.body.id, name: 'Synthetic resource skill' }).expect(201)).body.id;
  const foreign = await db.user.create({ data: { id: uuid(), email: 'foreign-goals@kram.test', passwordHash: 'fixture-only', settings: defaultSettings, isOwner: false } });
  foreignOwnerId = foreign.id;
  const foreignProfile = await db.profile.create({ data: { id: uuid(), userId: foreign.id, name: 'Foreign fixture profile' } });
  const foreignSkill = await db.skill.create({ data: { id: uuid(), userId: foreign.id, profileId: foreignProfile.id, name: 'Foreign fixture skill' } });
  foreignSkillId = foreignSkill.id;
  const foreignGoal = await db.goal.create({ data: { id: uuid(), userId: foreign.id, skillId: foreignSkill.id, type: 'daily', title: 'Foreign fixture goal', targetQty: 30, startDate: new Date(`${today}T00:00:00Z`) } });
  foreignGoalId = foreignGoal.id;
  const foreignResource = await db.resource.create({ data: { id: uuid(), userId: foreign.id, skillId: foreignSkill.id, type: 'book', title: 'Foreign fixture resource' } });
  foreignResourceId = foreignResource.id;
  const foreignItem = await db.resourceItem.create({ data: { id: uuid(), userId: foreign.id, resourceId: foreignResource.id, title: 'Foreign fixture item', estMinutes: 30 } });
  foreignItemId = foreignItem.id;
}, 120000);

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolveDone, reject) => server.close(error => error ? reject(error) : resolveDone()));
  const closeSessions: unknown = app?.locals.closeSessions;
  if (typeof closeSessions === 'function') await closeSessions();
  await db?.$disconnect(); await container?.stop();
});

describe('goals and resource persistence', () => {
  it('protects goals, rules, resources and items before resolving IDs', async () => {
    for (const path of ['/goals', `/goals/${foreignGoalId}/rules`, '/resources', `/resources/${foreignResourceId}/items`]) {
      const response = await request(app).get(`/api/v1${path}`); expect(response.status).toBe(401);
    }
  });

  it('saves all five goal types with explicit units, calendar dates and zero actual progress', async () => {
    const units = ['minutes', 'questions', 'pages', 'videos', 'percent'];
    for (const [index, type] of goalTypes.entries()) {
      const goal = await makeGoal({ type, title: `${type} goal`, unit: units[index], targetQty: type === 'milestone' ? 100 : 30,
        rrule: type === 'recurring' ? 'FREQ=DAILY;INTERVAL=2' : null, availableDays: [2, 4, 7], usePriority: 'off', priority: null });
      expect(goal).toMatchObject({ type, unit: units[index], startDate: today, dueDate: deadline, status: 'active', ruleVersion: 1, progressQty: 0, progressMinutes: 0, availableDays: [2, 4, 7], usePriority: 'off', priority: null });
      expect(goal.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const persisted = await db.goal.findUniqueOrThrow({ where: { id: goal.id } });
      expect(persisted.userId).toBe(ownerId); expect(persisted.unit).toBe(units[index]);
      expect((await get(`/goals/${goal.id}`).expect(200)).body).toMatchObject({ id: goal.id, title: `${type} goal` });
    }
    const listed = (await get(`/goals?skillId=${skillId}`).expect(200)).body as Goal[];
    expect(new Set(listed.map(goal => goal.type))).toEqual(new Set(goalTypes));
  });

  it('rejects invalid targets, units, dates and recurring rules without storing a goal', async () => {
    const before = await db.goal.count({ where: { userId: ownerId } });
    for (const fields of [{ targetQty: 0 }, { targetQty: -1 }, { unit: ' ' }, { unit: 'percent', targetQty: 101 },
      { startDate: '2026-02-30' }, { dueDate: yesterday }, { type: 'recurring', rrule: null }, { type: 'recurring', rrule: 'FREQ=NOT-A-FREQUENCY' }]) {
      const result = await post('/goals', { skillId, type: 'daily', title: 'Rejected fixture goal', targetQty: 30, startDate: today, ...fields });
      expect(result.status).toBe(400); expect(result.body.error.code).toBe('VALIDATION_FAILED');
    }
    expect(await db.goal.count({ where: { userId: ownerId } })).toBe(before);
  });

  it('appends immutable effective-dated rule snapshots while preserving earlier criteria', async () => {
    const goal = await makeGoal({ title: 'Versioned goal', targetQty: 20 });
    const original = (await get(`/goals/${goal.id}/rules`).expect(200)).body as GoalRuleVersion[];
    expect(original).toHaveLength(1); expect(original[0]).toMatchObject({ version: 1, rules: { title: 'Versioned goal', targetQty: 20 } });
    const changed = await patch(`/goals/${goal.id}`, { targetQty: 45, effectiveFrom: tomorrow }).expect(200);
    expect(changed.body).toMatchObject({ id: goal.id, targetQty: 45, ruleVersion: 2 });
    const snapshots = (await get(`/goals/${goal.id}/rules`).expect(200)).body as GoalRuleVersion[];
    expect(snapshots).toHaveLength(2); expect(snapshots[0]).toEqual(original[0]);
    expect(snapshots[1]).toMatchObject({ version: 2, effectiveFrom: tomorrow, rules: { targetQty: 45, unit: 'minutes' } });
    await expect(db.goalRuleVersion.update({ where: { id: snapshots[0]!.id }, data: { rules: { targetQty: 999 } } })).rejects.toThrow('Append-only');
    await expect(db.goalRuleVersion.delete({ where: { id: snapshots[0]!.id } })).rejects.toThrow('Append-only');
  });

  it('rejects retroactive and invalid edits atomically, including their rule versions', async () => {
    const goal = await makeGoal({ title: 'Unchanged version fixture', targetQty: 25 });
    for (const fields of [{ targetQty: 15, effectiveFrom: yesterday }, { targetQty: -1, effectiveFrom: tomorrow }, { dueDate: yesterday }]) {
      const result = await patch(`/goals/${goal.id}`, fields); expectRejected(result.status);
    }
    expect((await get(`/goals/${goal.id}`).expect(200)).body).toMatchObject({ title: goal.title, targetQty: 25, dueDate: deadline, ruleVersion: 1 });
    expect(await db.goalRuleVersion.count({ where: { goalId: goal.id } })).toBe(1);
  });

  it('serializes concurrent goal edits into distinct rule versions without losing fields', async () => {
    const goal = await makeGoal({ title: 'Concurrent rule fixture', targetQty: 20 });
    const edits = await Promise.all([patch(`/goals/${goal.id}`, { title: 'Concurrent saved title', effectiveFrom: tomorrow }),
      patch(`/goals/${goal.id}`, { targetQty: 40, effectiveFrom: tomorrow })]);
    expect(edits.map(response => response.status)).toEqual([200, 200]);
    expect((await get(`/goals/${goal.id}`).expect(200)).body).toMatchObject({ title: 'Concurrent saved title', targetQty: 40, ruleVersion: 3 });
    const rules = (await get(`/goals/${goal.id}/rules`).expect(200)).body as GoalRuleVersion[];
    expect(rules.map(rule => rule.version)).toEqual([1, 2, 3]);
    expect(rules[0]?.rules).toMatchObject({ title: 'Concurrent rule fixture', targetQty: 20 });
    expect(rules[2]?.rules).toMatchObject({ title: 'Concurrent saved title', targetQty: 40 });
    await patch(`/goals/${goal.id}`, { title: 'Concurrent saved title' }).expect(200);
    expect(await db.goalRuleVersion.count({ where: { goalId: goal.id } })).toBe(3);
  });

  it('pauses, resumes and archives a goal without deleting its configuration or rules', async () => {
    const goal = await makeGoal({ title: 'Pause/resume fixture', type: 'recurring', rrule: 'FREQ=DAILY;INTERVAL=2' });
    const rules = (await get(`/goals/${goal.id}/rules`).expect(200)).body;
    expect((await post(`/goals/${goal.id}/pause`).expect(200)).body.status).toBe('paused');
    expect((await post(`/goals/${goal.id}/resume`).expect(200)).body).toMatchObject({ status: 'active', startDate: today, rrule: 'FREQ=DAILY;INTERVAL=2' });
    expect((await get(`/goals/${goal.id}/rules`).expect(200)).body).toEqual(rules);
    expect((await post(`/goals/${goal.id}/archive`).expect(200)).body.status).toBe('archived');
    expect((await db.goal.findUniqueOrThrow({ where: { id: goal.id } })).archivedAt).not.toBeNull();
    expect(await db.goalRuleVersion.count({ where: { goalId: goal.id } })).toBe(1);
    expect(((await get('/goals').expect(200)).body as Goal[]).some(row => row.id === goal.id)).toBe(false);
    expect(((await get('/goals?archived=true').expect(200)).body as Goal[]).some(row => row.id === goal.id)).toBe(true);
    for (const action of ['resume', 'pause']) {
      const rejected = await post(`/goals/${goal.id}/${action}`); expect(rejected.status).toBe(409); expect(rejected.body.error.code).toBe('GOAL_ARCHIVED');
    }
    expect((await db.goal.findUniqueOrThrow({ where: { id: goal.id } })).status).toBe('archived');
  });

  it('persists all resource types and shares one resource across several owned goals', async () => {
    const first = await makeGoal({ title: 'First linked goal' }), second = await makeGoal({ title: 'Second linked goal' });
    for (const type of resourceTypes) {
      const resource = await makeResource({ type, title: `${type} resource`, goalId: first.id, goalIds: [first.id, second.id], url: 'https://example.test/material', notesRef: 'synthetic notes' });
      expect(resource).toMatchObject({ type, goalId: first.id, url: 'https://example.test/material' });
      expect(new Set(resource.goalIds)).toEqual(new Set([first.id, second.id]));
      const fetched = (await get(`/resources/${resource.id}`).expect(200)).body as Resource;
      expect(fetched.goalIds).toEqual(expect.arrayContaining([first.id, second.id]));
      expect(await db.goalResource.count({ where: { resourceId: resource.id } })).toBe(2);
      const edited = await patch(`/resources/${resource.id}`, { title: 'Edited material', goalId: null, goalIds: [second.id] }).expect(200);
      expect(edited.body).toMatchObject({ title: 'Edited material', goalId: second.id, goalIds: [second.id] });
      expect(await db.goalResource.count({ where: { resourceId: resource.id } })).toBe(1);
      const unlinked = await patch(`/resources/${resource.id}`, { goalId: null, goalIds: [] }).expect(200);
      expect(unlinked.body).toMatchObject({ goalId: null, goalIds: [] });
      expect(await db.goalResource.count({ where: { resourceId: resource.id } })).toBe(0);
    }
  });

  it('saves typed book pages, video duration and ordered tree relationships', async () => {
    const book = await makeResource({ type: 'book' });
    const chapter = await makeItem(book.id, { title: 'Chapter', kind: 'chapter', estMinutes: 0 });
    const reading = await makeItem(book.id, { title: 'Read pages', kind: 'reading', parentItemId: chapter.id, pagesFrom: 4, pagesTo: 28, qty: 25, ordinal: 1, estMinutes: 45 });
    expect(reading).toMatchObject({ parentItemId: chapter.id, pagesFrom: 4, pagesTo: 28, qty: 25, estMinutes: 45 });
    const video = await makeItem(book.id, { title: 'Watch explanation', kind: 'video', parentItemId: chapter.id, durationMin: 35, estMinutes: 40, ordinal: 2 });
    expect(video).toMatchObject({ durationMin: 35, estMinutes: 40, ordinal: 2 });
    const edited = (await patch(`/resource-items/${reading.id}`, { pagesTo: 30, qty: 27, estMinutes: 50 }).expect(200)).body as ResourceItem;
    expect(edited).toMatchObject({ pagesFrom: 4, pagesTo: 30, qty: 27, estMinutes: 50 });
    const tree = (await get(`/resources/${book.id}/items`).expect(200)).body as ResourceItem[];
    expect(tree.map(item => item.id)).toEqual(expect.arrayContaining([chapter.id, reading.id, video.id]));
  });

  it('rejects invalid page pairs, empty work estimates and unsafe material URLs before writes', async () => {
    const resource = await makeResource(); const before = await db.resourceItem.count({ where: { resourceId: resource.id } });
    for (const fields of [{ pagesFrom: 10 }, { pagesFrom: 10, pagesTo: 2 }, { pagesFrom: 0, pagesTo: 5 }, { kind: 'video', estMinutes: 0 }, { durationMin: -1 }, { url: 'javascript:alert(1)' }]) {
      const result = await post(`/resources/${resource.id}/items`, { title: 'Rejected material item', estMinutes: 30, ...fields }); expect(result.status).toBe(400);
    }
    expect(await db.resourceItem.count({ where: { resourceId: resource.id } })).toBe(before);
    expect((await post('/resources', { skillId, type: 'course', title: 'Unsafe resource', url: 'file:///private/path' })).status).toBe(400);
  });

  it('imports an indented outline into a stable tree with explicit and default estimates', async () => {
    const resource = await makeResource({ title: 'Outline fixture' });
    const response = await post(`/resources/${resource.id}/import-outline`, { outline: 'Chapter One\n  Lesson One [35m]\n  Section\n    Practice [45m]\nChapter Two\n  Revision', defaultMinutes: 30 }).expect(201);
    const imported = response.body as { imported: number; items: ResourceItem[] };
    expect(imported.imported).toBe(6); expect(imported.items).toHaveLength(6);
    const named = new Map(imported.items.map(item => [item.title, item]));
    expect(named.get('Lesson One')).toMatchObject({ parentItemId: named.get('Chapter One')?.id, estMinutes: 35 });
    expect(named.get('Section')).toMatchObject({ parentItemId: named.get('Chapter One')?.id });
    expect(named.get('Practice')).toMatchObject({ parentItemId: named.get('Section')?.id, estMinutes: 45 });
    expect(named.get('Revision')).toMatchObject({ parentItemId: named.get('Chapter Two')?.id, estMinutes: 30 });
    expect(named.get('Chapter One')?.parentItemId).toBeNull(); expect(named.get('Chapter Two')?.parentItemId).toBeNull();
    expect(await db.resourceItem.count({ where: { resourceId: resource.id } })).toBe(6);
    expect((await get(`/resources/${resource.id}/items`).expect(200)).body).toHaveLength(6);
  });

  it('rolls back the whole outline when a later leaf is invalid', async () => {
    const resource = await makeResource({ title: 'Atomic import fixture' }); await makeItem(resource.id, { title: 'Existing item' });
    const before = await db.resourceItem.count({ where: { resourceId: resource.id } });
    const invalid = await post(`/resources/${resource.id}/import-outline`, { outline: 'Chapter\n  Valid leaf [25m]\n  Invalid leaf [0m]', defaultMinutes: 30 });
    expect(invalid.status).toBe(400); expect(await db.resourceItem.count({ where: { resourceId: resource.id } })).toBe(before);
    expect(((await get(`/resources/${resource.id}/items`).expect(200)).body as ResourceItem[]).map(item => item.title)).toEqual(['Existing item']);
  });

  it('rejects malformed indentation without partially importing the outline', async () => {
    const resource = await makeResource({ title: 'Indent validation fixture' });
    for (const outline of ['Root\n    Skipped level', 'Root\n Child', 'Root\n \tMixed indentation']) {
      const response = await post(`/resources/${resource.id}/import-outline`, { outline, defaultMinutes: 30 });
      expect(response.status).toBe(400); expect(await db.resourceItem.count({ where: { resourceId: resource.id } })).toBe(0);
    }
  });

  it('reorders the complete active resource tree atomically and rejects cycles or missing items', async () => {
    const resource = await makeResource({ title: 'Reorder fixture' });
    const first = await makeItem(resource.id, { title: 'First chapter', kind: 'chapter', estMinutes: 0 });
    const child = await makeItem(resource.id, { title: 'Child lesson', parentItemId: first.id, ordinal: 0 });
    const second = await makeItem(resource.id, { title: 'Second chapter', kind: 'chapter', estMinutes: 0, ordinal: 1 });
    const reordered = [{ id: first.id, parentItemId: null, ordinal: 1 }, { id: child.id, parentItemId: second.id, ordinal: 0 }, { id: second.id, parentItemId: null, ordinal: 0 }];
    await post(`/resources/${resource.id}/reorder`, { items: reordered }).expect(200);
    expect((await db.resourceItem.findUniqueOrThrow({ where: { id: child.id } })).parentItemId).toBe(second.id);
    const before = await db.resourceItem.findMany({ where: { resourceId: resource.id }, orderBy: { id: 'asc' } });
    const cycle = reordered.map(item => item.id === second.id ? { ...item, parentItemId: child.id } : item);
    expectRejected((await post(`/resources/${resource.id}/reorder`, { items: cycle })).status);
    expectRejected((await post(`/resources/${resource.id}/reorder`, { items: reordered.slice(1) })).status);
    expect(await db.resourceItem.findMany({ where: { resourceId: resource.id }, orderBy: { id: 'asc' } })).toEqual(before);
  });

  it('rejects parent cycles and cross-resource parents without changing the saved tree', async () => {
    const resource = await makeResource(); const parent = await makeItem(resource.id, { kind: 'chapter', title: 'Parent', estMinutes: 0 });
    const child = await makeItem(resource.id, { parentItemId: parent.id, title: 'Child' });
    expectRejected((await patch(`/resource-items/${parent.id}`, { parentItemId: child.id })).status);
    expectRejected((await patch(`/resource-items/${child.id}`, { parentItemId: child.id })).status);
    const other = await makeResource(); const otherParent = await makeItem(other.id, { title: 'Other resource parent' });
    expect([400, 404, 409]).toContain((await patch(`/resource-items/${child.id}`, { parentItemId: otherParent.id })).status);
    expect((await db.resourceItem.findUniqueOrThrow({ where: { id: parent.id } })).parentItemId).toBeNull();
    expect((await db.resourceItem.findUniqueOrThrow({ where: { id: child.id } })).parentItemId).toBe(parent.id);
  });

  it('rejects direct and transitive dependency cycles atomically', async () => {
    const resource = await makeResource(); const first = await makeItem(resource.id, { title: 'First' });
    const second = await makeItem(resource.id, { title: 'Second' }), third = await makeItem(resource.id, { title: 'Third' });
    await patch(`/resource-items/${first.id}`, { dependsOn: [second.id] }).expect(200);
    await patch(`/resource-items/${second.id}`, { dependsOn: [third.id] }).expect(200);
    expectRejected((await patch(`/resource-items/${third.id}`, { dependsOn: [first.id] })).status);
    expectRejected((await patch(`/resource-items/${first.id}`, { dependsOn: [first.id] })).status);
    expect((await get(`/resources/${resource.id}/items`).expect(200)).body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, dependsOn: [second.id] }), expect.objectContaining({ id: second.id, dependsOn: [third.id] }), expect.objectContaining({ id: third.id, dependsOn: [] }),
    ]));
    expect(await db.itemDependency.count({ where: { resourceId: resource.id } })).toBe(2);
  });

  it('returns404 for foreign goal/resource/item references and hides them from lists', async () => {
    const operations = [
      get(`/goals/${foreignGoalId}`), get(`/goals/${foreignGoalId}/rules`), patch(`/goals/${foreignGoalId}`, { title: 'Foreign edit' }),
      post(`/goals/${foreignGoalId}/pause`), post(`/goals/${foreignGoalId}/resume`), post(`/goals/${foreignGoalId}/archive`),
      get(`/resources/${foreignResourceId}`), get(`/resources/${foreignResourceId}/items`), patch(`/resources/${foreignResourceId}`, { title: 'Foreign edit' }),
      post(`/resources/${foreignResourceId}/archive`), post(`/resources/${foreignResourceId}/items`, { title: 'Foreign child', estMinutes: 30 }),
      post(`/resources/${foreignResourceId}/import-outline`, { outline: 'Foreign imported item', defaultMinutes: 30 }),
      patch(`/resource-items/${foreignItemId}`, { title: 'Foreign edit' }), post(`/resource-items/${foreignItemId}/archive`),
      post('/goals', { skillId: foreignSkillId, type: 'daily', title: 'Foreign skill goal', targetQty: 30, startDate: today }),
      post('/resources', { skillId: foreignSkillId, type: 'course', title: 'Foreign skill resource' }),
      post('/resources', { skillId, type: 'course', title: 'Foreign goal resource', goalIds: [foreignGoalId] }),
    ];
    const responses = [];
    for (let offset = 0; offset < operations.length; offset += 6) responses.push(...await Promise.all(operations.slice(offset, offset + 6)));
    for (const response of responses) { expect(response.status).toBe(404); expect(response.body.error.code).toBe('NOT_FOUND'); }
    const ownedResource = await makeResource();
    expect((await post(`/resources/${ownedResource.id}/items`, { title: 'Foreign parent', parentItemId: foreignItemId, estMinutes: 30 })).status).toBe(404);
    expect((await post(`/resources/${ownedResource.id}/items`, { title: 'Foreign dependency', dependsOn: [foreignItemId], estMinutes: 30 })).status).toBe(404);
    expect(((await get('/goals').expect(200)).body as Goal[]).some(goal => goal.id === foreignGoalId)).toBe(false);
    expect(((await get('/resources').expect(200)).body as Resource[]).some(resource => resource.id === foreignResourceId)).toBe(false);
    expect((await db.resourceItem.findUniqueOrThrow({ where: { id: foreignItemId } })).title).toBe('Foreign fixture item');
  });

  it('archives resource/item rows without deleting material or allowing new hidden work', async () => {
    const resource = await makeResource(); const item = await makeItem(resource.id);
    await post(`/resource-items/${item.id}/archive`).expect(200);
    expect((await db.resourceItem.findUniqueOrThrow({ where: { id: item.id } })).archivedAt).not.toBeNull();
    await post(`/resources/${resource.id}/archive`).expect(200);
    expect((await db.resource.findUniqueOrThrow({ where: { id: resource.id } })).archivedAt).not.toBeNull();
    expect(await db.resourceItem.count({ where: { resourceId: resource.id } })).toBe(1);
    expect((await post(`/resources/${resource.id}/items`, { title: 'Hidden item', estMinutes: 30 })).status).toBe(409);
    expect(((await get('/resources').expect(200)).body as Resource[]).some(row => row.id === resource.id)).toBe(false);
    expect(((await get('/resources?archived=true').expect(200)).body as Resource[]).some(row => row.id === resource.id)).toBe(true);
  });

  it('enforces owner relationships, page ranges and work estimates in PostgreSQL', async () => {
    const goal = await makeGoal(), resource = await makeResource(), item = await makeItem((await makeResource()).id);
    await expect(db.goal.create({ data: { id: uuid(), userId: ownerId, skillId: foreignSkillId, title: 'Cross owner', type: 'daily', targetQty: 30, startDate: new Date(`${today}T00:00:00Z`) } })).rejects.toThrow();
    await expect(db.goalResource.create({ data: { id: uuid(), userId: foreignOwnerId, goalId: goal.id, resourceId: resource.id } })).rejects.toThrow();
    await expect(db.resourceItem.create({ data: { id: uuid(), userId: ownerId, resourceId: resource.id, parentItemId: item.id, title: 'Wrong resource parent', estMinutes: 30 } })).rejects.toThrow();
    await expect(db.resourceItem.create({ data: { id: uuid(), userId: ownerId, resourceId: resource.id, title: 'Invalid leaf estimate', kind: 'video', estMinutes: 0 } })).rejects.toThrow();
    await expect(db.resourceItem.create({ data: { id: uuid(), userId: ownerId, resourceId: resource.id, title: 'Invalid pages', pagesFrom: 10, pagesTo: 2, estMinutes: 30 } })).rejects.toThrow();
  });

  it('exposes saved goals/resources/items in bootstrap with one owner study date', async () => {
    const goal = await makeGoal(), resource = await makeResource({ goalIds: [goal.id] }), item = await makeItem(resource.id);
    const bootstrap = (await get('/bootstrap').expect(200)).body;
    expect(bootstrap.goals).toEqual(expect.arrayContaining([expect.objectContaining({ id: goal.id, unit: 'minutes' })]));
    expect(bootstrap.resources).toEqual(expect.arrayContaining([expect.objectContaining({ id: resource.id, goalIds: [goal.id] })]));
    expect(bootstrap.resourceItems).toEqual(expect.arrayContaining([expect.objectContaining({ id: item.id, resourceId: resource.id })]));
    expect(bootstrap.studyDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
