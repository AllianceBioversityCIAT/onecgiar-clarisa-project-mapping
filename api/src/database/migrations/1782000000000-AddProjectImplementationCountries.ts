import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a second M2M between `projects` and `countries` to capture the
 * **Country of Implementation** — the country (or countries) where the
 * project is physically delivered. This is independent of
 * `project_countries` (which is the Location of Benefit / beneficiary
 * geography) and is NOT affected by the project's `is_global` flag:
 * even a globally beneficial project can have a finite set of
 * implementation countries.
 *
 * Schema mirrors `project_countries` exactly (composite PK, both FKs
 * CASCADE) for consistency.
 */
export class AddProjectImplementationCountries1782000000000
  implements MigrationInterface
{
  name = 'AddProjectImplementationCountries1782000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`project_implementation_countries\` (
        \`project_id\` int NOT NULL,
        \`country_id\` int NOT NULL,
        PRIMARY KEY (\`project_id\`, \`country_id\`),
        KEY \`IDX_project_impl_countries_project_id\` (\`project_id\`),
        KEY \`IDX_project_impl_countries_country_id\` (\`country_id\`),
        CONSTRAINT \`FK_project_impl_countries_project\` FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT \`FK_project_impl_countries_country\` FOREIGN KEY (\`country_id\`) REFERENCES \`countries\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE \`project_implementation_countries\``);
  }
}
