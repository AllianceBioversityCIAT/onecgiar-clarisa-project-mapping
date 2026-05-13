---
name: chat-vs-audit-thread
description: Two separate tables back the consolidated negotiation page — `mapping_negotiations` (per-mapping audit events) vs `project_negotiation_messages` (project-level chat). Bulk importers must write BOTH if they want their justifications visible in the chat tab.
metadata:
  type: project
---

The consolidated negotiation page splits per-mapping audit events (read from
`mapping_negotiations`) from free-text chat (read from
`project_negotiation_messages`). They are NOT the same data source.

**Why:** Discovered via Bug 3 of QA Round 1 — the Signalling Excel importer
populated `mapping_negotiations.justification` for every `counter_proposed`
/ `removed` event, so the data was technically there, but the UI's chat tab
showed nothing because that tab only reads `project_negotiation_messages`.

**How to apply:** Any importer or bulk-write code path that wants its
free-text justifications visible in the chat tab must ALSO insert a
`project_negotiation_messages` row authored by the system user (id of
`system@prms.cgiar.org`). The patched Signalling importer (see
`importSignallingFromBuffer` in `api/src/modules/import/import.service.ts`)
emits ONE consolidated chat row per project with body
`"[Signalling Import]\n<PROGRAM_CODE>: <comment>\n..."` so all comments
land in one entry. Empty justifications must be skipped — do not insert
blank `[Signalling Import]` placeholders.

Backfill for already-imported data lives at
`api/src/database/scripts/backfill-signalling-chat-messages.sql` (not a
TypeORM migration — it's a data fix, not a schema change). The script is
idempotent via a `NOT EXISTS` guard on existing `[Signalling Import]`
messages.
