import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { execFileSync } from 'node:child_process';
import { devNull } from 'node:os';
import request, { type Agent, type Response, type Test } from 'supertest';
import argon2 from 'argon2';
import { v7 as uuid } from 'uuid';
import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { defaultSettings } from '@kram/shared';

const origin = 'http://localhost:8420';
const ownerPassword = 'kram-integration-owner-private-42';
let container: StartedTestContainer;
let db: PrismaClient;
let app: Express;
let ownerAgent: Agent;
let ownerEmail = '';
let ownerId = '';
let csrfToken = '';
let ownerCookie = '';
let profileId = '';
let developmentProfileId = '';
let skillId = '';
let foreignProfileId = '';
let foreignSkillId = '';

interface AuthState {
  user: { id: string; email: string; settings: typeof defaultSettings } | null;
  setupRequired: boolean;
  setupAllowed: boolean;
  csrfToken: string;
  defaults: typeof defaultSettings;
}
interface ProfileRow { id: string; name: string; sortOrder: number; archivedAt: string | null }
interface SkillRow { id: string; profileId: string; name: string; weeklyTargetMin: number; availableDays: number[] }

function cookieFrom(response: Response): string {
  const raw: unknown = response.headers['set-cookie'];
  const headers = Array.isArray(raw) ? raw : [raw];
  const value = headers.find((item): item is string => typeof item === 'string' && /HttpOnly/i.test(item));
  return value?.split(';')[0] ?? '';
}

async function authState(agent: Agent): Promise<AuthState> {
  const response = await agent.get('/api/v1/auth/me').expect(200);
  const state = response.body as AuthState;
  expect(state.csrfToken).toEqual(expect.any(String));
  expect(state.csrfToken.length).toBeGreaterThanOrEqual(32);
  const cookie = cookieFrom(response);
  if (agent === ownerAgent && cookie) ownerCookie = cookie;
  return state;
}

async function refreshOwnerAuth() {
  const state = await authState(ownerAgent);
  csrfToken = state.csrfToken;
  return state;
}

function mutation(method: 'post' | 'patch', path: string, body: Record<string, unknown> = {}): Test {
  const operation = method === 'post' ? ownerAgent.post(path) : ownerAgent.patch(path);
  return operation.set('Origin', origin).set('X-CSRF-Token', csrfToken).send(body);
}

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-bookworm')
    .withEnvironment({ POSTGRES_USER: 'kram', POSTGRES_PASSWORD: 'isolated-integration-only', POSTGRES_DB: 'kram' })
    .withExposedPorts(5432)
    .withHealthCheck({ test: ['CMD-SHELL', 'pg_isready -U kram -d kram'], interval: 1000, timeout: 3000, retries: 30, startPeriod: 1000 })
    .withWaitStrategy(Wait.forHealthCheck())
    .start();
  const url = `postgresql://kram:isolated-integration-only@${container.getHost()}:${container.getMappedPort(5432)}/kram`;
  process.env.DATABASE_URL = url;
  process.env.DOTENV_CONFIG_PATH = devNull;
  process.env.DATABASE_URL_FILE = '';
  process.env.NODE_ENV = 'test';
  process.env.COOKIE_SECURE = 'false';
  process.env.APP_URL = origin;
  process.env.DEFAULT_TIMEZONE = 'Asia/Kolkata';
  process.env.SESSION_SECRET = 'kram-integration-session-secret-long-enough-42';
  process.env.SESSION_SECRET_FILE = '';
  process.env.ENCRYPTION_KEY = '22'.repeat(32);
  process.env.ENCRYPTION_KEY_FILE = '';
  process.env.LOG_LEVEL = 'silent';
  process.env.OWNER_SETUP_TOKEN = '';
  process.env.OWNER_SETUP_TOKEN_FILE = '';
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'apps/api/prisma/schema.prisma'], { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
  ({ db } = await import('../../apps/api/src/db'));
  const { createApp } = await import('../../apps/api/src/app');
  app = createApp();
}, 120000);

afterAll(async () => {
  const closeSessions: unknown = app?.locals.closeSessions;
  if (typeof closeSessions === 'function') await closeSessions();
  await db?.$disconnect();
  await container?.stop();
});

