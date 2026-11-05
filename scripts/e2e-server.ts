// Isolated browser fixture. This module is never imported by the production app.
import { GenericContainer, Wait } from "testcontainers";
import { execFileSync } from "node:child_process";
import express from "express";
import { createServer } from "vite";
import { devNull } from "node:os";

const container = await new GenericContainer("postgres:16-bookworm")
  .withEnvironment({
    POSTGRES_USER: "kram",
    POSTGRES_PASSWORD: "isolated-browser-only",
    POSTGRES_DB: "kram_e2e",
  })
  .withExposedPorts(5432)
  .withHealthCheck({
    test: ["CMD-SHELL", "pg_isready -U kram -d kram_e2e"],
    interval: 1000,
    timeout: 3000,
    retries: 30,
    startPeriod: 1000,
  })
  .withWaitStrategy(Wait.forHealthCheck())
  .start();
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: devNull,
  DATABASE_URL: `postgresql://kram:isolated-browser-only@${container.getHost()}:${container.getMappedPort(5432)}/kram_e2e`,
  NODE_ENV: "test",
  COOKIE_SECURE: "false",
  APP_URL: "http://127.0.0.1:5174",
  SESSION_SECRET: "kram-e2e-session-secret-long-enough-42",
  ENCRYPTION_KEY: "33".repeat(32),
  LOG_LEVEL: "silent",
  VITE_API_TARGET: "http://127.0.0.1:8422",
  NTFY_BASE_URL: "",
  NTFY_TOPIC: "",
  NTFY_TOKEN: "",
  NTFY_TOKEN_FILE: "",
});
for (const key of [
  "DATABASE_URL_FILE",
  "SESSION_SECRET_FILE",
  "ENCRYPTION_KEY_FILE",
  "OWNER_SETUP_TOKEN",
  "OWNER_SETUP_TOKEN_FILE",
])
  delete process.env[key];
execFileSync(
  process.execPath,
  [
    "node_modules/prisma/build/index.js",
    "migrate",
    "deploy",
    "--schema",
    "apps/api/prisma/schema.prisma",
  ],
  { env: process.env, stdio: "pipe" },
);
const { db } = await import("../apps/api/src/db");
const { createApp } = await import("../apps/api/src/app");
const { resetAuthLimiterForTests } =
  await import("../apps/api/src/modules/auth/router");
const app = express(),
  productionApp = createApp();
app.post("/api/v1/__test/reset", async (req, res, next) => {
  try {
    if (req.get("X-Kram-Test") !== "reset-isolated-db") {
      res.sendStatus(403);
      return;
    }
    const tables = await db.$queryRaw<
      { tablename: string }[]
    >`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations'`;
    if (tables.length)
      await db.$executeRawUnsafe(
        `TRUNCATE ${tables.map((row) => `"${row.tablename.replaceAll('"', '""')}"`).join(",")} CASCADE`,
      );
    await resetAuthLimiterForTests();
    res.json({ reset: true });
  } catch (error) {
    next(error);
  }
});
app.use(productionApp);
const api = app.listen(8422, "127.0.0.1");
const web = await createServer({
  configFile: "apps/web/vite.config.ts",
  server: { port: 5174, host: "127.0.0.1", strictPort: true },
});
await web.listen();
process.stdout.write(
  "Isolated Kram browser fixture ready: http://127.0.0.1:5174 (API8422)\n",
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await web.close();
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await productionApp.locals.closeSessions();
  await db.$disconnect();
  await container.stop();
  process.exit();
}
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
