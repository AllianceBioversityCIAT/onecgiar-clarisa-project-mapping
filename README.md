# PRMS Projects Registry

A project management and registry tool for CGIAR's Performance and Results Management System (PRMS). Tracks, manages, and reports on research projects across the CGIAR portfolio, with a negotiation workflow between Center Reps and Program Reps to agree on project-to-program allocations.

## Core Workflow

Admin creates projects → Center Rep initiates mappings to programs with `%` allocation → Center and Program Reps negotiate via a chat / counter-propose thread → when all mappings are agreed and the total equals 100%, the Center Rep locks the round. The project-level `negotiation_locked` flag is the single source of truth.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | NestJS (TypeScript), TypeORM (migrations only, `synchronize: false`) |
| Frontend | Angular 21, PrimeNG 21, SCSS |
| Database | MySQL 8 |
| Auth | AWS Cognito OAuth2 + local JWT (15min access + httpOnly refresh cookie 30d) |
| Logging | Winston + winston-daily-rotate-file |
| External | CLARISA (Centers, Programs, Countries, Action Areas), RabbitMQ producer for the central CGIAR Notification Microservice |
| Container | Docker + Docker Compose |
| Node.js | 22 LTS |

## Repository Structure

```
PRMS-Projects-Registry/
├── api/                     # NestJS backend
│   ├── src/
│   │   ├── common/          # Guards, interceptors, filters, base entity, logger
│   │   ├── config/          # Typed config (app, database, auth, clarisa)
│   │   ├── database/        # data-source.ts, migrations/
│   │   └── modules/         # auth, users, projects, mappings, reference-data,
│   │                        # clarisa, import, dashboard, emails, settings, published
│   └── test/
├── web/                     # Angular 21 app
│   └── src/app/
│       ├── core/            # Services, interceptors, guards, error handler
│       ├── features/        # Lazy-loaded: dashboard, projects, mappings, users, admin
│       ├── shared/          # Shared components, pipes, directives
│       └── layout/          # Sidebar + toolbar shell
├── tests/browser/           # Playwright browser specs
├── docker-compose.yml       # Dev (api, web, mysql, phpmyadmin)
├── docker-compose.prod.yml  # Prod (api, web, mysql, nginx)
├── nginx/                   # Reverse-proxy config
├── playwright/              # Playwright artifacts (gitignored)
└── CLAUDE.md                # Agent-facing project rules
```

## Quick Start

### Prerequisites

- Node.js 22 (`nvm use 22`)
- Docker + Docker Compose
- A CLARISA API account and an AWS Cognito user pool (or use dev login — see below)

### Run with Docker (recommended)

```bash
cp api/.env.example api/.env       # fill in Cognito + CLARISA creds
docker-compose up --build
```

Services:

- API → `http://localhost:3000`
- Web → `https://localhost:4200`
- MySQL → `localhost:3306`
- phpMyAdmin → `http://localhost:8080`

Migrations run automatically on API container start. CLARISA reference data auto-syncs on first boot when the tables are empty.

### Run locally (no Docker)

```bash
# Backend
cd api
npm install
npm run migration:run
npm run start:dev          # port 3000

# Frontend (separate shell)
cd web
npm install
npm start                  # https://localhost:4200
```

## Common Commands

### Backend (`api/`)

```bash
npm run start:dev                                                  # watch mode
npm run build && npm run start:prod                                # prod build
npm run migration:generate -- src/database/migrations/MigrationName
npm run migration:run                                              # apply pending
npm run migration:revert                                           # roll back last
npm test                                                           # Jest unit
npm run test:e2e                                                   # Jest e2e
```

In a containerized environment, migrations use the compiled CLI:

```bash
docker-compose exec api node node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js
```

### Frontend (`web/`)

```bash
npm start              # https://localhost:4200 (SSL)
npm run build          # production build
```

### Browser tests

```bash
cd tests/browser
PRMS_API_URL=http://localhost:3000 npx playwright test
```

