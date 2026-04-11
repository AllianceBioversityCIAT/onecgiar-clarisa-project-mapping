import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Project } from './project.entity';

/**
 * Represents a single fiscal-year budget line attached to a project.
 *
 * One project may have many budget lines (1:N). Each line captures the
 * fiscal year code, version, account label, and amount sourced from the
 * CGIAR PRMS 4.3 Project Budget CSV. `externalCode` holds the original
 * row key from the CSV so the admin importer can remain idempotent on
 * re-runs.
 */
@Entity('project_budgets')
export class ProjectBudget extends BaseEntity {
  /** The parent project this budget line belongs to. */
  @ManyToOne(() => Project, (project) => project.budgets, {
    eager: false,
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'project_id' })
  project: Project;

  /** FK column for the parent project. */
  @Index('idx_pb_project_id')
  @Column({ name: 'project_id', type: 'int' })
  projectId: number;

  /** Fiscal year code, e.g. "FY26". */
  @Column({ type: 'varchar', length: 10 })
  year: string;

  /** Budget version label, e.g. "FPC-I". */
  @Column({ type: 'varchar', length: 20 })
  version: string;

  /** Account label (CLARISA taxonomy), e.g. "Cost Sharing Percentage (CSP)". */
  @Column({ type: 'varchar', length: 100 })
  account: string;

  /** Budget amount in the project currency. Money rule: decimal(14,2). */
  @Column({ type: 'decimal', precision: 14, scale: 2 })
  amount: number;

  /** External identifier from the 4.3 CSV, used for idempotent re-import. */
  @Column({
    name: 'external_code',
    type: 'varchar',
    length: 60,
    nullable: true,
    unique: true,
  })
  externalCode: string | null;
}