describe('single-owner authentication and hierarchy', () => {
  it('requires a session before resolving protected resources', async () => {
    const result = await request(app).get('/api/v1/profiles/not-a-uuid');
    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe('UNAUTHENTICATED');
    expect(result.body.error.requestId).toEqual(expect.any(String));
  });

  it('exposes first-run defaults but rejects cross-origin owner setup', async () => {
    const agent = request.agent(app);
    const state = await authState(agent);
    expect(state).toMatchObject({ user: null, setupRequired: true, setupAllowed: true });
    expect(state.defaults).toMatchObject({ timezone: 'Asia/Kolkata', dayRollover: 240, weekStart: 1, usePriority: false, planningMode: 'directed' });
    const result = await agent.post('/api/v1/auth/setup').set('Origin', 'https://foreign.example.test').set('X-CSRF-Token', state.csrfToken).send({ email: 'blocked@kram.test', password: ownerPassword });
    expect(result.status).toBe(403);
    expect(await db.user.count({ where: { isOwner: true } })).toBe(0);
  });

  it('serializes concurrent setup into exactly one Argon2id owner', async () => {
    const first = request.agent(app);
    const second = request.agent(app);
    const [firstState, secondState] = await Promise.all([authState(first), authState(second)]);
    const responses = await Promise.all([
      first.post('/api/v1/auth/setup').set('Origin', origin).set('X-CSRF-Token', firstState.csrfToken).send({ email: 'first@kram.test', password: ownerPassword }),
      second.post('/api/v1/auth/setup').set('Origin', origin).set('X-CSRF-Token', secondState.csrfToken).send({ email: 'second@kram.test', password: ownerPassword }),
    ]);
    const winner = responses.findIndex(response => response.status === 200 || response.status === 201);
    expect(winner).toBeGreaterThanOrEqual(0);
    expect(responses.filter(response => response.status === 200 || response.status === 201)).toHaveLength(1);
    expect(responses[1 - winner]?.status).toBe(409);
    ownerAgent = winner === 0 ? first : second;
    ownerCookie = cookieFrom(responses[winner]!);
    const state = await refreshOwnerAuth();
    expect(state.user).not.toBeNull();
    ownerEmail = state.user!.email;
    ownerId = state.user!.id;
    expect(ownerId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(ownerCookie).not.toBe('');
    expect(await db.user.count({ where: { isOwner: true } })).toBe(1);
    const owner = await db.user.findUniqueOrThrow({ where: { id: ownerId } });
    expect(owner.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(await argon2.verify(owner.passwordHash, ownerPassword)).toBe(true);
    expect(responses[winner]!.body).not.toHaveProperty('user.passwordHash');
    const setCookie: unknown = responses[winner]!.headers['set-cookie'];
    expect(JSON.stringify(setCookie)).toMatch(/HttpOnly/i);
    expect(JSON.stringify(setCookie)).toMatch(/SameSite=Lax/i);
  });

  it('rejects further public registration after setup', async () => {
    await refreshOwnerAuth();
    const result = await mutation('post', '/api/v1/auth/setup', { email: 'third@kram.test', password: ownerPassword });
    expect(result.status).toBe(409);
    expect(await db.user.count({ where: { isOwner: true } })).toBe(1);
  });

  it('requires both the session CSRF token and the configured origin for mutations', async () => {
    await refreshOwnerAuth();
    const missing = await ownerAgent.post('/api/v1/profiles').set('Origin', origin).send({ name: 'No CSRF' });
    expect(missing.status).toBe(403);
    const crossOrigin = await ownerAgent.post('/api/v1/profiles').set('Origin', 'https://foreign.example.test').set('X-CSRF-Token', csrfToken).send({ name: 'Foreign origin' });
    expect(crossOrigin.status).toBe(403);
    expect(await db.profile.count({ where: { userId: ownerId, name: { in: ['No CSRF', 'Foreign origin'] } } })).toBe(0);
  });

  it('creates, orders and edits profiles and per-skill targets', async () => {
    await refreshOwnerAuth();
    const created = await mutation('post', '/api/v1/profiles', { name: 'Academic', icon: 'BookOpen', color: 'teal', sortOrder: 4 });
    expect(created.status).toBe(201);
    profileId = (created.body as ProfileRow).id;
    expect(profileId).toEqual(expect.any(String));
    const earlier = await mutation('post', '/api/v1/profiles', { name: 'Development', color: 'violet', sortOrder: 0 });
    expect(earlier.status).toBe(201);
    developmentProfileId = (earlier.body as ProfileRow).id;
    const profiles = (await ownerAgent.get('/api/v1/profiles').expect(200)).body as ProfileRow[];
    expect(profiles.findIndex(profile => profile.id === (earlier.body as ProfileRow).id)).toBeLessThan(profiles.findIndex(profile => profile.id === profileId));
    const edited = await mutation('patch', `/api/v1/profiles/${profileId}`, { name: 'Academic studies', sortOrder: 3 });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ id: profileId, name: 'Academic studies', sortOrder: 3 });
    const skill = await mutation('post', `/api/v1/profiles/${profileId}/skills`, { name: 'Machine Learning', dailyTargetMin: 40, weeklyTargetMin: 240, maxDailyMin: 120, availableDays: [1, 3, 5], windows: [{ days: [1, 3, 5], startMin: 1080, endMin: 1200 }] });
    expect(skill.status).toBe(201);
    skillId = (skill.body as SkillRow).id;
    expect(skill.body).toMatchObject({ profileId, weeklyTargetMin: 240, availableDays: [1, 3, 5] });
    const skillEdit = await mutation('patch', `/api/v1/skills/${skillId}`, { weeklyTargetMin: 180 });
    expect(skillEdit.status).toBe(200);
    expect(skillEdit.body).toMatchObject({ id: skillId, weeklyTargetMin: 180 });
    const skills = (await ownerAgent.get(`/api/v1/skills?profileId=${profileId}`).expect(200)).body as SkillRow[];
    expect(skills.some(item => item.id === skillId && item.weeklyTargetMin === 180)).toBe(true);
  });

  it('validates names, time windows and calendar settings before persistence', async () => {
    await refreshOwnerAuth();
    const blank = await mutation('post', '/api/v1/profiles', { name: '   ' });
    expect(blank.status).toBe(400);
    expect(blank.body.error.code).toBe('VALIDATION_FAILED');
    const invalidWindow = await mutation('patch', `/api/v1/skills/${skillId}`, { windows: [{ days: [1], startMin: 1200, endMin: 1080 }] });
    expect(invalidWindow.status).toBe(400);
    for (const body of [{ timezone: 'Mars/Phobos' }, { dayRollover: 1440 }, { dailyReviewMin: 1440 }, { weekStart: 2 }]) {
      const invalid = await mutation('patch', '/api/v1/settings', body);
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe('VALIDATION_FAILED');
    }
    const unchanged = await ownerAgent.get('/api/v1/settings').expect(200);
    expect(unchanged.body).toMatchObject({ timezone: 'Asia/Kolkata', dayRollover: 240, weekStart: 1 });
  });

  it('preserves falsey settings and feature hiding keeps hierarchy data', async () => {
    await refreshOwnerAuth();
    const changed = await mutation('patch', '/api/v1/settings', { dayRollover: 0, weekStart: 7, usePriority: false, featurePreset: 'simple' });
    expect(changed.status).toBe(200);
    expect((await ownerAgent.get('/api/v1/settings').expect(200)).body).toMatchObject({ dayRollover: 0, weekStart: 7, usePriority: false, featurePreset: 'simple' });
    expect((await ownerAgent.get(`/api/v1/skills/${skillId}`).expect(200)).body.id).toBe(skillId);
    await mutation('patch', '/api/v1/settings', { dayRollover: 240, weekStart: 1, featurePreset: 'planner' }).expect(200);
  });

  it('returns 404 for every route accessing another owner’s hierarchy', async () => {
    await refreshOwnerAuth();
    const owner = await db.user.findUniqueOrThrow({ where: { id: ownerId } });
    const foreign = await db.user.create({ data: { id: uuid(), email: 'foreign-fixture@kram.test', passwordHash: owner.passwordHash, settings: defaultSettings, isOwner: false } });
    const foreignProfile = await db.profile.create({ data: { id: uuid(), userId: foreign.id, name: 'Foreign profile', icon: 'BookOpen', color: 'rose', sortOrder: 0 } });
    const foreignSkill = await db.skill.create({ data: { id: uuid(), userId: foreign.id, profileId: foreignProfile.id, name: 'Foreign skill', availableDays: [1, 2], windows: [] } });
    foreignProfileId = foreignProfile.id;
    foreignSkillId = foreignSkill.id;
    const results = await Promise.all([
      ownerAgent.get(`/api/v1/profiles/${foreignProfileId}`),
      mutation('patch', `/api/v1/profiles/${foreignProfileId}`, { name: 'Changed by wrong owner' }),
      mutation('post', `/api/v1/profiles/${foreignProfileId}/archive`),
      mutation('post', `/api/v1/profiles/${foreignProfileId}/skills`, { name: 'Wrong owner child' }),
      ownerAgent.get(`/api/v1/skills/${foreignSkillId}`),
      mutation('patch', `/api/v1/skills/${foreignSkillId}`, { name: 'Changed by wrong owner' }),
      mutation('post', `/api/v1/skills/${foreignSkillId}/archive`),
    ]);
    for (const result of results) {
      expect(result.status).toBe(404);
      expect(result.body.error.code).toBe('NOT_FOUND');
    }
    const visibleProfiles = (await ownerAgent.get('/api/v1/profiles').expect(200)).body as ProfileRow[];
    expect(visibleProfiles.some(profile => profile.id === foreignProfileId)).toBe(false);
    const visibleSkills = (await ownerAgent.get('/api/v1/skills').expect(200)).body as SkillRow[];
    expect(visibleSkills.some(skill => skill.id === foreignSkillId)).toBe(false);
    expect((await db.profile.findUniqueOrThrow({ where: { id: foreignProfileId } })).name).toBe('Foreign profile');
    expect((await db.skill.findUniqueOrThrow({ where: { id: foreignSkillId } })).name).toBe('Foreign skill');
  });

  it('archives hierarchy rows while retaining the records', async () => {
    await refreshOwnerAuth();
    await mutation('post', `/api/v1/skills/${skillId}/archive`).expect(200);
    await mutation('post', `/api/v1/profiles/${profileId}/archive`).expect(200);
    const archivedSkill = await db.skill.findUniqueOrThrow({ where: { id: skillId } });
    const archivedProfile = await db.profile.findUniqueOrThrow({ where: { id: profileId } });
    expect(archivedSkill.archivedAt).not.toBeNull();
    expect(archivedProfile.archivedAt).not.toBeNull();
    expect(archivedSkill.profileId).toBe(profileId);
  });

  it('rejects new skills in an archived profile without creating hidden rows', async () => {
    await refreshOwnerAuth();
    const before = await db.skill.count({ where: { userId: ownerId, profileId } });
    const result = await mutation('post', `/api/v1/profiles/${profileId}/skills`, { name: 'New child of archived profile' });
    expect(result.status).toBe(409);
    expect(await db.skill.count({ where: { userId: ownerId, profileId } })).toBe(before);
  });

  it('rejects relinking an active skill to an archived profile', async () => {
    await refreshOwnerAuth();
    const created = await mutation('post', `/api/v1/profiles/${developmentProfileId}/skills`, { name: 'Keep under an active profile' }).expect(201);
    const activeSkillId = (created.body as SkillRow).id;
    const result = await mutation('patch', `/api/v1/skills/${activeSkillId}`, { profileId });
    expect(result.status).toBe(409);
    const retained = await db.skill.findUniqueOrThrow({ where: { id: activeSkillId } });
    expect(retained.profileId).toBe(developmentProfileId);
    expect(retained.archivedAt).toBeNull();
  });

  it('rotates a logged-in session and invalidates its previous cookie', async () => {
    await refreshOwnerAuth();
    const previousCookie = ownerCookie;
    expect(previousCookie).not.toBe('');
    const login = await mutation('post', '/api/v1/auth/login', { email: ownerEmail, password: ownerPassword });
    expect(login.status).toBe(200);
    const newCookie = cookieFrom(login);
    expect(newCookie).not.toBe('');
    expect(newCookie).not.toBe(previousCookie);
    ownerCookie = newCookie;
    const stale = await request(app).get('/api/v1/profiles').set('Cookie', previousCookie);
    expect(stale.status).toBe(401);
    expect((await refreshOwnerAuth()).user?.id).toBe(ownerId);
  });

  it('logs out, refuses non-owner fixture login and rate-limits repeated failures', async () => {
    await refreshOwnerAuth();
    await mutation('post', '/api/v1/auth/logout').expect(200);
    expect((await refreshOwnerAuth()).user).toBeNull();
    const foreignLogin = await mutation('post', '/api/v1/auth/login', { email: 'foreign-fixture@kram.test', password: ownerPassword });
    expect(foreignLogin.status).toBe(401);
    expect((await refreshOwnerAuth()).user).toBeNull();
    let limited: Response | undefined;
    for (let attempt = 0; attempt < 25; attempt++) {
      const response = await mutation('post', '/api/v1/auth/login', { email: ownerEmail, password: 'wrong-integration-password-42' });
      if (response.status === 429) { limited = response; break; }
      expect(response.status).toBe(401);
    }
    expect(limited).toBeDefined();
    expect(limited!.body.error.code).toBe('RATE_LIMITED');
    expect((await db.user.findUniqueOrThrow({ where: { id: ownerId } })).isOwner).toBe(true);
  });

  it('counts concurrent login failures instead of overwriting the account lockout', async () => {
    await db.authLockout.deleteMany();
    await refreshOwnerAuth();
    const failures = await Promise.all(Array.from({ length: 3 }, () => mutation('post', '/api/v1/auth/login', { email: ownerEmail, password: 'concurrent-invalid-password-42' })));
    expect(failures.map(response => response.status)).toEqual([401, 401, 401]);
    const retry = await mutation('post', '/api/v1/auth/login', { email: ownerEmail, password: 'concurrent-invalid-password-42' });
    expect(retry.status).toBe(429);
    expect(retry.body.error.code).toBe('RATE_LIMITED');
    const lockouts = await db.authLockout.findMany();
    expect(lockouts.some(lockout => lockout.failures >= 3)).toBe(true);
  });
});