## Dev Login (browser testing without Cognito)

1. Start the HTTP test server: `cd web && npx ng serve --configuration test` (port 4202).
2. Open `http://localhost:4202/auth?dev=admin@codeobia.com` — the app exchanges the email for a JWT, sets the refresh cookie, and redirects to `/dashboard`.
3. Ensure `CORS_ORIGIN` in `api/.env` includes `http://localhost:4202`.

Available only when `NODE_ENV=development`. See `CLAUDE.md` for the full list of dev endpoints.

## Roles

| Role | Scope |
|------|-------|
| **Admin** | CRUD projects, manage users, trigger CSV import and CLARISA sync. Read-only on the negotiation surface. |
| **Center Rep** | Initiates / counter-proposes / agrees / removes mappings on projects in their center(s). Locks and reopens rounds. Sets complementarity + efficiency ratings. May belong to multiple centers and switch the active one via the header. |
| **Program Rep** | Negotiates on mappings to their program: agree, counter-propose, post chat, request removal. Cannot lock or create mappings. |
| **Workflow Admin** | System-office arbiter with full negotiation rights on every project regardless of center. Lands on `/needs-assistance`. |
| **Unit Admin** (PPU / PCU) | Edits whitelisted project metadata on any project regardless of lock state. Republishes snapshots. |
| **No role** | Read-only viewer; mutating endpoints return 403. |

Full permission matrix and endpoint surface: see [`CLAUDE.md`](./CLAUDE.md).

## Key Concepts

- **Append-only negotiation timeline** — every state change appends a new `mapping_negotiations` row; no row is ever updated. Guarded by a mandatory three-tier test suite (unit + e2e + Playwright) — see the *Negotiation Test Gate* section of `CLAUDE.md`.
- **Lock gate** — a project round can lock only when every non-removed mapping is `agreed` and allocations sum to 100%. Enforced with pessimistic row locking.
- **Mapping cap** — at most 3 active (non-removed) mappings per project. CSV / Signalling importers bypass the cap for legacy data.
- **Multi-center reps** — a `center_rep` user can belong to N centers via the `user_centers` junction. The frontend sends `X-Active-Center: <id>` on every API call; a backend interceptor overlays `req.user.centerId` so existing scoping checks work unchanged.
- **Email kill switch** — `system_settings.email_enabled` is the admin toggle; the email-dispatch cron skips leasing when it is `false`. The broker connection itself is independently gated by `NOTIFICATIONS_ENABLED` / `NOTIFICATIONS_DRY_RUN`.

## Environment Variables

Copy `api/.env.example` to `api/.env` and fill in:

- `DB_*` — MySQL connection (defaults work with the Docker compose stack)
- `COGNITO_*` — AWS Cognito user pool, client, and redirect URI
- `JWT_SECRET` — signing secret for the local access tokens
- `CLARISA_USERNAME`, `CLARISA_PASSWORD`, `CLARISA_URL` — reference-data API
- `CORS_ORIGIN` — comma-separated list of allowed origins
- `LOG_LEVEL`, `LOG_FORMAT` — Winston configuration
- `NOTIFICATIONS_ENABLED`, `NOTIFICATIONS_DRY_RUN` — RabbitMQ producer kill switches

## Project Rules

This repo is built and maintained with the help of specialized Claude Code agents (see `.claude/`). All work follows the rules in [`CLAUDE.md`](./CLAUDE.md), including:

1. Clean code with comments on every non-trivial block
2. Minimal external dependencies
3. PrimeNG as the only UI library
4. Structured Winston logging — no `console.log` in backend code
5. TypeORM migrations only (`synchronize: false`)
6. Typed config via `@nestjs/config`, never hardcoded secrets
7. The Negotiation Test Gate — any change to the negotiation surface must run and update the three-tier test suite

## License

Apache License 2.0 — see [`LICENSE`](./LICENSE).
