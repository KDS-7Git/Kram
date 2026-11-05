import { createApp } from "./app";
import { config } from "./config";
import { db } from "./db";
import { logger } from "./logger";
const app = createApp();
const server = app.listen(config.port, config.host, () =>
  logger.info({ host: config.host, port: config.port }, "Kram API listening"),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () =>
    server.close(() => {
      void Promise.all([
        db.$disconnect(),
        app.locals.closeSessions() as Promise<void>,
      ]).finally(() => process.exit(0));
    }),
  );
