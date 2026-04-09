import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/**
 * A CGIAR research initiative (program) synced from the CLARISA API.
 *
 * CLARISA refers to these as "initiatives"; within PRMS they are
 * called "programs" for consistency with the domain language.
 */
@Entity('programs')
export class Program extends BaseEntity {
  /** Unique identifier from CLARISA (the initiative `id` field). */
  @Column({ name: 'clarisa_id', type: 'int', unique: true })
  clarisaId: number;

  /** Official code assigned by CLARISA (e.g. "INIT-01"). */
  @Column({ name: 'official_code', type: 'varchar', length: 50 })
  officialCode: string;

  /** Full name of the initiative / program. */
  @Column({ type: 'varchar', length: 255 })
  name: string;

  /** Timestamp of the last successful sync from CLARISA. */
  @Column({ name: 'synced_at', type: 'datetime' })
  syncedAt: Date;
}
