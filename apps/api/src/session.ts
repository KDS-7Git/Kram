import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pg from "pg";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import type { Express, Request, Response, NextFunction } from "express";
import { db } from "./db";
import { config } from "./config";
import { ApiError } from "./errors";
import { audit } from "./repository";
import { getUser } from "./modules/hierarchy/service";
const idleMs = 7 * 86400000,
  absoluteMs = 30 * 86400000;
export const token = () => randomBytes(32).toString("hex");
export const sessionHash = (id: string) =>
  createHash("sha256").update(id).digest("hex");
export function safeEqual(first: string, second: string) {
  const a = Buffer.from(first),
    b = Buffer.from(second);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function attachSessions(app: Express) {
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 4 });
  const Store = connectPgSimple(session);
  const store = new Store({
    pool,
    tableName: "session",
    createTableIfMissing: false,
    pruneSessionInterval: 900,
  });
  app.use(
    session({
      name: "kram.sid",
      store,
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        secure: config.cookieSecure,
        sameSite: "lax",
        maxAge: idleMs,
      },
    }),
  );
  app.locals.closeSessions = async () => {
    store.close();
    await pool.end();
  };
}
export function csrf(req: Request, _res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }
  const origin = req.get("Origin"),
    allowed = new Set([
      new URL(config.appUrl).origin,
      ...(config.production
        ? []
        : ["http://localhost:5173", "http://127.0.0.1:5173"]),
    ]);
  if (origin && !allowed.has(origin)) {
    next(
      new ApiError(
        "CSRF_REJECTED",
        "Open this app from its configured address.",
        403,
      ),
    );
    return;
  }
  if (
    !req.session.csrfToken ||
    !safeEqual(req.session.csrfToken, req.get("X-CSRF-Token") ?? "")
  ) {
    next(
      new ApiError("CSRF_REJECTED", "Refresh this page and try again.", 403),
    );
    return;
  }
  next();
}
export async function sessionUser(req: Request) {
  if (!req.session.userId) return null;
  const now = Date.now();
  if (
    now - (req.session.createdAt ?? 0) > absoluteMs ||
    now - (req.session.lastActiveAt ?? 0) > idleMs
  )
    return null;
  if (
    await db.auditLog.findFirst({
      where: {
        userId: req.session.userId,
        action: "session_revoked",
        detail: { path: ["sessionHash"], equals: sessionHash(req.sessionID) },
      },
    })
  )
    return null;
  try {
    return await getUser(req.session.userId);
  } catch (error) {
    if (error instanceof ApiError && error.code === "NOT_FOUND") return null;
    throw error;
  }
}
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const user = await sessionUser(req);
    if (!user)
      throw new ApiError("UNAUTHENTICATED", "Sign in to continue.", 401);
    res.locals.user = user;
    res.locals.userId = user.id;
    if (Date.now() - (req.session.lastActiveAt ?? 0) > 60000)
      req.session.lastActiveAt = Date.now();
    next();
  } catch (error) {
    next(error);
  }
}
export async function rotateSession(req: Request, userId: string) {
  await audit(
    userId,
    "session_revoked",
    { sessionHash: sessionHash(req.sessionID) },
    req.ip,
  );
  await new Promise<void>((resolve, reject) =>
    req.session.regenerate((error) => (error ? reject(error) : resolve())),
  );
  req.session.userId = userId;
  req.session.csrfToken = token();
  req.session.createdAt = Date.now();
  req.session.lastActiveAt = Date.now();
  await new Promise<void>((resolve, reject) =>
    req.session.save((error) => (error ? reject(error) : resolve())),
  );
}
export async function endSession(req: Request, res: Response) {
  if (req.session.userId)
    await audit(
      req.session.userId,
      "session_revoked",
      { sessionHash: sessionHash(req.sessionID) },
      req.ip,
    );
  await new Promise<void>((resolve, reject) =>
    req.session.destroy((error) => (error ? reject(error) : resolve())),
  );
  res.clearCookie("kram.sid", {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
  });
}
