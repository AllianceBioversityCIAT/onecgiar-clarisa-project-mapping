# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PRMS Projects Registry is a project management and registry tool for CGIAR's Performance and Results Management System (PRMS). It enables tracking, managing, and reporting on research projects across the CGIAR portfolio.

## Repository Structure

```
PRMS-Projects-Registry/
├── api/                 # NestJS backend (latest, TypeScript, TypeORM, MySQL 8)
│   ├── src/
│   │   ├── common/      # Guards, decorators, interceptors, filters, base entity, DTOs, logger
│   │   ├── config/      # Typed config (app, database, auth)
│   │   ├── database/    # data-source.ts, migrations/
│   │   └── modules/     # Feature modules (one dir per domain)
│   ├── test/
│   ├── .env.example
│   └── package.json
├── web/                 # Angular 21 app (PrimeNG v21, SCSS)
│   ├── src/
│   │   ├── app/
│   │   │   ├── core/        # Services (auth, api), interceptors, guards
│   │   │   ├── features/    # Lazy-loaded route modules
│   │   │   ├── shared/      # Shared components, pipes, directives
│   │   │   └── layout/      # LayoutComponent (sidebar + toolbar shell)
│   │   ├── assets/
│   │   ├── styles/          # _variables, _reset, _typography, _mixins, _theme
│   │   └── environments/
│   └── package.json
├── docker-compose.yml       # Dev environment (api, web, mysql, phpmyadmin)
├── docker-compose.prod.yml  # Production environment
├── nginx/               # Nginx config, reverse proxy
├── logs/                # Winston log files (gitignored except .gitkeep)
├── media/               # Uploaded files (gitignored except .gitkeep)
├── .claude/             # Agent definitions and project memory
└── CLAUDE.md
```

## Build & Run Commands

### Back-end (`api/`)
```bash
npm run start:dev          # Development with watch mode (port 3000)
npm run build              # Production build
npm run start:prod         # Run production build
npm run migration:generate -- src/database/migrations/MigrationName
npm run migration:run      # Run pending migrations
npm run migration:revert   # Revert last migration
npm test                   # Jest unit tests
npm run test:e2e           # End-to-end tests
```

### Front-end (`web/`)
```bash
npm start                  # Dev server (port 4200)
npm run build              # Production build
```

### Docker (from repo root)
```bash
docker-compose up --build  # Build and start all services
docker-compose down        # Stop (keep data)
docker-compose down -v     # Stop and wipe MySQL volume
```
Services: API (3000), Web (4200), MySQL (3306), phpMyAdmin (8080)

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Backend framework | NestJS | Latest (v10+) |
| Frontend framework | Angular | 21 |
| UI library | PrimeNG | 21 |
| Database | MySQL | 8.0 |
| ORM | TypeORM | Latest (migrations only, `synchronize: false` always) |
| Styling | SCSS + PrimeNG theme | — |
| State management | Angular Signals + Services | — |
| Auth | JWT (access 15min + httpOnly refresh cookie 30d) | — |
| Logging | Winston + winston-daily-rotate-file | — |
| Container | Docker + Docker Compose | — |
| Node.js | 22 LTS | — |

### Key Technical Notes
- Angular 21 polyfills: Must add `"polyfills": ["zone.js"]` to `angular.json` build options
- All monetary values: `decimal(10,2)` in DB, never `float`
- PrimeNG theme: Custom PRMS theme using CGIAR brand colors (primary: `#eb2f64`)

## Agent Workflow

This project uses specialized agents. **All user instructions must flow through the Project Manager agent first.**

### How It Works

1. **User gives an instruction** (any feature request, task, question, or requirement)
2. **Route to `tech-project-manager` agent first** — it analyzes the instruction, clarifies ambiguities, breaks it into actionable tasks, and reformulates each task with the right technical context for the target agent
3. **Project Manager dispatches to specialist agents** based on expertise:

