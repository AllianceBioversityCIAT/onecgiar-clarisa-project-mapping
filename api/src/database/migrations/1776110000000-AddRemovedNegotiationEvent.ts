import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds 'removed' value to the mapping_negotiations.event_type enum,
 * so removal events are recorded in the conversation history with a justification.
 */
export class AddRemovedNegotiationEvent1776110000000 implements MigrationInterface {
  name = 'AddRemovedNegotiationEvent1776110000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE mapping_negotiations
        MODIFY COLUMN event_type ENUM('initiated','counter_proposed','agreed','reopened','removed') NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM mapping_negotiations WHERE event_type = 'removed'
    `);
    await queryRunner.query(`
      ALTER TABLE mapping_negotiations
        MODIFY COLUMN event_type ENUM('initiated','counter_proposed','agreed','reopened') NOT NULL
    `);
  }
}
