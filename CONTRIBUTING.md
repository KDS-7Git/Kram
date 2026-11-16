# Contributing

Bug reports, documentation improvements, and focused pull requests are welcome. Include a minimal reproduction, expected behavior, and the relevant environment. Use synthetic examples and leave credentials or personal data out of issues and screenshots.

## Local setup

Requirements: Node 22.20+, Docker with Compose, and PostgreSQL 16.

```bash
bash scripts/setup.sh
npm ci
docker compose -f docker-compose.yml -f infra/dev/docker-compose.yml up -d --wait postgres
npm run db:generate
npm run db:migrate
npm run dev
# In another terminal:
npm run dev:worker
```

The setup script configures a new `.env` for the generated database password. Existing configuration is preserved; ensure its `DATABASE_URL` matches your development database. Tests use disposable databases and must never run against personal data.

## Before opening a pull request

```bash
npm run check
npm run test:integration
npm run test:e2e
```

Browser tests build and serve the production frontend. Docker and the Playwright Chromium browser are required; install the browser with `npx playwright install --with-deps --no-shell chromium`.

Keep changes focused and explain the problem, resulting behavior, and validation. Add meaningful regression coverage for bug fixes. Update setup instructions when configuration or commands change.

Engines should remain deterministic and free of I/O. API and worker mutations share validation, ownership checks, and transactions. Preserve progress events and plan history; schema changes need a compatible migration and recovery plan.

UI changes should work in both themes, with keyboard alternatives, reduced motion, 320px layouts, and enlarged text. Use the shared controls and [design tokens](apps/web/src/styles/tokens.css).

Contributions are licensed under the project's [MIT license](LICENSE).
