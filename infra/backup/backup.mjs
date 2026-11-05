import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, stat, lstat, unlink, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';

const { Client } = pg;
const quote = (identifier) => `"${identifier.replaceAll('"', '""')}"`;
const tableKey = (table) => JSON.stringify([table.schema, table.table]);
const directory = () => resolve(process.env.BACKUP_DIR || './backups');

function connection() {
  let value = process.env.DATABASE_URL;
  if (!value && process.env.DATABASE_URL_FILE) value = readFileSync(process.env.DATABASE_URL_FILE, 'utf8').trim();
  if (!value) throw new Error('DATABASE_URL must be configured for backup operations');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('A PostgreSQL connection is required');
  return url;
}

function childEnvironment(url) {
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT || '15',
    ...(url.searchParams.has('sslmode') ? { PGSSLMODE: url.searchParams.get('sslmode') } : {}),
  };
}

function processDone(child, operation) {
  let stderr = '';
  child.stderr?.on('data', (chunk) => { if (stderr.length < 8000) stderr += chunk.toString().slice(0, 8000 - stderr.length); });
  return new Promise((resolveDone, reject) => {
    child.once('error', () => reject(new Error(`${operation} could not start; ensure PostgreSQL 16 client tools are installed`)));
    child.once('close', (code) => code === 0 ? resolveDone() : reject(new Error(`${operation} failed (exit ${code}): ${stderr.trim()}`)));
  });
}

async function execute(program, args, url, operation) {
  const child = spawn(program, args, { env: childEnvironment(url), stdio: ['ignore', 'ignore', 'pipe'] });
  await processDone(child, operation);
}

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function atomicJson(file, value) {
  const partial = `${file}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(partial, file);
  } catch (error) {
    await unlink(partial).catch(() => undefined);
    throw error;
  }
}

async function inventory(client) {
  const result = await client.query(`
    SELECT n.nspname AS schema, c.relname AS table
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
    ORDER BY n.nspname, c.relname
  `);
  const tables = [];
  for (const row of result.rows) {
    const count = await client.query(`SELECT count(*) AS count FROM ${quote(row.schema)}.${quote(row.table)}`);
    const value = Number(count.rows[0].count);
    if (!Number.isSafeInteger(value)) throw new Error('A table row count exceeds the safe manifest range');
    tables.push({ schema: row.schema, table: row.table, count: value });
  }
  return tables;
}

async function manifestFor(file) {
  const root = await realpath(directory());
  const candidate = resolve(file);
  const rel = relative(root, candidate);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Backup verification is limited to the configured backup directory');
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('The backup must be a regular archive file');
  const actual = await realpath(candidate);
  const actualRel = relative(root, actual);
  if (actualRel.startsWith('..') || isAbsolute(actualRel)) throw new Error('Backup path escapes the configured backup directory');
  const manifest = JSON.parse(await readFile(`${actual}.json`, 'utf8'));
  if (manifest.formatVersion !== 1 || !Array.isArray(manifest.tables) || manifest.encrypted !== false) throw new Error('Unsupported local backup manifest');
  if (manifest.sha256 !== await digest(actual)) throw new Error('Backup checksum does not match its manifest');
  return { archive: actual, manifest };
}

export async function runBackup({ localOnly = false, periodKey } = {}) {
  if (!localOnly) throw new Error('Local backups require --local-only; use the encrypted recovery workflow for off-device backups');
  if (periodKey && !/^[a-zA-Z0-9_-]{1,80}$/.test(periodKey)) throw new Error('Invalid backup period key');
  const root = directory();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const id = periodKey || randomUUID();
  const archive = resolve(root, `kram-local-${id}.dump`);
  if (periodKey) {
    try { return (await manifestFor(archive)).manifest; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const partial = `${archive}.${randomUUID()}.partial`;
  const url = connection();
  const client = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 15_000 });
  let child;
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
    const tables = await inventory(client);
    const serverVersion = (await client.query('SHOW server_version')).rows[0].server_version;
    child = spawn(process.env.PG_DUMP_BIN || 'pg_dump', ['--format=custom', '--no-owner', '--snapshot', snapshot], { env: childEnvironment(url), stdio: ['ignore', 'pipe', 'pipe'] });
    await Promise.all([pipeline(child.stdout, createWriteStream(partial, { flags: 'wx', mode: 0o600 })), processDone(child, 'Database dump')]);
    await client.query('ROLLBACK');
    await rename(partial, archive);
    const metadata = {
      formatVersion: 1,
      id,
      createdAt: new Date().toISOString(),
      database: decodeURIComponent(url.pathname.slice(1)),
      serverVersion,
      path: archive,
      encrypted: false,
      localOnly: true,
      sizeBytes: (await stat(archive)).size,
      sha256: await digest(archive),
      tables,
      verification: null,
    };
    await atomicJson(`${archive}.json`, metadata);
    return metadata;
  } catch (error) {
    child?.kill('SIGTERM');
    await unlink(partial).catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function verifyBackup(file) {
  const { archive, manifest } = await manifestFor(file);
  const source = connection();
  const temporaryName = `kram_restore_check_${randomUUID().replaceAll('-', '')}`;
  const target = new URL(source);
  target.pathname = `/${temporaryName}`;
  const admin = new Client({ connectionString: source.toString(), connectionTimeoutMillis: 15_000 });
  let restored;
  let created = false;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${quote(temporaryName)} TEMPLATE template0`);
    created = true;
    await execute(process.env.PG_RESTORE_BIN || 'pg_restore', ['--exit-on-error', '--no-owner', '--no-privileges', '--dbname', temporaryName, archive], target, 'Database restore');
    restored = new Client({ connectionString: target.toString(), connectionTimeoutMillis: 15_000 });
    await restored.connect();
    const tables = await inventory(restored);
    const expected = new Map(manifest.tables.map((table) => [tableKey(table), table.count]));
    if (tables.length !== expected.size || tables.some((table) => expected.get(tableKey(table)) !== table.count)) throw new Error('Restored table inventory or row counts differ from the snapshot manifest');
    const invalid = await restored.query('SELECT count(*) AS count FROM pg_constraint WHERE NOT convalidated');
    if (Number(invalid.rows[0].count) !== 0) throw new Error('Restored database has unvalidated constraints');
    const verification = { verified: true, verifiedAt: new Date().toISOString(), tableCount: tables.length, rowCounts: true, constraints: true, temporaryDatabaseRemoved: true };
    await restored.end();
    restored = undefined;
    await admin.query(`DROP DATABASE ${quote(temporaryName)} WITH (FORCE)`);
    created = false;
    manifest.verification = verification;
    await atomicJson(`${archive}.json`, manifest);
    return { backupId: manifest.id, path: archive, ...verification };
  } finally {
    await restored?.end().catch(() => undefined);
    if (created) await admin.query(`DROP DATABASE ${quote(temporaryName)} WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    let result;
    if (command === 'run') result = await runBackup({ localOnly: process.argv.includes('--local-only'), periodKey: process.argv.find((arg) => arg.startsWith('--period-key='))?.slice('--period-key='.length) });
    else if (command === 'verify' && process.argv[3]) result = await verifyBackup(process.argv[3]);
    else throw new Error('Usage: node infra/backup/backup.mjs run --local-only [--period-key=KEY] | verify ARCHIVE');
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: { code: 'BACKUP_FAILED', message: error.message } })}\n`);
    process.exitCode = 1;
  }
}
