import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes `users.cognito_sub` nullable so administrators can pre-provision
 * user records by email before the person has ever authenticated with
 * Cognito. On first Cognito login, the `upsertFromCognito` flow matches
 * the pending record by email and backfills `cognito_sub`.
 *
 * The UNIQUE index on `cognito_sub` is preserved — MySQL permits multiple
 * `NULL` values under a UNIQUE index, so any number of pending rows can
 * coexist without violating the constraint.
 *
 * Rollback strategy: before re-applying NOT NULL, any rows with a NULL
 * `cognito_sub` are backfilled with a deterministic sentinel of the form
 * `pending-<id>`. This keeps the constraint satisfiable without losing
 * the pending records themselves — they simply become unreachable via
 * Cognito login until manually re-linked, which matches the pre-feature
 * behavior where a real sub was always required.
 *
 * Note: the generator produced a large phantom diff for this change
 * (foreign-key / index name drift across unrelated tables). That diff has
 * been stripped; this migration intentionally contains only the single
 * column change required by the feature spec so rollback is safe and
 * reviewable.
 */
export class MakeCognitoSubNullable1775912366569 implements MigrationInterface {
  name = 'MakeCognitoSubNullable1775912366569';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /* Drop NOT NULL on cognito_sub. The UNIQUE index is unaffected by a
     * CHANGE that only flips nullability, so pre-provisioned rows with
     * NULL coexist safely. */
    await queryRunner.query(
      `ALTER TABLE \`users\` MODIFY \`cognito_sub\` varchar(255) NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    /* Any pre-provisioned rows created while the column was nullable
     * must be filled before NOT NULL can be re-applied. Use a sentinel
     * tied to the row id so the UNIQUE constraint is not violated. */
    await queryRunner.query(
      `UPDATE \`users\` SET \`cognito_sub\` = CONCAT('pending-', \`id\`) WHERE \`cognito_sub\` IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`users\` MODIFY \`cognito_sub\` varchar(255) NOT NULL`,
    );
  }
}
