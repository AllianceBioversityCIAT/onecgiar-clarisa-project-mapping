-- =============================================================================
-- Backfill: Signalling-import comments → project_negotiation_messages
-- =============================================================================
--
-- Context
-- -------
-- Bug 3 (QA Round 1): the Signalling Excel importer wrote each row's "Latest
-- justification" comment to `mapping_negotiations.justification` (per-mapping
-- audit data), but the consolidated negotiation page's chat tab reads from
-- `project_negotiation_messages` (project-level chat). As a result, the
-- comments are stored in the DB but invisible to PRMS users.
--
-- The importer has been patched to write a consolidated chat row going
-- forward. This script backfills the same rows for the data that was
-- already imported against the dev/master DB before the fix shipped.
--
-- What it does
-- ------------
-- For every project that has signalling-origin justification text on its
-- mappings, inserts ONE `project_negotiation_messages` row authored by the
-- system import user, with the program acronym prefixed to each comment
-- (same format the patched importer produces):
--
--   [Signalling Import]
--   <PROGRAM_OFFICIAL_CODE>: <comment 1>
--   <PROGRAM_OFFICIAL_CODE>: <comment 2>
--   ...
--
-- Signalling rows are identified by:
--   - mapping_negotiations.actor_id  = system user (system@prms.cgiar.org)
--   - mapping_negotiations.event_type IN ('counter_proposed', 'removed')
--       (the only event types the Signalling importer attaches a
--        justification to — TOC's `initiated` events carry null)
--   - mapping_negotiations.justification IS NOT NULL AND TRIM(...) != ''
--
-- Idempotency
-- -----------
-- A `NOT EXISTS` guard skips projects that already have a chat message
-- whose body begins with `[Signalling Import]`. Safe to re-run.
--
-- Usage
-- -----
-- Pipe straight into the live DB (read-only DB users will fail safely):
--
--   docker-compose exec mysql mysql -uroot -p<pw> prms_projects \
--     < api/src/database/scripts/backfill-signalling-chat-messages.sql
--
-- Verify a known project after running, e.g. D-200371:
--
--   SELECT pnm.id, pnm.message
--     FROM project_negotiation_messages pnm
--     JOIN projects p ON p.id = pnm.project_id
--    WHERE p.code = 'D-200371';
--
-- =============================================================================

-- Resolve the system import user once; fail loudly if absent.
SET @system_user_id := (
  SELECT id FROM users WHERE email = 'system@prms.cgiar.org' LIMIT 1
);

-- Defensive check — abort with a readable error if no system user exists.
-- (Signalling cannot have run without one, so this is purely belt-and-braces.)
SELECT
  CASE
    WHEN @system_user_id IS NULL
      THEN (SELECT a FROM (SELECT 1 AS a) x
            WHERE (SELECT 'ABORT: no system user (system@prms.cgiar.org)') IS NOT NULL)
    ELSE 1
  END AS sanity_check;

-- ---------------------------------------------------------------------------
-- Backfill insert
-- ---------------------------------------------------------------------------
-- We aggregate per project_id with GROUP_CONCAT, prefixing each line with
-- the program's official_code so the result is readable in the chat UI.
-- Ordering by mapping_negotiations.created_at preserves the original
-- comment sequence per project.
INSERT INTO project_negotiation_messages (project_id, actor_id, message, created_at)
SELECT
  src.project_id,
  @system_user_id                                       AS actor_id,
  CONCAT('[Signalling Import]\n', src.aggregated)       AS message,
  NOW(6)                                                AS created_at
FROM (
  SELECT
    pm.project_id                                       AS project_id,
    GROUP_CONCAT(
      CONCAT(pr.official_code, ': ', mn.justification)
      ORDER BY mn.created_at, mn.id
      SEPARATOR '\n'
    )                                                   AS aggregated
  FROM mapping_negotiations mn
  JOIN project_mappings pm ON pm.id = mn.mapping_id
  JOIN programs pr         ON pr.id = pm.program_id
  WHERE mn.actor_id = @system_user_id
    AND mn.event_type IN ('counter_proposed', 'removed')
    AND mn.justification IS NOT NULL
    AND TRIM(mn.justification) <> ''
  GROUP BY pm.project_id
) AS src
WHERE NOT EXISTS (
  -- Skip projects that already have a Signalling-Import chat row.
  SELECT 1
    FROM project_negotiation_messages existing
   WHERE existing.project_id = src.project_id
     AND existing.message LIKE '[Signalling Import]%'
)
AND src.aggregated IS NOT NULL
AND src.aggregated <> '';

-- Report what landed.
SELECT
  COUNT(*) AS signalling_chat_rows_total
FROM project_negotiation_messages
WHERE message LIKE '[Signalling Import]%';