| Agent | Expertise | Receives tasks about |
|-------|-----------|---------------------|
| `tech-project-manager` | Requirements analysis, task breakdown, architecture planning, scope management | Project planning, specs, ambiguous requirements, multi-agent coordination |
| `angular-frontend-expert` | Angular 21, PrimeNG, state management, forms, data tables | Frontend components, pages, UI/UX, Angular routing, forms, styling |
| `nestjs-backend-expert` | NestJS, MySQL, TypeORM, REST APIs, auth | API endpoints, database schema, services, integrations, backend logic |
| `devops-docker-jenkins` | Docker, Jenkins, CI/CD, deployment, infrastructure | Dockerfiles, pipelines, docker-compose, deployment configs |
| `ui-tester` | UI testing, visual validation, user flow testing | Post-implementation UI verification, interaction testing |
| `qa-test-engineer` | API testing, integration testing, test scripts | API endpoint validation, e2e tests, backend QA |

### Rules for This Workflow

- **Never skip the Project Manager** — even simple-sounding requests may have cross-cutting concerns the PM needs to identify
- The PM enhances each instruction with: acceptance criteria, technical constraints from CLAUDE.md rules, and agent-specific context
- When a task spans multiple agents (e.g., "add project submission flow"), the PM breaks it into separate tasks per agent with clear API contracts between them
- The PM ensures all Project Rules below are reflected in every task it creates

### QA Gate (Mandatory)

Every wave/task must pass QA before being marked complete:

1. **After dev work completes** -> PM dispatches testing:
   - `ui-tester` — validates all UI changes (pages load, interactions work, responsive)
   - `qa-test-engineer` — validates API endpoints, database state, integration flows
2. **Testers report results to PM** with pass/fail status and bug details
3. **If bugs found** -> PM creates bug-fix tasks and dispatches to dev agents
4. **Fix -> re-test cycle** repeats until both testers confirm clean
5. **Only after QA confirms no issues** -> wave/task is marked complete and eligible for commit

## Project Rules

These rules govern ALL work in this repository. Follow them strictly.

### 1. Clean Code with Documentation
Every function, class, and non-trivial block must have clear comments explaining its purpose. Code should be well-structured with each piece of logic contained in its own component/module. Follow single-responsibility principle throughout.

### 2. Minimal External Dependencies
Do not use npm packages for small utilities unless the package saves significant development time **and** is actively maintained with a clear upgrade path. Prefer writing lightweight custom solutions for simple needs.

### 3. Smart Package Choices
When choosing dependencies, ensure they are: well-supported, actively maintained, compatible with the latest framework versions, and necessary for the task. Avoid bloated or abandoned packages.

### 4. PrimeNG as UI Foundation
Use PrimeNG components as the primary UI building blocks. Customize via the PrimeNG theming system (design tokens) to match the PRMS brand. Do not add Angular Material or other UI libraries alongside PrimeNG.

### 5. Structured Logging via Winston
All backend logging goes through the centralized Winston logger. **Rules:**
- **Never use `console.log`** in backend code — always use NestJS `Logger` (which routes through Winston automatically via `app.useLogger()`).
- **Log files** are in `api/logs/` (gitignored): `combined-*.log` (all levels), `error-*.log` (errors only), `http-*.log` (HTTP requests).
- **Request ID tracking**: Every request gets a UUID via `X-Request-ID` header and AsyncLocalStorage — all log entries include the ID.
- **Dev format**: Pretty-printed with colors. **Prod format**: JSON (for log aggregation).
- **Daily rotation**: Log files rotate daily, retained for 30 days, max 20MB per file.

### 6. TypeORM Migrations Only
Database schema changes must always go through TypeORM migrations. `synchronize: false` is enforced. Never modify the schema manually or via synchronize.

### 7. Environment Configuration
Use `@nestjs/config` with typed config files. Never hardcode secrets or environment-specific values. Use `.env.example` as the template — never commit `.env` files.

## PRMS Brand & Theme

The PRMS theme follows the CGIAR risk management tool design:

| Token | Value | Usage |
|-------|-------|-------|
| Primary | `#eb2f64` | Main brand color, primary buttons, active states |
| Primary Light | `#ff3366` | Hover states, highlights |
| Primary Dark | `#ba265d` | Active/pressed states |
| Surface | `#ffffff` | Card backgrounds, content areas |
| Surface Ground | `#faf9f9` | Page background |
| Surface Section | `#f4f2f2` | Section backgrounds |
| Text Color | `#333333` | Primary text |
| Text Secondary | `#777777` | Secondary text, labels |
| Font Family | Poppins, sans-serif | All text |

## Database Entities

(To be defined as features are implemented)

## Build Progress

**Setup: COMPLETE** — Project scaffolded with NestJS API, Angular 21 + PrimeNG, Docker Compose, agent system.
