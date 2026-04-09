import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/**
 * A CGIAR research center synced from the CLARISA API.
 *
 * Centers are the top-level organizational units in the CGIAR system.
 * Each center record mirrors data from CLARISA and is refreshed
 * periodically via the sync mechanism.
 */
@Entity('centers')
export class Center extends BaseEntity {
  /** Unique identifier from CLARISA (maps to institutionId). */
  @Column({ name: 'clarisa_id', type: 'int', unique: true })
  clarisaId: number;

  /** Short code assigned by CLARISA (e.g. "CENTER-01"). */
  @Column({ type: 'varchar', length: 50 })
  code: string;

  /** Full name of the center. */
  @Column({ type: 'varchar', length: 255 })
  name: string;

  /** Standard acronym (e.g. "CIAT", "IRRI"). */
  @Column({ type: 'varchar', length: 50 })
  acronym: string;

  /** CLARISA institution identifier. */
  @Column({ name: 'institution_id', type: 'int' })
  institutionId: number;

  /** Timestamp of the last successful sync from CLARISA. */
  @Column({ name: 'synced_at', type: 'datetime' })
  syncedAt: Date;
}
