# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/engine-time/package.json ./packages/engine-time/package.json
COPY packages/engine-recurrence/package.json ./packages/engine-recurrence/package.json
COPY packages/engine-timetable/package.json ./packages/engine-timetable/package.json
COPY packages/engine-scheduler/package.json ./packages/engine-scheduler/package.json
COPY packages/engine-streaks/package.json ./packages/engine-streaks/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --cache /root/.npm
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.json tsup.config.ts ./
RUN npm run db:generate && npm run build && npm prune --omit=dev --cache /root/.npm

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8420
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl openssl \
    && mkdir -p /usr/share/postgresql-common/pgdg \
    && curl --fail --silent --show-error https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       --output /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && printf '%s\n' 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' \
       > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends postgresql-client-16 age rclone \
    && apt-get purge -y --auto-remove curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/apps/api/prisma ./apps/api/prisma
COPY --chown=node:node infra ./infra
COPY --chown=node:node scripts ./scripts
RUN chmod 0755 infra/entrypoint.sh && mkdir -p /app/backups && chown node:node /app/backups
USER node
EXPOSE 8420
ENTRYPOINT ["/app/infra/entrypoint.sh"]
CMD ["node", "dist/server/api.js"]
