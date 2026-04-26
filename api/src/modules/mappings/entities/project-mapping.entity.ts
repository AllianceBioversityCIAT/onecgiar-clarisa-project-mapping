import { Column, Entity, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { MappingStatus } from '../enums/mapping-status.enum';
import { Rating } from '../enums/rating.enum';
import { Project } from '../../projects/entities/project.entity';
import { Program } from '../../reference-data/entities/program.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Represents a mapping between a project and a program.
 *
 * Center representatives create mappings and negotiate allocation
 * percentages with program representatives. Both sides must agree
 * before the center can lock the project round.
 */
@Entity('project_mappings')
@Unique('UQ_project_mappings_project_program', ['projectId', 'programId'])
export class ProjectMapping extends BaseEntity {
  /** FK column for the mapped project. */
  @Column({ name: 'project_id', type: 'int' })
  projectId: number;

  /** The project this mapping belongs to. */
  @ManyToOne(() => Project, { nullable: false })
  @JoinColumn({ name: 'project_id' })
  project: Project;

  /** FK column for the mapped program. */
  @Column({ name: 'program_id', type: 'int' })
  programId: number;

  /** The program being mapped to the project. */
  @ManyToOne(() => Program, { nullable: false })
  @JoinColumn({ name: 'program_id' })
  program: Program;

  /** Percentage of the project allocated to this program (1.00-100.00). */
  @Column({
    name: 'allocation_percentage',
    type: 'decimal',
    precision: 5,
    scale: 2,
  })
  allocationPercentage: number;

  /** How well the project complements the program's objectives (legacy, nullable). */
  @Column({
    name: 'complementarity_rating',
    type: 'enum',
    enum: Rating,
    nullable: true,
  })
  complementarityRating: Rating | null;

  /** How efficiently resources are shared between project and program (legacy, nullable). */
  @Column({
    name: 'efficiency_rating',
    type: 'enum',
    enum: Rating,
    nullable: true,
  })
  efficiencyRating: Rating | null;

  /** Current negotiation status of this mapping. */
  @Column({
    type: 'enum',
    enum: MappingStatus,
    default: MappingStatus.DRAFT,
  })
  status: MappingStatus;

  /** Whether the center rep has agreed to the current terms. */
  @Column({ name: 'center_agreed', type: 'tinyint', width: 1, default: false })
  centerAgreed: boolean;

  /** Whether the program rep has agreed to the current terms. */
  @Column({ name: 'program_agreed', type: 'tinyint', width: 1, default: false })
  programAgreed: boolean;

  /** FK column for the center rep who initiated this mapping. */
  @Column({ name: 'initiated_by', type: 'int' })
  initiatedById: number;

  /** The center representative who initiated this mapping. */
  @ManyToOne(() => User, { nullable: false })
  @JoinColumn({ name: 'initiated_by' })
  initiatedBy: User;

  /** Timestamp when the mapping was initiated. */
  @Column({ name: 'initiated_at', type: 'datetime' })
  initiatedAt: Date;

  /**
   * True when the mapping has been auto-flagged for workflow-admin
   * arbitration (raised on the program rep's 2nd counter-proposal,
   * cleared when both sides agree).
   */
  @Column({
    name: 'needs_assistance',
    type: 'tinyint',
    width: 1,
    default: false,
  })
  needsAssistance: boolean;

  /** Timestamp when the assistance flag was raised; null when cleared. */
  @Column({ name: 'flagged_at', type: 'datetime', nullable: true })
  flaggedAt: Date | null;

  // ── Legacy columns (kept for backward compat / data migration) ────

  /** @deprecated Use rejectionReason on negotiation events instead. */
  @Column({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason: string | null;

  /** @deprecated Replaced by initiated_by. */
  @Column({ name: 'submitted_by', type: 'int', nullable: true })
  submittedById: number | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'submitted_by' })
  submittedBy: User | null;

  /** @deprecated Replaced by initiated_at / created_at. */
  @Column({ name: 'submitted_at', type: 'datetime', nullable: true })
  submittedAt: Date | null;

  /** @deprecated No longer used in negotiation model. */
  @Column({ name: 'reviewed_by', type: 'int', nullable: true })
  reviewedById: number | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'reviewed_by' })
  reviewedBy: User | null;

  /** @deprecated No longer used in negotiation model. */
  @Column({ name: 'reviewed_at', type: 'datetime', nullable: true })
  reviewedAt: Date | null;
}
