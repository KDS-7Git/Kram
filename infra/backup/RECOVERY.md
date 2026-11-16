# Encrypted recovery

Daily custom-format dumps use a repeatable-read snapshot and keep its table inventory and row counts. `recovery.mjs` encrypts with age, removes the plaintext dump after a durable encrypted archive and manifest exist, verifies a restore into an isolated temporary database, then ships only the encrypted archive and its metadata. The first run verifies; later successful runs verify at least every seven days. Temporary decrypted files and restore databases are removed even on failure.

The worker keeps the existing durable 03:00 schedule, retries and advisory lock. `BACKUP_MODE=local` is the explicit plaintext mode. Configure the encrypted mode and an off-device target to satisfy the recovery policy; the settings page shows missing configuration instead of claiming protection.

## Configure once

Generate an age identity on a trusted machine with `age-keygen -o secrets/backup_age_identity`, then set `BACKUP_AGE_RECIPIENT` in your local environment to the public recipient printed by `age-keygen -y secrets/backup_age_identity`. The identity file must be readable by the configured `LOCAL_UID` and have mode 0600. Keep a second copy of the identity and the app secrets in your password manager and offline recovery records. Never commit them.

Choose exactly one target. For a NAS or another machine, mount its filesystem first, ensure your application UID can write to it, and set `BACKUP_OFFSITE_HOST_DIR` to that existing mount. A different folder on the same disk does not protect against a failed machine. Run Compose with the same overlays for every later operation:

```sh
docker compose -f docker-compose.yml -f infra/backup/encrypted.compose.yml -f infra/backup/nas.compose.yml up -d --build
```

For object storage, configure rclone on a trusted machine. Place its config in `secrets/backup_rclone_config`, mode 0600, and set `BACKUP_OFFSITE_REMOTE` to `remote:bucket/kram`. Use a dedicated prefix: retention deletes only validated `kram-recovery-*.dump.age` archives and their companion manifests inside that prefix.

```sh
docker compose -f docker-compose.yml -f infra/backup/encrypted.compose.yml -f infra/backup/rclone.compose.yml up -d --build
```

The runtime contains age, rclone and PostgreSQL 16 client tools. `BACKUP_AGE_IDENTITY_HOST_FILE` and `BACKUP_RCLONE_CONFIG_HOST_FILE` override the default secret paths. The encrypted overlay binds local backups read-only into the app for disk health and mounts the identity only into the worker. It does not create a nonexistent NAS mount.

For native runs, set `DATABASE_URL` or `DATABASE_URL_FILE`, `BACKUP_DIR`, `BACKUP_AGE_RECIPIENT` (or `BACKUP_AGE_RECIPIENTS_FILE`), `BACKUP_AGE_IDENTITY_FILE`, and either `BACKUP_OFFSITE_DIR` or `BACKUP_OFFSITE_REMOTE`. `AGE_BIN`, `PG_DUMP_BIN`, `PG_RESTORE_BIN` and `RCLONE_BIN` are optional executable overrides. Rclone credentials use its own config file or environment; raw AWS credentials are not required by the app.

## Check a recovery point

Use your configured overlay set to open a worker shell. These manual commands create/verify recovery files but bypass the worker's durable queue status; scheduled runs update the settings page.

```sh
node infra/backup/recovery.mjs run --verify
node infra/backup/recovery.mjs verify /app/backups/kram-recovery-ARCHIVE_ID.dump.age
```

Successful JSON reports include `encrypted: true`, `localOnly: false`, the off-device copy time, ciphertext and plaintext checksums, and verification of all table inventories, row counts and validated database constraints. NAS copies are checksum-verified. Rclone transfers are verified by downloading and hashing their ciphertext before success is recorded. Retention keeps the union of seven daily, four weekly and six monthly recovery points; it operates only after successful verification/copy, and ignores unrelated files.

Failures preserve the last successful recovery point and return a nonzero result. The worker records failed attempts and can send its configured operational notification. The settings health view reports missing/stale backups, encryption, off-device copy, verification time, disk usage, database size, due-job lag and repeated notification failures.

## Restore onto a clean machine

1. Provision Docker, persistent SSD storage and the intended private-network access. Recover your Compose environment and application secrets, including the age identity, from your recovery records.
2. Retrieve the encrypted archive and its companion `.json` manifest from the off-device destination. Verify the ciphertext SHA-256 against the manifest before decrypting.
3. Start **Postgres only** with the original database/user setup. Keep the app and worker stopped. Decrypt the archive into a protected temporary local directory with `age --decrypt --identity /protected/backup_age_identity --output /protected/restore.dump /protected/archive.dump.age`.
4. Check the plaintext checksum against `plaintextSha256`, then restore using PostgreSQL 16 `pg_restore --exit-on-error --no-owner --no-privileges` into the empty target database. Supply credentials via protected environment/files, never command arguments. Do not restore over an active database.
5. Start the app and worker. Forward migrations run if the archive is older. Run `node dist/server/cli.js integrity`, sign in, and check profiles, archived goals, progress history, plans/reviews, timers and notifications.
6. Compare restored row counts with the manifest. Check that the worker catches up missed periods without duplicate progress. Remove temporary plaintext. Record elapsed recovery time and the archive's age to assess the **24-hour RPO and 2-hour RTO**.

The application verifies logical database dumps. Weekly **full-volume snapshots** must use a consistent host facility (for example an appropriately coordinated LVM/ZFS/Btrfs snapshot); copying/tarring a live Postgres data directory is not a valid replacement. A host snapshot must also be encrypted before off-device transfer and retained with the same weekly policy. The host storage choice and clean-machine drill remain owner deployment checks, because this workspace does not expose that filesystem or hardware.
