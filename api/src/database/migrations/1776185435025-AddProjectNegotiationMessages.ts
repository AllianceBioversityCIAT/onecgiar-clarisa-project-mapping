import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `project_negotiation_messages` table for free-text chat on
 * the project-level consolidated negotiation thread.
 *
 * Unlike `mapping_negotiations` (per-mapping audit log), this table
 * stores messages scoped to a whole project, rendered in the unified
 * event stream alongside mapping audit events.
 *
 * Column types:
 *   - `id` / `project_id` / `actor_id` are `int` to match the existing
 *     schema convention established by `ConvertPkToInt1775744766472`
 *     (all PKs/FKs are `int`, not `bigint`).
 *
 * Deletion semantics:
 *   - `project_id` FK uses `ON DELETE CASCADE` — if a project is
 *     deleted, its chat history goes with it. Matches how other
 *     project-scoped tables (e.g. `project_budgets`, `project_countries`)
 *     behave.
 *   - `actor_id` FK uses `ON DELETE NO ACTION` — users are soft-deleted
 *     via the `is_active` flag, so hard FK breakage is not expected.
 *
 * The generator picked up unrelated drift (index churn on published_*,
 * project_budgets, etc.); that noise has been stripped so this
 * migration only touches the new table. Run `migration:generate` again
 * if you want to capture schema drift as a separate migration.
 */
export class AddProjectNegotiationMessages1776185435025 implements MigrationInterface {
  name = 'AddProjectNegotiationMessages1776185435025';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE \`project_negotiation_messages\` (
         \`id\` int NOT NULL AUTO_INCREMENT,
         \`project_id\` int NOT NULL,
         \`actor_id\` int NOT NULL,
         \`message\` text NOT NULL,
         \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
         INDEX \`IDX_project_negotiation_messages_project_created\`
           (\`project_id\`, \`created_at\`),
         PRIMARY KEY (\`id\`)
       ) ENGINE=InnoDB`,
    );

    await queryRunner.query(
      `ALTER TABLE \`project_negotiation_messages\`
         ADD CONSTRAINT \`FK_project_negotiation_messages_project\`
         FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`)
         ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    await queryRunner.query(
      `ALTER TABLE \`project_negotiation_messages\`
         ADD CONSTRAINT \`FK_project_negotiation_messages_actor\`
         FOREIGN KEY (\`actor_id\`) REFERENCES \`users\`(\`id\`)
         ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`project_negotiation_messages\`
         DROP FOREIGN KEY \`FK_project_negotiation_messages_actor\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`project_negotiation_messages\`
         DROP FOREIGN KEY \`FK_project_negotiation_messages_project\``,
    );
    await queryRunner.query(
      `DROP INDEX \`IDX_project_negotiation_messages_project_created\`
         ON \`project_negotiation_messages\``,
    );
    await queryRunner.query(`DROP TABLE \`project_negotiation_messages\``);
  }
}
