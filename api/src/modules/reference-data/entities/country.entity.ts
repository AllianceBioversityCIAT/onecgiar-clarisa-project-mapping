import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/**
 * A country record synced from the CLARISA API.
 *
 * Stores ISO codes, name, and the region extracted from the
 * CLARISA `regionDTO.name` field.
 */
@Entity('countries')
export class Country extends BaseEntity {
  /** Numeric country code from CLARISA (the `code` field). */
  @Column({ name: 'clarisa_id', type: 'int', unique: true })
  clarisaId: number;

  /** ISO 3166-1 alpha-2 code (e.g. "US"). */
  @Column({ name: 'iso_alpha_2', type: 'varchar', length: 2 })
  isoAlpha2: string;

  /** ISO 3166-1 alpha-3 code (e.g. "USA"). */
  @Column({ name: 'iso_alpha_3', type: 'varchar', length: 3 })
  isoAlpha3: string;

  /** Full country name. */
  @Column({ type: 'varchar', length: 255 })
  name: string;

  /** Region name extracted from CLARISA regionDTO. */
  @Column({ type: 'varchar', length: 255 })
  region: string;

  /** Timestamp of the last successful sync from CLARISA. */
  @Column({ name: 'synced_at', type: 'datetime' })
  syncedAt: Date;
}
