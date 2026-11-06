import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, unlink, readdir, stat, realpath } from 'node:fs/promises';
import { resolve, basename, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { DateTime } from 'luxon';
import { runBackup, verifyBackup } from './backup.mjs';

const rootDir = () => resolve(process.env.BACKUP_DIR || './backups');
const managedName = /^kram-recovery-[a-zA-Z0-9_-]{1,80}\.dump\.age$/;
const statePath = () => resolve(rootDir(), 'recovery-status.json');
async function digest(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
async function atomicJson(file, value) {
  const partial = `${file}.${randomUUID()}.partial`;
  try { await writeFile(partial, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); await rename(partial, file); }
  finally { await unlink(partial).catch(() => undefined); }
}
function command(program, args, { input, output } = {}) {
  const child = spawn(program, args, { stdio: [input ? 'pipe' : 'ignore', output ? 'pipe' : 'ignore', 'pipe'], timeout: 3_300_000 });
  child.stderr.resume();
  const done = new Promise((resolveDone, reject) => {
    child.once('error', () => reject(new Error(`${program} could not start; install the configured backup tool`)));
    child.once('close', code => code === 0 ? resolveDone() : reject(new Error(`${program} failed (exit ${code})`)));
  });
  return Promise.all([done, ...(input ? [pipeline(createReadStream(input), child.stdin)] : []), ...(output ? [pipeline(child.stdout, createWriteStream(output, { flags: 'wx', mode: 0o600 }))] : [])]).catch(error => { child.kill('SIGTERM'); throw error; });
}
async function capture(program, args) {
  const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  let output = ''; child.stderr.resume();
  child.stdout.on('data', chunk => { output += String(chunk); if (output.length > 4_000_000) child.kill('SIGTERM'); });
  return new Promise((resolveDone, reject) => {
    child.once('error', () => reject(new Error(`${program} could not start`)));
    child.once('close', code => code === 0 && output.length <= 4_000_000 ? resolveDone(output) : reject(new Error(`${program} failed or exceeded the output limit`)));
  });
}
async function remoteDigest(program, remoteFile) {
  const child = spawn(program, ['cat', remoteFile], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 3_300_000 });
  child.stderr.resume();
  const done = new Promise((resolveDone, reject) => {
    child.once('error', () => reject(new Error('Remote checksum verification could not start')));
    child.once('close', code => code === 0 ? resolveDone() : reject(new Error('Remote checksum verification failed')));
  });
  const hash = createHash('sha256');
  await Promise.all([done, (async () => { for await (const chunk of child.stdout) hash.update(chunk); })()]);
  return hash.digest('hex');
}
function recipients() {
  if (process.env.BACKUP_AGE_RECIPIENTS_FILE) return ['--recipients-file', process.env.BACKUP_AGE_RECIPIENTS_FILE];
  if (process.env.BACKUP_AGE_RECIPIENT) return ['--recipient', process.env.BACKUP_AGE_RECIPIENT];
  throw new Error('Configure BACKUP_AGE_RECIPIENT or BACKUP_AGE_RECIPIENTS_FILE before encrypted backup');
}
async function loadState() {
  try { return JSON.parse(await readFile(statePath(), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
/** Union of the newest seven daily, four weekly and six monthly recovery points. */
export function retainedIds(manifests) {
  const selected = new Set();
  const newest = [...manifests].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  for (const [kind, limit] of [['day', 7], ['week', 4], ['month', 6]]) {
    const buckets = new Set();
    for (const manifest of newest) {
      const date = DateTime.fromISO(manifest.createdAt, { zone: manifest.timezone || 'UTC' });
      if (!date.isValid) throw new Error('Invalid backup date in retention inventory');
      const bucket = kind === 'week' ? `${date.weekYear}-${date.weekNumber}` : kind === 'month' ? date.toFormat('yyyy-MM') : date.toISODate();
      if (buckets.has(bucket)) continue;
      if (buckets.size >= limit) break;
      buckets.add(bucket); selected.add(manifest.id);
    }
  }
  return selected;
}
function validateManifest(manifest, file) {
  if (manifest.formatVersion !== 2 || manifest.encrypted !== true || !managedName.test(file) || file !== `kram-recovery-${manifest.id}.dump.age` || !Array.isArray(manifest.tables) || !/^[a-f\d]{64}$/.test(manifest.sha256) || !/^[a-f\d]{64}$/.test(manifest.plaintextSha256)) throw new Error('Invalid encrypted recovery manifest');
  return manifest;
}
async function inventory(directory) {
  const files = await readdir(directory);
  return Promise.all(files.filter(file => managedName.test(file)).map(async file => validateManifest(JSON.parse(await readFile(resolve(directory, `${file}.json`), 'utf8')), file)));
}
export async function pruneRecovery(directory = rootDir()) {
  const manifests = await inventory(directory);
  const retain = retainedIds(manifests);
  const removed = [];
  for (const manifest of manifests) if (!retain.has(manifest.id)) {
    const file = resolve(directory, `kram-recovery-${manifest.id}.dump.age`);
    await unlink(file); await unlink(`${file}.json`); removed.push(manifest.id);
  }
  return { kept: [...retain], removed };
}
async function verifyEncrypted(manifest) {
  if (!process.env.BACKUP_AGE_IDENTITY_FILE) throw new Error('Configure BACKUP_AGE_IDENTITY_FILE for the scheduled isolated restore check');
  const decrypted = resolve(rootDir(), `kram-restore-${randomUUID()}.dump`);
  try {
    await command(process.env.AGE_BIN || 'age', ['--decrypt', '--identity', process.env.BACKUP_AGE_IDENTITY_FILE], { input: manifest.path, output: decrypted });
    if (await digest(decrypted) !== manifest.plaintextSha256) throw new Error('Decrypted archive checksum does not match');
    await atomicJson(`${decrypted}.json`, { ...manifest, formatVersion: 1, encrypted: false, localOnly: true, path: decrypted, sha256: manifest.plaintextSha256 });
    const verification = await verifyBackup(decrypted);
    return { ...verification, path: undefined, backupId: manifest.id };
  } finally { await unlink(decrypted).catch(() => undefined); await unlink(`${decrypted}.json`).catch(() => undefined); }
}
export async function verifyEncryptedBackup(file) {
  const root = await realpath(rootDir()); const actual = await realpath(resolve(file));
  const rel = relative(root, actual);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Verification is limited to the backup directory');
  const manifest = validateManifest(JSON.parse(await readFile(`${actual}.json`, 'utf8')), basename(actual));
  if (await digest(actual) !== manifest.sha256) throw new Error('Encrypted backup checksum does not match');
  manifest.path = actual; manifest.verification = await verifyEncrypted(manifest);
  await atomicJson(`${actual}.json`, manifest); return manifest.verification;
}
async function offDevice(manifest) {
  const file = basename(manifest.path);
  if (process.env.BACKUP_OFFSITE_DIR) {
    const target = resolve(process.env.BACKUP_OFFSITE_DIR);
    await mkdir(target, { recursive: true, mode: 0o700 });
    const localPath = await realpath(rootDir()), targetPath = await realpath(target);
    const targetRel = relative(localPath, targetPath);
    if (!targetRel || (!targetRel.startsWith('..') && !isAbsolute(targetRel))) throw new Error('Off-device destination must be outside the local backup directory');
    const destination = resolve(target, file), partial = `${destination}.${randomUUID()}.partial`;
    try { await pipeline(createReadStream(manifest.path), createWriteStream(partial, { flags: 'wx', mode: 0o600 })); if (await digest(partial) !== manifest.sha256) throw new Error('Off-device checksum verification failed'); await rename(partial, destination); }
    finally { await unlink(partial).catch(() => undefined); }
    manifest.offDevice = { kind: 'directory', destination: target, copiedAt: new Date().toISOString() };
    await atomicJson(`${destination}.json`, manifest);
    await pruneRecovery(target);
  } else if (process.env.BACKUP_OFFSITE_REMOTE) {
    const remote = process.env.BACKUP_OFFSITE_REMOTE.replace(/\/+$/, '');
    if (!/^[\w-]+:[^\r\n]*$/.test(remote)) throw new Error('BACKUP_OFFSITE_REMOTE must be an rclone remote path');
    await command(process.env.RCLONE_BIN || 'rclone', ['copyto', manifest.path, `${remote}/${file}`, '--immutable']);
    if (await remoteDigest(process.env.RCLONE_BIN || 'rclone', `${remote}/${file}`) !== manifest.sha256) throw new Error('Remote encrypted archive checksum mismatch');
    manifest.offDevice = { kind: 'rclone', destination: remote, copiedAt: new Date().toISOString() };
    await atomicJson(`${manifest.path}.json`, manifest);
    await command(process.env.RCLONE_BIN || 'rclone', ['copyto', `${manifest.path}.json`, `${remote}/${file}.json`]);
    const listing = JSON.parse(await capture(process.env.RCLONE_BIN || 'rclone', ['lsjson', remote, '--files-only', '--include', 'kram-recovery-*.dump.age.json']));
    if (!Array.isArray(listing)) throw new Error('Invalid remote backup inventory');
    const manifests = [];
    for (const item of listing) {
      if (typeof item.Name !== 'string' || !managedName.test(item.Name.replace(/\.json$/, ''))) continue;
      manifests.push(validateManifest(JSON.parse(await capture(process.env.RCLONE_BIN || 'rclone', ['cat', `${remote}/${item.Name}`])), item.Name.replace(/\.json$/, '')));
    }
    const retain = retainedIds(manifests);
    for (const prior of manifests) if (!retain.has(prior.id)) for (const suffix of ['.dump.age', '.dump.age.json']) await command(process.env.RCLONE_BIN || 'rclone', ['deletefile', `${remote}/kram-recovery-${prior.id}${suffix}`]);
  } else throw new Error('Configure BACKUP_OFFSITE_DIR (mounted NAS/other machine) or BACKUP_OFFSITE_REMOTE (rclone)');
  manifest.localOnly = false;
  await atomicJson(`${manifest.path}.json`, manifest);
}
/** Plaintext stays on the local machine and is removed after durable age encryption. */
export async function runEncryptedBackup({ periodKey, verify = false, now = new Date() } = {}) {
  const recipientArgs = recipients();
  const id = periodKey || randomUUID();
  if (!/^[a-zA-Z0-9_-]{1,71}$/.test(id)) throw new Error('Invalid recovery period key');
  await mkdir(rootDir(), { recursive: true, mode: 0o700 });
  const prior = await loadState();
  await atomicJson(statePath(), { ...prior, status: 'running', startedAt: now.toISOString(), error: null });
  const archive = resolve(rootDir(), `kram-recovery-${id}.dump.age`);
  let manifest;
  try {
    try {
      manifest = validateManifest(JSON.parse(await readFile(`${archive}.json`, 'utf8')), basename(archive));
      if (await digest(archive) !== manifest.sha256) throw new Error('Existing encrypted archive checksum mismatch');
      manifest.path = archive;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const plain = await runBackup({ localOnly: true, periodKey: `recovery-${id}` });
      const partial = `${archive}.${randomUUID()}.partial`;
      try {
        await command(process.env.AGE_BIN || 'age', ['--encrypt', ...recipientArgs], { input: plain.path, output: partial });
        await rename(partial, archive);
        manifest = { ...plain, formatVersion: 2, id, path: archive, encrypted: true, localOnly: true, timezone: process.env.DEFAULT_TIMEZONE || 'UTC', plaintextSha256: plain.sha256, sha256: await digest(archive), sizeBytes: (await stat(archive)).size, offDevice: null };
        await atomicJson(`${archive}.json`, manifest);
        await unlink(plain.path); await unlink(`${plain.path}.json`);
      } finally { await unlink(partial).catch(() => undefined); }
    }
    const lastCheck = prior.lastVerificationAt ? Date.parse(prior.lastVerificationAt) : NaN;
    const due = verify || !Number.isFinite(lastCheck) || now.getTime() - lastCheck >= 7 * 86400000;
    const thisCheck = Date.parse(manifest.verification?.verifiedAt ?? '');
    if (due && (verify || !manifest.verification?.verified || !Number.isFinite(thisCheck) || now.getTime() - thisCheck >= 7 * 86400000)) manifest.verification = await verifyEncrypted(manifest);
    manifest.lastVerificationAt = manifest.verification?.verifiedAt ?? prior.lastVerificationAt ?? null;
    await atomicJson(`${archive}.json`, manifest);
    await offDevice(manifest);
    await pruneRecovery();
    await atomicJson(statePath(), { status: 'succeeded', finishedAt: new Date().toISOString(), lastSuccess: manifest, lastVerificationAt: manifest.lastVerificationAt, error: null });
    return manifest;
  } catch (error) {
    await atomicJson(statePath(), { ...prior, status: 'failed', finishedAt: new Date().toISOString(), error: { code: 'RECOVERY_FAILED', message: error.message } });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const commandName = process.argv[2];
    const result = commandName === 'run' ? await runEncryptedBackup({ periodKey: process.argv.find(arg => arg.startsWith('--period-key='))?.slice('--period-key='.length), verify: process.argv.includes('--verify') }) : commandName === 'verify' && process.argv[3] ? await verifyEncryptedBackup(process.argv[3]) : commandName === 'prune' ? await pruneRecovery() : null;
    if (!result) throw new Error('Usage: node infra/backup/recovery.mjs run [--period-key=KEY] [--verify] | verify ARCHIVE | prune');
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stderr.write(`${JSON.stringify({ error: { code: 'RECOVERY_FAILED', message: error.message } })}\n`); process.exitCode = 1; }
}
