import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `emails` table that backs the admin Email Management
 * module (queue viewer + retry UI).
 *
 * Scope of this migration is schema only — the cron worker, send
 * mechanism, and any callers of `enqueue()` are explicitly out of
 * scope for this slice (see `.claude/plans/email-management.md`).
 *
 * Design notes:
 *  - **`id` is `BIGINT UNSIGNED`** to mirror the high-volume,
 *    append-only pattern used by `project_audit_events`-style tables.
 *    The user-facing `users.id` PK is `INT`, so both FK columns
 *    (`to_user_id`, `created_by_user_id`) are `INT` to match the
 *    referenced column width.
 *  - **`to_email VARCHAR(320)`** denormalizes the recipient address
 *    at enqueue time. 320 chars is the RFC 5321 maximum. The address
 *    must survive the recipient user being renamed or deactivated,
 *    so it is stored separately from the FK.
 *  - **`body MEDIUMTEXT`** (16 MB) rather than `TEXT` (64 KB) so
 *    HTML bodies with inline tables or images cannot silently
 *    truncate.
 *  - **Single `body` column + `body_format` enum** rather than two
 *    columns (`body_text` / `body_html`). PRMS emails will be HTML
 *    transactional content; if a plain-text fallback is ever needed
 *    an additive `body_text` ALTER is safe and cheap.
 *  - **`status` enum: `queued` / `sending` / `sent` / `failed`** —
 *    the four states the future worker needs: initial, leased,
 *    terminal success, terminal failure (retry-eligible).
 *  - **`priority TINYINT UNSIGNED DEFAULT 5`** — lower value = higher
 *    priority. Worker sorts `ORDER BY priority ASC, queued_at ASC`.
 *  - **`attempts` is not reset on admin Retry** — retry only flips
 *    `status` back to `queued`, clears `last_error`, and sets
 *    `next_attempt_at = NOW()`. Keeping the counter prevents
 *    inadvertent infinite-retry loops on persistently failing rows.
 *  - **`locked_at` / `locked_by`** support worker leasing for
 *    at-most-once delivery across multiple worker instances. The
 *    worker poll releases stale leases via
 *    `locked_at < NOW() - INTERVAL 5 MINUTE`.
 *  - **`next_attempt_at`** drives exponential backoff. NULL means
 *    "pick me up immediately"; the poll checks
 *    `next_attempt_at IS NULL OR next_attempt_at <= NOW()`.
 *  - **`template_key` and `metadata`** are forward-compat hooks for
 *    a future template engine and arbitrary structured payload from
 *    enqueuing modules. Both NULL in this slice.
 *
 * Indexes:
 *  - `IDX_emails_status_next_attempt (status, next_attempt_at)` —
 *    the worker's poll index. `status` is the leading prefix so
 *    admin filters by status alone also use it.
 *  - `IDX_emails_to_user_id (to_user_id)` — supports the admin
 *    "emails to user X" filter and FK JOIN for display names.
 *  - `IDX_emails_queued_at (queued_at)` — supports the admin list
 *    default sort (DESC) and the worker's secondary `ORDER BY`.
 *
 * FK behaviour mirrors `system_settings.updated_by`:
 *  - `to_user_id` ON DELETE SET NULL ON UPDATE CASCADE — emails
 *    outlive users; deleting a user must not destroy the audit
 *    trail of what was sent to them.
 *  - `created_by_user_id` ON DELETE SET NULL ON UPDATE CASCADE —
 *    same reasoning for the enqueuer.
 *
 * `down()` drops the FKs explicitly first (MySQL requirement) and
 * then drops the table. The email queue history is intentionally
 * unrecoverable on rollback — this is consistent with the audit
 * log migrations in this project.
 */
export class AddEmailsTable1781000000000 implements MigrationInterface {
  name = 'AddEmailsTable1781000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Create the table with all columns and the three supporting
    //    indexes inline. Enum definitions are declared inline so the
    //    set of allowed values is visible alongside the column.
    await queryRunner.query(`
      CREATE TABLE \`emails\` (
        \`id\`                 BIGINT UNSIGNED                   NOT NULL AUTO_INCREMENT,
        \`to_user_id\`         INT                               NULL,
        \`to_email\`           VARCHAR(320)                      NOT NULL,
        \`subject\`            VARCHAR(500)                      NOT NULL,
        \`body\`               MEDIUMTEXT                        NOT NULL,
        \`body_format\`        ENUM('text','html')               NOT NULL DEFAULT 'html',
        \`status\`             ENUM('queued','sending','sent','failed') NOT NULL DEFAULT 'queued',
        \`priority\`           TINYINT UNSIGNED                  NOT NULL DEFAULT 5,
        \`attempts\`           INT UNSIGNED                      NOT NULL DEFAULT 0,
        \`max_attempts\`       INT UNSIGNED                      NOT NULL DEFAULT 5,
        \`last_error\`         TEXT                              NULL,
        \`locked_at\`          DATETIME(6)                       NULL,
        \`locked_by\`          VARCHAR(100)                      NULL,
        \`next_attempt_at\`    DATETIME(6)                       NULL,
        \`sent_at\`            DATETIME(6)                       NULL,
        \`queued_at\`          DATETIME(6)                       NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`created_by_user_id\` INT                               NULL,
        \`template_key\`       VARCHAR(100)                      NULL,
        \`metadata\`           JSON                              NULL,
        \`created_at\`         DATETIME(6)                       NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\`         DATETIME(6)                       NOT NULL
                                                                  DEFAULT CURRENT_TIMESTAMP(6)
                                                                  ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`),
        INDEX \`IDX_emails_status_next_attempt\` (\`status\`, \`next_attempt_at\`),
        INDEX \`IDX_emails_to_user_id\` (\`to_user_id\`),
        INDEX \`IDX_emails_queued_at\` (\`queued_at\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // 2. FK for the recipient user. SET NULL on delete so an email's
    //    audit trail survives the recipient being removed.
    await queryRunner.query(`
      ALTER TABLE \`emails\`
        ADD CONSTRAINT \`FK_emails_to_user\`
        FOREIGN KEY (\`to_user_id\`) REFERENCES \`users\`(\`id\`)
        ON DELETE SET NULL ON UPDATE CASCADE
    `);

    // 3. FK for the enqueuer. Same SET NULL semantics — losing the
    //    "queued by" attribution is preferable to losing the row.
    await queryRunner.query(`
      ALTER TABLE \`emails\`
        ADD CONSTRAINT \`FK_emails_created_by_user\`
        FOREIGN KEY (\`created_by_user_id\`) REFERENCES \`users\`(\`id\`)
        ON DELETE SET NULL ON UPDATE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop the FKs explicitly before the table — MySQL requires this
    // even though DROP TABLE would cascade, because some MySQL
    // versions / configurations refuse the table drop while FKs are
    // still listed in information_schema.
    await queryRunner.query(`
      ALTER TABLE \`emails\`
        DROP FOREIGN KEY \`FK_emails_created_by_user\`
    `);

    await queryRunner.query(`
      ALTER TABLE \`emails\`
        DROP FOREIGN KEY \`FK_emails_to_user\`
    `);

    // Indexes are dropped implicitly with the table.
    await queryRunner.query(`DROP TABLE \`emails\``);
  }
}
