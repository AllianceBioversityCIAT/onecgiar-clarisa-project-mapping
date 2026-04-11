import { Column, Entity, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { MappingStatus } from '../enums/mapping-status.enum';
import { Rating } from '../enums/rating.enum';
import { Project } from '../../projects/entities/project.entity';
import { Program } from '../../reference-data/entities/program.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Represents a mapping between a project and a program (initiative).
 *
 * Program representatives create mappings to claim an allocation
 * percentage of a project for their program. Center representatives
 * review (approve or reject) these mappings. The total allocation
 * across all non-rejected mappings for a project must not exceed 100%.
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

  /** The program claiming allocation on the project. */
  @ManyToOne(() => Program, { nullable: false })
  @JoinColumn({ name: 'program_id' })
  program: Program;

  /** Percentage of the project allocated to this program (1.00–100.00). */
  @Column({
    name: 'allocation_percentage',
    type: 'decimal',
    precision: 5,
    scale: 2,
  })
  allocationPercentage: number;

  /** How well the project complements the program's objectives. */
  @Column({
    name: 'complementarity_rating',
    type: 'enum',
    enum: Rating,
    nullable: true,
  })
  complementarityRating: Rating | null;

  /** How efficiently resources are shared between project and program. */
  @Column({
    name: 'efficiency_rating',
    type: 'enum',
    enum: Rating,
    nullable: true,
  })
  efficiencyRating: Rating | null;

  /** Current review status of this mapping. */
  @Column({
    type: 'enum',
    enum: MappingStatus,
    default: MappingStatus.PENDING,
  })
  status: MappingStatus;

  /** Reason provided by the center rep when rejecting a mapping. */
  @Column({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason: string | null;

  /** FK column for the user who submitted this mapping. */
  @Column({ name: 'submitted_by', type: 'int' })
  submittedById: number;

  /** The program representative who submitted this mapping. */
  @ManyToOne(() => User, { nullable: false })
  @JoinColumn({ name: 'submitted_by' })
  submittedBy: User;

  /** Timestamp when the mapping was submitted. */
  @Column({ name: 'submitted_at', type: 'datetime' })
  submittedAt: Date;

  /** FK column for the user who reviewed this mapping. */
  @Column({ name: 'reviewed_by', type: 'int', nullable: true })
  reviewedById: number | null;

  /** The center representative who reviewed this mapping. */
  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'reviewed_by' })
  reviewedBy: User | null;

  /** Timestamp when the mapping was reviewed (approved or rejected). */
  @Column({ name: 'reviewed_at', type: 'datetime', nullable: true })
  reviewedAt: Date | null;
}
