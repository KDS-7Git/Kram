#!/bin/sh
set -eu

# Docker secrets stay in files; never print them in shell tracing or logs.
if [ -z "${DATABASE_URL:-}" ]; then
  export DATABASE_URL
  DATABASE_URL="$(node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const secretPath = process.env.POSTGRES_PASSWORD_FILE;
    const password = secretPath ? readFileSync(secretPath, "utf8").trim() : process.env.POSTGRES_PASSWORD;
    if (!password) { throw new Error("Set DATABASE_URL or POSTGRES_PASSWORD_FILE"); }
    const url = new URL("postgresql://postgres");
    url.hostname = process.env.DATABASE_HOST || "postgres";
    url.port = process.env.DATABASE_PORT || "5432";
    url.username = process.env.DATABASE_USER || "kram";
    url.password = password;
    url.pathname = "/" + (process.env.DATABASE_NAME || "kram");
    process.stdout.write(url.toString());
  ')"
fi

if [ "${1:-}" = "node" ] && [ "${2:-}" = "dist/server/api.js" ]; then
  node node_modules/prisma/build/index.js migrate deploy --schema apps/api/prisma/schema.prisma
fi

exec "$@"
