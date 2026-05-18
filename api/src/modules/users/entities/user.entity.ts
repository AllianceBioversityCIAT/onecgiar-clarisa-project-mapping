import {
  Column,
  Entity,
  ManyToOne,
  JoinColumn,
  ManyToMany,
  JoinTable,
} from 'typeorm';
import { Exclude } from 'class-transformer';
import { BaseEntity } from '../../../common/entities/base.entity';
import { UserRole } from '../enums/user-role.enum';
import { Program } from '../../reference-data/entities/program.entity';
import { Center } from '../../reference-data/entities/center.entity';

/**
 * Represents an application user.
 *
 * Users are created automatically on first login via AWS Cognito.
 * The `role` field is **not** sourced from Cognito -- an administrator
 * assigns a role through the Users management page. Until a role is
 * assigned the value remains `null`.
 *
 * `programId` and `centerId` reference the Programs and Centers tables
 * synced from CLARISA.
 */
@Entity('users')
export class User extends BaseEntity {
  /**
   * AWS Cognito `sub` claim -- immutable unique identifier for the Cognito user.
   *
   * Nullable to support admin pre-provisioning: an administrator can create
   * a user by email before they have ever logged in. On first Cognito login
   * the `upsertFromCognito` flow matches the pending record by email and
   * backfills this column. MySQL allows multiple NULL values under a UNIQUE
   * index, so pre-provisioned users coexist safely.
   *
   * Excluded from API responses to prevent leaking internal auth identifiers.
   */
  @Exclude()
  @Column({
    name: 'cognito_sub',
    type: 'varchar',
    length: 255,
    nullable: true,
    unique: true,
  })
  cognitoSub: string | null;

  /** User email address (unique). */
  @Column({ type: 'varchar', length: 255, unique: true })
  email: string;

  /** User first name. */
  @Column({ name: 'first_name', type: 'varchar', length: 255 })
  firstName: string;

  /** User last name. */
  @Column({ name: 'last_name', type: 'varchar', length: 255 })
  lastName: string;

  /**
   * Role assigned by an administrator.
   * Starts as `null` for new users until an admin assigns one.
   */
  @Column({
    type: 'enum',
    enum: UserRole,
    nullable: true,
    default: null,
  })
  role: UserRole | null;

  /** The program (initiative) this user is associated with, if any. */
  @ManyToOne(() => Program, { nullable: true })
  @JoinColumn({ name: 'program_id' })
  program: Program | null;

  /** FK column for the user's associated program. */
  @Column({ name: 'program_id', type: 'int', nullable: true, default: null })
  programId: number | null;

  /** The center this user is associated with, if any. */
  @ManyToOne(() => Center, { nullable: true })
  @JoinColumn({ name: 'center_id' })
  center: Center | null;

  /** FK column for the user's associated center. */
  @Column({ name: 'center_id', type: 'int', nullable: true, default: null })
  centerId: number | null;

  /**
   * Full set of centers this user belongs to (multi-center membership).
   *
   * Backed by the `user_centers` junction table created in migration
   * `1779000000000-AddUserCentersTable`. Columns are `user_id`, `center_id`,
   * `sort_order` (defaults to 0), and `created_at`.
   *
   * Relationship to {@link centerId} / {@link center}:
   * - `users.center_id` (and the scalar {@link centerId} / `ManyToOne`
   *   {@link center}) remains the user's **primary / default** center
   *   and is unchanged by this relation.
   * - This `centers` array is the **full set** of centers the user is a
   *   member of (including the primary one, which is the row with
   *   `sort_order = 0`). Secondary centers follow in ascending
   *   `sort_order` order.
   *
   * Ordering caveat: TypeORM does **not** enforce `ORDER BY sort_order`
   * automatically on the join table — consumers that need a stable order
   * must add their own `ORDER BY` (handled in `UsersService` in task A-3,
   * not here).
   *
   * `eager: false` — the relation is only loaded when explicitly requested
   * via `relations: ['centers']` or a `leftJoinAndSelect` in a query
   * builder. This keeps Cognito-driven login lookups and other hot-path
   * reads cheap; pages that need the full membership opt in.
   */
  @ManyToMany(() => Center, { eager: false })
  @JoinTable({
    name: 'user_centers',
    joinColumn: { name: 'user_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'center_id', referencedColumnName: 'id' },
  })
  centers: Center[];

  /** Whether the user account is active. Defaults to `true`. */
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;
}
