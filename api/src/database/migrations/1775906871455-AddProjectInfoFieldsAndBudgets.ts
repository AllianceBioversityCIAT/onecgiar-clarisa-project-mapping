import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Extends the projects table with 8 optional columns sourced from the
 * CGIAR PRMS 4.1 Project Info CSV, and creates a new 1:N `project_budgets`
 * child table sourced from the 4.3 Project Budget CSV.
 *
 * All 8 new project columns are nullable, so the existing 283 projects
 * remain valid without a backfill. Money columns use decimal(14,2) per
 * the CLAUDE.md project rule.
 *
 * The `project_budgets` table is a new child of `projects` with an
 * ON DELETE CASCADE FK: deleting a project automatically removes its
 * budget lines. This does NOT affect the existing `project_mappings`
 * allocation invariant — that table is untouched by this migration.
 *
 * Reversal (`down`) drops the child table first (because it FKs
 * projects), then drops the 8 columns in reverse order. Existing data
 * in the new columns is lost on rollback, which is acceptable because
 * the data can be re-imported from the source CSVs.
 */
export class AddProjectInfoFieldsAndBudgets1775906871455 implements MigrationInterface {
  name = 'AddProjectInfoFieldsAndBudgets1775906871455';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /* ---------------------------------------------------------------- */
    /* 1. Add 8 optional columns to `projects`. All nullable.            */
    /* ---------------------------------------------------------------- */
    await queryRunner.query(`
      ALTER TABLE \`projects\`
        ADD COLUMN \`funder_primary_center\` varchar(255) NULL AFTER \`funder\`,
        ADD COLUMN \`nature_of_funder\` varchar(60) NULL AFTER \`funder_primary_center\`,
        ADD COLUMN \`category\` varchar(40) NULL AFTER \`nature_of_funder\`,
        ADD COLUMN \`csp\` enum('YES','NO') NULL AFTER \`category\`,
        ADD COLUMN \`csp_non_collection_reason\` varchar(255) NULL AFTER \`csp\`,
        ADD COLUMN \`total_pledge\` decimal(14,2) NULL AFTER \`csp_non_collection_reason\`,
        ADD COLUMN \`principal_investigator\` varchar(255) NULL AFTER \`total_pledge\`,
        ADD COLUMN \`signed_contract_title\` varchar(500) NULL AFTER \`principal_investigator\`
    `);

    /* ---------------------------------------------------------------- */
    /* 2. Create the new `project_budgets` child table.                  */
    /*                                                                   */
    /*    - Int auto-increment PK matching the rest of the schema        */
    /*      (per 1775744766472-ConvertPkToInt).                          */
    /*    - FK project_id ON DELETE CASCADE so orphan budget rows are    */
    /*      impossible — removing a project wipes its budget lines.      */
    /*    - created_at/updated_at timestamps mirror the BaseEntity       */
    /*      convention used by every other table.                        */
    /*    - Index on project_id for fast child lookup in the detail      */
    /*      endpoint's leftJoinAndSelect.                                */
    /*    - Composite (year, version) index for import / reporting       */
    /*      queries that filter on a specific fiscal cycle.              */
    /*    - UNIQUE on external_code (nullable) so the admin importer     */
    /*      can upsert idempotently by the 4.3 CSV row key. MySQL allows */
    /*      multiple NULLs in a UNIQUE index — rows without an external  */
    /*      code (form-entered) will not collide.                        */
    /* ---------------------------------------------------------------- */
    await queryRunner.query(`
      CREATE TABLE \`project_budgets\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        \`project_id\` int NOT NULL,
        \`year\` varchar(10) NOT NULL,
        \`version\` varchar(20) NOT NULL,
        \`account\` varchar(100) NOT NULL,
        \`amount\` decimal(14,2) NOT NULL,
        \`external_code\` varchar(60) NULL,
        PRIMARY KEY (\`id\`),
        INDEX \`idx_pb_project_id\` (\`project_id\`),
        INDEX \`idx_pb_year_version\` (\`year\`, \`version\`),
        UNIQUE INDEX \`uq_pb_external_code\` (\`external_code\`),
        CONSTRAINT \`FK_project_budgets_project\`
          FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`)
          ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    /* Drop the child table first. The FK constraint is removed
     * implicitly when the table is dropped. */
    await queryRunner.query(`DROP TABLE \`project_budgets\``);

    /* Drop the 8 optional columns in reverse order so that each
     * ALTER maintains a well-defined column layout mid-rollback. */
    await queryRunner.query(`
      ALTER TABLE \`projects\`
        DROP COLUMN \`signed_contract_title\`,
        DROP COLUMN \`principal_investigator\`,
        DROP COLUMN \`total_pledge\`,
        DROP COLUMN \`csp_non_collection_reason\`,
        DROP COLUMN \`csp\`,
        DROP COLUMN \`category\`,
        DROP COLUMN \`nature_of_funder\`,
        DROP COLUMN \`funder_primary_center\`
    `);
  }
}
