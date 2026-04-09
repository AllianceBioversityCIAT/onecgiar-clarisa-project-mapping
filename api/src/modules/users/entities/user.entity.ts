import { Column, Entity, ManyToOne, JoinColumn } from 'typeorm';
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
   * Excluded from API responses to prevent leaking internal auth identifiers.
   */
  @Exclude()
  @Column({ name: 'cognito_sub', type: 'varchar', length: 255, unique: true })
  cognitoSub: string;

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
  @Column({ name: 'program_id', type: 'varchar', length: 36, nullable: true, default: null })
  programId: string | null;

  /** The center this user is associated with, if any. */
  @ManyToOne(() => Center, { nullable: true })
  @JoinColumn({ name: 'center_id' })
  center: Center | null;

  /** FK column for the user's associated center. */
  @Column({ name: 'center_id', type: 'varchar', length: 36, nullable: true, default: null })
  centerId: string | null;

  /** Whether the user account is active. Defaults to `true`. */
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;
}
