import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * Singleton entity storing application-wide settings managed by the
 * admin Settings page.
 *
 * Only ever a single row, enforced at the database level by the
 * `CHECK (id = 1)` constraint added in migration
 * `1780000000000-AddSystemSettings`.
 *
 * Fields:
 *  - `emailEnabled`     – placeholder flag for the (not-yet-built) email module.
 *  - `deadlineEnabled`  – whether a soft mapping deadline is currently in force.
 *  - `deadlineDate`     – the deadline itself, stored as a SQL `DATE`. We
 *                         keep it as a plain `YYYY-MM-DD` string in the
 *                         application layer to avoid timezone drift
 *                         (a JS `Date` would be parsed as local midnight,
 *                         which can shift the day across DST boundaries).
 *  - `updatedAt`        – auto-maintained by MySQL's `ON UPDATE` clause
 *                         on the column default; we do not need to set
 *                         it manually.
 *  - `updatedBy`        – the user who last modified the settings. Nullable
 *                         (no FK eager-load) so the singleton survives a
 *                         user deletion (FK uses `ON DELETE SET NULL`).
 */
@Entity('system_settings')
export class SystemSettings {
  /**
   * Always `1`. Enforced both as a default and via a CHECK constraint at
   * the DB level, so consumers can safely look the row up with
   * `findOne({ where: { id: 1 } })`.
   */
  @PrimaryColumn({ type: 'tinyint', unsigned: true })
  id: number;

  /** Whether outbound email notifications are enabled. */
  @Column({ name: 'email_enabled', type: 'boolean', default: false })
  emailEnabled: boolean;

  /** Whether the mapping-completion deadline is currently active. */
  @Column({ name: 'deadline_enabled', type: 'boolean', default: false })
  deadlineEnabled: boolean;

  /**
   * Mapping-completion deadline (date only, no time component).
   *
   * Stored as a string in the `YYYY-MM-DD` format to avoid the
   * timezone shifts you get when MySQL `DATE` columns are hydrated
   * into a JS `Date` (which then serialises as the previous day in
   * earlier timezones). Nullable when `deadlineEnabled` is `false`.
   */
  @Column({
    name: 'deadline_date',
    type: 'date',
    nullable: true,
    transformer: {
      // From DB → service. TypeORM returns either a `Date` object or
      // a string depending on the driver/version; normalise to the
      // first 10 chars (`YYYY-MM-DD`) regardless.
      from: (value: Date | string | null): string | null => {
        if (value === null || value === undefined) return null;
        if (value instanceof Date) {
          // Use UTC accessors so we never lose a day in negative offsets.
          const yyyy = value.getUTCFullYear();
          const mm = String(value.getUTCMonth() + 1).padStart(2, '0');
          const dd = String(value.getUTCDate()).padStart(2, '0');
          return `${yyyy}-${mm}-${dd}`;
        }
        return String(value).slice(0, 10);
      },
      // From service → DB. We accept either a string or null; pass-through.
      to: (value: string | null | undefined): string | null =>
        value === undefined || value === null ? null : value,
    },
  })
  deadlineDate: string | null;

  /**
   * Timestamp of the last write. Maintained automatically by MySQL via
   * the column's `ON UPDATE CURRENT_TIMESTAMP(6)` clause set up in the
   * migration. We map it as an `UpdateDateColumn` so TypeORM exposes
   * the value, but we never assign to it from the service.
   */
  @UpdateDateColumn({
    name: 'updated_at',
    type: 'datetime',
    precision: 6,
  })
  updatedAt: Date;

  /**
   * User who last modified the settings. Loaded only when explicitly
   * requested (no eager-load) to keep `getSettings()` cheap.
   */
  @ManyToOne(() => User, { nullable: true, eager: false })
  @JoinColumn({ name: 'updated_by' })
  updatedBy: User | null;

  /** FK column for {@link updatedBy}. Nullable to allow the seed row. */
  @Column({ name: 'updated_by', type: 'int', nullable: true })
  updatedById: number | null;
}
