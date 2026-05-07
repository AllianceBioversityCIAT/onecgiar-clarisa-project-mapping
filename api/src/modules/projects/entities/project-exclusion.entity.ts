import { Column, Entity, ManyToOne, JoinColumn, Unique, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Project } from './project.entity';
import { Center } from '../../reference-data/entities/center.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Records a per-center exclusion of a project.
 *
 * Exclusion is a center-local concept: a center rep (or admin) can mark a
 * project as excluded from their center's default view without touching the
 * project entity itself. Other centers and other roles are unaffected.
 *
 * The UNIQUE constraint on (projectId, centerId) ensures at most one active
 * exclusion exists per (project, center) pair. Re-excluding a project that
 * is already excluded yields a 409 Conflict.
 *
 * When a project or center is deleted the exclusion row cascades away
 * automatically. The actor user row is RESTRICT-protected so the audit trail
 * survives user deactivation (consistent with other actor FK patterns in
 * project_mappings.removal_requested_by).
 */
@Entity('project_exclusions')
@Unique('UQ_project_exclusions_project_center', ['projectId', 'centerId'])
@Index('IDX_project_exclusions_project_id', ['projectId'])
@Index('IDX_project_exclusions_center_id', ['centerId'])
export class ProjectExclusion extends BaseEntity {
  /** FK column for the excluded project. */
  @Column({ name: 'project_id', type: 'int' })
  projectId: number;

  /** The excluded project. */
  @ManyToOne(() => Project, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: Project;

  /** FK column for the center that performed the exclusion. */
  @Column({ name: 'center_id', type: 'int' })
  centerId: number;

  /** The center that performed the exclusion. */
  @ManyToOne(() => Center, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'center_id' })
  center: Center;

  /** FK column for the user who excluded the project. */
  @Column({ name: 'excluded_by_user_id', type: 'int' })
  excludedByUserId: number;

  /** The user who performed the exclusion. */
  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'excluded_by_user_id' })
  excludedBy: User;

  /** Human-readable reason for the exclusion. Required, min 5 chars enforced at DTO. */
  @Column({ type: 'text' })
  reason: string;

  /** Timestamp when the exclusion was created (set explicitly by the service, not auto). */
  @Column({ name: 'excluded_at', type: 'datetime' })
  excludedAt: Date;
}
