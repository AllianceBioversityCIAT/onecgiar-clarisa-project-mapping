---
name: new-migration
description: Scaffold and generate a TypeORM migration for PRMS following project conventions. Use when adding a column, creating/dropping a table, changing a constraint, or any schema change. Enforces CLAUDE.md rule #6 (migrations only, never synchronize).
---

# PRMS new-migration

Wraps TypeORM migration generation with this project's conventions and gotchas.

## When to use

- User asks to "add a column", "change the schema", "create a table", "add an index"
- You're about to modify an entity file in `api/src/modules/*/entities/*.entity.ts`
- User mentions altering any table in the `users`, `projects`, `project_mappings`, `centers`, `programs`, `countries`, `action_areas` domain

## Before writing the migration

1. **Modify the TypeORM entity first** (`api/src/modules/<module>/entities/<name>.entity.ts`). The generator diffs entity state against the DB to produce migration SQL — if the entity doesn't change, generation produces nothing.

2. **Check existing migrations** in `api/src/database/migrations/` to match the naming/style of recent work:
   ```
   <timestamp>-<PascalCaseDescription>.ts
   ```

3. **Verify DB is up-to-date** — run `npm run migration:run` from `api/` so the generator diffs against the current schema, not a stale one.

## Generate the migration

From `api/`:
```bash
npm run migration:generate -- src/database/migrations/<DescriptiveName>
```

Example names:
- `AddRemainingBudgetToProjects`
- `CreateProjectMappingsTable`
- `DropLegacyFundingSourceColumn`

## PRMS-specific rules — check the generated SQL

1. **Money columns**: always `decimal(10,2)`, NEVER `float` / `double` / `numeric`.
2. **`synchronize: false`** is enforced in `data-source.ts` — do NOT change that.
3. **Timestamps** follow base-entity conventions (`created_at`, `updated_at`, `deleted_at` — snake_case in DB, camelCase in entity).
4. **Foreign keys** — every FK should specify `onDelete` explicitly (`CASCADE`, `SET NULL`, or `RESTRICT`). Never rely on default.
5. **Enums** — use MySQL `enum` type with explicit values, not a string column. Keep the enum values in sync with the TS enum.
6. **Indexes** — add `@Index()` to any column used in `WHERE` / `ORDER BY` / `JOIN` in repository code. Especially: `project.code`, `project.status`, `project_mappings.project_id`, `project_mappings.program_id`.
7. **Unique constraints** — `project_mappings` must keep `UNIQUE(project_id, program_id)` (critical for allocation invariant).
8. **`NOT NULL` on new columns of existing tables** — either provide a default, or split into two migrations (add nullable → backfill → alter to NOT NULL). Never add a NOT NULL column without a backfill strategy.

## After generation

1. **Read the generated file** and sanity-check the `up()` SQL against the rules above.
2. **Write a matching `down()` method** — the generator usually does this, but verify it actually reverses `up()`.
3. **Run it locally**: `npm run migration:run` from `api/` — should apply cleanly against the dev DB.
4. **Test rollback**: `npm run migration:revert` — should revert cleanly. Re-run to leave DB in migrated state.
5. **If using the MySQL MCP**, query the affected table(s) to confirm schema matches expectations:
   ```sql
   DESCRIBE <table_name>;
   SHOW INDEX FROM <table_name>;
   ```

## Don't

- Don't modify schema via phpMyAdmin or raw SQL and skip the migration
- Don't edit migrations that have already been run in shared environments — create a new migration instead
- Don't use `synchronize: true` even temporarily
- Don't commit a migration without testing both `up` and `down`
