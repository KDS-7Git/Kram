#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"

node --input-type=module <<'NODE'
import { mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
mkdirSync('secrets', { recursive: true, mode: 0o700 });
chmodSync('secrets', 0o700);
for (const [file, size] of [['postgres_password', 32], ['session_secret', 64], ['encryption_key', 32]]) {
  const path = `secrets/${file}`;
  if (!existsSync(path)) writeFileSync(path, randomBytes(size).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
}
if (!existsSync('.env')) {
  const password = readFileSync('secrets/postgres_password', 'utf8').trim();
  let config = readFileSync('.env.example', 'utf8').replace(
    /^DATABASE_URL=.*$/m,
    `DATABASE_URL=postgresql://kram:${encodeURIComponent(password)}@127.0.0.1:5432/kram`,
  );
  for (const [name, value] of [['LOCAL_UID', process.getuid?.() ?? 1000], ['LOCAL_GID', process.getgid?.() ?? 1000]]) {
    const pattern = new RegExp(`^${name}=.*$`, 'm');
    config = pattern.test(config) ? config.replace(pattern, `${name}=${value}`) : `${config}\n${name}=${value}\n`;
  }
  writeFileSync('.env', config, { flag: 'wx', mode: 0o600 });
}
mkdirSync('backups', { recursive: true, mode: 0o700 });
// Optional channel credential: provision a real ntfy token before enabling it.
if (!existsSync('secrets/ntfy_token')) writeFileSync('secrets/ntfy_token', '', { flag: 'wx', mode: 0o600 });
NODE

printf '%s\n' 'Created missing local configuration and secrets; existing files were preserved.'
printf '%s\n' 'Review .env, choose SSD storage, and configure HTTPS before remote use.'
printf '%s\n' 'Start the stack with: docker compose up --build -d'
