import argon2 from "argon2";
import { createHash, randomBytes } from "node:crypto";
import {
  loginSchema,
  setupSchema,
  settingsSchema,
  defaultSettings,
} from "@kram/shared";
import { db } from "../../db";
import { config } from "../../config";
import { ApiError } from "../../errors";
import { profiles, getUser } from "../hierarchy/service";
import { newId, json, audit } from "../../repository";

const passwordOptions = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
};
let cryptoTail: Promise<void> = Promise.resolve(),
  dummyHash: Promise<string> | undefined;
function cryptoJob<T>(operation: () => Promise<T>): Promise<T> {
  const result = cryptoTail.then(operation);
  cryptoTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
export const ownerDefaults = () =>
  settingsSchema.parse({
    ...defaultSettings,
    timezone: config.defaultTimezone,
  });
export async function createOwner(input: unknown, ip?: string) {
  const data = setupSchema.parse({
    timezone: config.defaultTimezone,
    ...(input as Record<string, unknown>),
  });
  return cryptoJob(async () => {
    if (await db.user.count({ where: { isOwner: true } }))
      throw new ApiError(
        "SETUP_COMPLETE",
        "The owner account already exists. Sign in instead.",
        409,
      );
    const passwordHash = await argon2.hash(data.password, passwordOptions);
    const settings = settingsSchema.parse({
      ...ownerDefaults(),
      timezone: data.timezone,
      dayRollover: data.dayRollover,
      wakingMin: data.wakingMin,
      sleepingMin: data.sleepingMin,
      featurePreset: data.featurePreset,
    });
    const user = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('kram-owner-setup'))`;
      if (await tx.user.count({ where: { isOwner: true } }))
        throw new ApiError(
          "SETUP_COMPLETE",
          "The owner account already exists. Sign in instead.",
          409,
        );
      const owner = await tx.user.create({
        data: {
          id: newId(),
          email: data.email.toLowerCase(),
          passwordHash,
          isOwner: true,
          timezone: settings.timezone,
          dayRollover: settings.dayRollover,
          settings: json(settings),
        },
      });
      await profiles.create(owner.id, { name: data.profileName }, tx);
      await audit(owner.id, "owner_created", {}, ip, tx);
      return owner;
    });
    return getUser(user.id);
  });
}
export async function verifyOwnerCredentials(input: unknown, ip: string) {
  const data = loginSchema.parse(input),
    email = data.email.toLowerCase();
  const keys = [`account:${email}`, `ip:${ip}:${email}`].map((value) =>
    createHash("sha256").update(value).digest("hex"),
  );
  const locks = await db.authLockout.findMany({ where: { key: { in: keys } } });
  const until = locks.reduce(
    (value, lock) => Math.max(value, lock.lockedUntil?.getTime() ?? 0),
    0,
  );
  if (until > Date.now())
    throw new ApiError(
      "RATE_LIMITED",
      "Wait a moment before trying to sign in again.",
      429,
      { retryAfterSeconds: Math.ceil((until - Date.now()) / 1000) },
    );
  const user = await db.user.findFirst({ where: { email, isOwner: true } });
  const valid = await cryptoJob(async () => {
    if (!dummyHash && !user)
      dummyHash = argon2.hash(randomBytes(32).toString("hex"), passwordOptions);
    return argon2.verify(
      user?.passwordHash ?? (await dummyHash!),
      data.password,
    );
  });
  if (!user || !valid) {
    for (const key of keys) {
      const previous = locks.find((lock) => lock.key === key);
      const count =
        previous && Date.now() - previous.lastFailure.getTime() < 900000
          ? previous.failures + 1
          : 1;
      await db.authLockout.upsert({
        where: { key },
        create: {
          key,
          failures: count,
          lastFailure: new Date(),
          lockedUntil:
            count >= 3
              ? new Date(Date.now() + Math.min(900000, 1000 * 2 ** (count - 3)))
              : null,
        },
        update: {
          failures: count,
          lastFailure: new Date(),
          lockedUntil:
            count >= 3
              ? new Date(Date.now() + Math.min(900000, 1000 * 2 ** (count - 3)))
              : null,
        },
      });
    }
    throw new ApiError(
      "UNAUTHENTICATED",
      "Email or password did not match.",
      401,
    );
  }
  await db.authLockout.deleteMany({ where: { key: { in: keys } } });
  if (argon2.needsRehash(user.passwordHash, passwordOptions)) {
    const passwordHash = await cryptoJob(() =>
      argon2.hash(data.password, passwordOptions),
    );
    await db.user.update({ where: { id: user.id }, data: { passwordHash } });
    await audit(user.id, "password_rehashed", {}, ip);
  }
  await audit(user.id, "login", {}, ip);
  return getUser(user.id);
}
