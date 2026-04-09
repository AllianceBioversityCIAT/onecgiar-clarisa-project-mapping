import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/**
 * A CGIAR action area synced from the CLARISA API.
 *
 * Action areas represent the broad strategic areas under which
 * research initiatives are categorized.
 */
@Entity('action_areas')
export class ActionArea extends BaseEntity {
  /** Unique identifier from CLARISA. */
  @Column({ name: 'clarisa_id', type: 'int', unique: true })
  clarisaId: number;

  /** Name of the action area. */
  @Column({ type: 'varchar', length: 255 })
  name: string;

  /** Detailed description of the action area's scope. */
  @Column({ type: 'text' })
  description: string;

  /** Display color associated with this action area. */
  @Column({ type: 'varchar', length: 50 })
  color: string;

  /** Timestamp of the last successful sync from CLARISA. */
  @Column({ name: 'synced_at', type: 'datetime' })
  syncedAt: Date;
}
