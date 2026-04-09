---
name: PRMS Projects Registry — Core Project Context
description: Full context on the PRMS Projects Registry build: stack, roles, integrations, data shape, and planning decisions
type: project
---

PRMS Projects Registry replaces an Excel workflow (TOC_Projects.csv — 283 unique projects, 134 multi-program).

**Why:** CGIAR needs structured tracking with role-based workflows replacing ad-hoc Excel coordination.
**How to apply:** Every planning decision should account for multi-program mapping complexity and the 100% allocation constraint.

## Roles
- Admin: full CRUD on projects + system admin
- Program Representative: maps projects to their program with % budget allocation (sum must = 100% per project)
- Center Representative: approves/rejects program mappings with a reason

## Workflow
Admin creates project -> Program Rep maps with % -> Center Rep approves/rejects -> Program Rep can rate Complementarity and Efficiency (High/Medium/Low)

## External Integrations
- CLARISA API (https://api.clarisa.cgiar.org, basic auth): Centers (16), Programs/Initiatives (43), Countries (248), Action Areas (3)
- AWS Cognito (OAuth2): auth redirect to https://localhost:4200/auth

## Data Facts
- 13 unique programs in CSV (but CLARISA has 43 initiatives)
- Funding sources: Window 3, Bilateral, SRV (need normalization)
- Budget allocation is decimal (0.5 = 50%), total per project across all program mappings must = 100%
- Director review field = Center Rep approval (Agree/Disagree in CSV)
- Ratings: Complementarity of Results SI, Efficiencies/Strategic Benefit SI (High/Medium/Low)

## Scaffolding Already Done
- NestJS: @nestjs/config, TypeORM, @nestjs/jwt, passport-jwt, class-validator, winston, uuid — all installed
- Angular 21: primeng, primeflex, primeicons, @primeng/themes — all installed
- auth.config.ts has Cognito fields (COGNITO_API, CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)
- database.config.ts points to prms_projects DB
- app.module.ts has TypeORM forRootAsync wired, synchronize: false
- main.ts is minimal (no global pipes, no cors, no swagger yet — Wave 1 must add these)
- No feature modules exist yet; common/ dirs are empty placeholders
- Frontend: no routes, no feature dirs populated, no guards/interceptors yet
