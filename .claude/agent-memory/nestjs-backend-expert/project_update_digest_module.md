---
name: update-digest-module
description: Notification of Updates digest email — cron, settings, dashboard-parity status, idempotency. Where the digest producer lives and its gotchas.
metadata:
  type: project
---

"Notification of Updates" digest emails to center reps — a third email producer alongside the two mapping reminders in `api/src/modules/emails/`.

**Surface:** `UpdateDigestService` (`update-digest.service.ts`), `POST /admin/emails/run-update-digest` (admin, force=true), 5 `system_settings` columns (`update_digest_*`), migration `1794000000000`.

**Gates (order matters):** disabled → past `update_digest_end_date` → not-due (interval days since `update_digest_last_run_at`). `force` bypasses ONLY not-due, never the end-date stop. After a ran/forced tick, `SettingsService.markUpdateDigestRun(now)` stamps `last_run_at` (service-managed; PATCH must never set it).

**Why:** mirrors the two existing reminder producers' conventions (cron 09:00, per-center loop, JSON_EXTRACT idempotency on `metadata`, ignores `email_enabled` kill switch).

**How to apply:** "updated project" = ≥1 `mapping_negotiations` row (chat counts — it's stored there too) in the window, joined `mapping_negotiations.mapping_id → project_mappings.id → project_id`. Status label is computed with the SAME raw SQL the dashboard allocation widget uses (`dashboard.service.ts` ~line 585): locked → 'Locked'; (program_agreed=1 AND center_agreed=0 AND status='negotiating') OR removal_requested=1 on any non-removed mapping → 'Awaiting your response'; else 'In negotiation'. That query is a raw `manager.createQueryBuilder()` over table names, so snake_case columns are correct there (camelCase rule only applies to entity QBs like `resolveRecipients`).

Idempotency key: template `center_update_digest` + `metadata.digestDate` (todayIso) + `metadata.centerId`. Related: [[project_security_hardening]] (throttler/serialization conventions).
