import express from "express";
import helmet from "helmet";
import compression from "compression";
import { readFileSync, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { db } from "./db";
import { config } from "./config";
import { logger } from "./logger";
import { errorHandler } from "./errors";
import { attachSessions, requireAuth, csrf } from "./session";
import { authRouter } from "./modules/auth/router";
import { hierarchyRouter } from "./modules/hierarchy/router";
import { goalsRouter } from "./modules/goals/router";
import { resourcesRouter } from "./modules/resources/router";
import { timetableRouter } from "./modules/timetable/router";
import { notificationsRouter } from "./modules/notifications/router";
import { tasksRouter } from "./modules/tasks/router";
import { recurrenceRouter } from "./modules/recurrence/router";
import { streaksRouter } from './streaks/router';
import { fullNotificationsRouter } from './streaks/full-notifications-router';
import { analyticsRouter } from './analytics/router';
import { dataRouter } from './data/router';
import { deletionRouter } from './data/deletion-router';
import { planningRouter } from './modules/planning/router';
import { closeJobProducer } from "./jobs";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set(
    "trust proxy",
    /^\d+$/.test(config.trustProxy)
      ? Number(config.trustProxy)
      : config.trustProxy,
  );
  const webDir = resolve("dist/web");
  const html = existsSync(resolve(webDir, "index.html"))
    ? readFileSync(resolve(webDir, "index.html"), "utf8")
    : null;
  const scriptHashes = [
    ...(html ?? "").matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g),
  ]
    .filter((m) => m[1]?.trim())
    .map(
      (m) => `'sha256-${createHash("sha256").update(m[1]!).digest("base64")}'`,
    );
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", ...scriptHashes],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.cookieSecure ? [] : null,
        },
      },
    }),
  );
  app.use((req, res, next) => {
    res.locals.requestId = randomUUID();
    res.setHeader("X-Request-Id", res.locals.requestId as string);
    const start = performance.now();
    res.on("finish", () =>
      logger.info(
        {
          requestId: res.locals.requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Math.round(performance.now() - start),
        },
        "request",
      ),
    );
    next();
  });
  app.use(compression());
  app.use(express.json({ limit: "256kb" }));
  app.get("/api/v1/health", async (_req, res) => {
    try {
      await db.$queryRaw`SELECT 1`;
      res.json({ status: "ok", database: "connected", version: "0.1.0" });
    } catch {
      res.status(503).json({ status: "unhealthy", database: "unavailable" });
    }
  });
  app.get("/api/v1/version", (_req, res) =>
    res.json({ name: "Kram", version: "0.1.0" }),
  );
  attachSessions(app);
  const closeSessions = app.locals.closeSessions;
  app.locals.closeSessions = async () => {
    await closeJobProducer();
    await closeSessions();
  };
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1", requireAuth, csrf, hierarchyRouter);
  app.use("/api/v1", goalsRouter, resourcesRouter);
  app.use("/api/v1", tasksRouter, timetableRouter, notificationsRouter, recurrenceRouter, planningRouter, analyticsRouter, dataRouter, deletionRouter, streaksRouter, fullNotificationsRouter);
  app.use("/api", (_req, res) =>
    res.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: "This endpoint does not exist.",
        requestId: res.locals.requestId,
      },
    }),
  );
  if (html) {
    app.use(express.static(webDir, { maxAge: config.production ? "1h" : 0 }));
    app.get("/{*path}", (_req, res) => res.type("html").send(html));
  } else
    app.get("/", (_req, res) =>
      res.json({
        name: "Kram",
        message: "Run npm run dev:web, or npm run build to serve the app.",
      }),
    );
  app.use(errorHandler);
  return app;
}
