# Acknowledgements

Kram is built with open-source software. Thank you to the maintainers and contributors of these projects.

## Libraries and tools

| Project | Used for |
| --- | --- |
| [React](https://react.dev/), [TypeScript](https://www.typescriptlang.org/), [Vite](https://vite.dev/) | Web interface and build tools |
| [Tailwind CSS](https://tailwindcss.com/), [Radix UI](https://www.radix-ui.com/), [Lucide](https://lucide.dev/) | Styling, accessible primitives, and icons |
| [Motion](https://motion.dev/), [dnd kit](https://dndkit.com/), [FullCalendar](https://fullcalendar.io/) | Interaction, drag controls, and calendar tools |
| [TanStack Query](https://tanstack.com/query), [Zustand](https://zustand.docs.pmnd.rs/), [React Hook Form](https://react-hook-form.com/), [Zod](https://zod.dev/) | Client state, forms, and validation |
| [React Router](https://reactrouter.com/), [Recharts](https://recharts.org/), [idb](https://github.com/jakearchibald/idb) | Navigation, charts, and offline storage |
| [Node.js](https://nodejs.org/), [Express](https://expressjs.com/), [Prisma](https://www.prisma.io/), [PostgreSQL](https://www.postgresql.org/), [pg-boss](https://github.com/timgit/pg-boss) | API, persistence, and durable jobs |
| [node-postgres](https://node-postgres.com/), [connect-pg-simple](https://github.com/voxpelli/node-connect-pg-simple), [Pino](https://getpino.io/) | Database connections, sessions, and logging |
| [Luxon](https://moment.github.io/luxon/), [rrule](https://github.com/jkbrzt/rrule) | Timezones and recurrence |
| [node-argon2](https://github.com/ranisalt/node-argon2), [Helmet](https://helmetjs.github.io/), [express-session](https://github.com/expressjs/session) | Password hashing and HTTP/session protection |
| [express-rate-limit](https://express-rate-limit.mintlify.app/), [compression](https://github.com/expressjs/compression), [dotenv](https://github.com/motdotla/dotenv), [uuid](https://github.com/uuidjs/uuid) | Request limits, HTTP compression, configuration, and identifiers |
| [clsx](https://github.com/lukeed/clsx), [tailwind-merge](https://github.com/dcastil/tailwind-merge) | Conditional CSS classes |
| [Vitest](https://vitest.dev/), [Playwright](https://playwright.dev/), [axe-core](https://github.com/dequelabs/axe-core), [fast-check](https://fast-check.dev/), [Testcontainers](https://node.testcontainers.org/), [Supertest](https://github.com/ladjs/supertest) | Automated testing |
| [ESLint](https://eslint.org/), [tsup](https://tsup.egoist.dev/) | Code checks and server builds |

The npm manifests and lockfile contain the complete dependency list. This table highlights the main components; it does not replace their license notices.

## Fonts and infrastructure

- [Source Sans 3](https://github.com/adobe-fonts/source-sans) by Adobe and [Fraunces](https://github.com/undercasetype/Fraunces) by Undercase Type are distributed through [Fontsource](https://fontsource.org/) under the SIL Open Font License 1.1.
- [ntfy](https://ntfy.sh/) and the optional [Telegram Bot API](https://core.telegram.org/bots/api) provide notification delivery.
- [age](https://age-encryption.org/) and [rclone](https://rclone.org/) provide encrypted backup and transfer tools.
- [Docker](https://www.docker.com/) and [Caddy](https://caddyserver.com/) provide deployment and optional HTTPS infrastructure.

## Design inspiration

Public product pages and documentation for [Todoist](https://www.todoist.com/), [Things](https://culturedcode.com/things/), [TickTick](https://ticktick.com/), [Google Calendar](https://workspace.google.com/products/calendar/), [Reclaim](https://reclaim.ai/), [Sunsama](https://www.sunsama.com/), [Notion](https://www.notion.com/), [Super Productivity](https://github.com/johannesjo/super-productivity), [Loop Habit Tracker](https://github.com/iSoron/uhabits), [Linear](https://linear.app/), [Raycast](https://www.raycast.com/), and [Cal.com](https://cal.com/) informed the planning workflows and visual research.

These are inspiration credits, not endorsements. Vendor screenshots, logos, proprietary fonts, and application code were not incorporated into Kram. The README preview shows Kram using synthetic example data.

See [Third-party notices](THIRD_PARTY_NOTICES.md) for distribution details. Kram's MIT license applies to its own code; dependencies retain their respective licenses.
