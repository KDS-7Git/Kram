import { Prisma } from "@prisma/client";
import { v7 } from "uuid";
import { db } from "./db";
import { ApiError } from "./errors";
export type Transaction = Prisma.TransactionClient;
export type Connection = typeof db | Transaction;
export const newId = () => v7();
export const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export function iso(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(iso);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, iso(item)]),
    );
  return value;
}
export function ownerWhere(userId: string) {
  if (!userId)
    throw new ApiError("UNAUTHENTICATED", "Sign in to continue.", 401);
  return { userId };
}
export async function lockOwner(tx: Transaction, userId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
}
export async function audit(
  userId: string | null,
  action: string,
  detail: unknown = {},
  ip?: string,
  c: Connection = db,
) {
  return c.auditLog.create({
    data: { id: newId(), userId, action, detail: json(detail), ip: ip ?? null },
  });
}
export function notFound<T>(value: T | null | undefined, label = "item"): T {
  if (!value)
    throw new ApiError("NOT_FOUND", `This ${label} could not be found.`, 404);
  return value;
}
