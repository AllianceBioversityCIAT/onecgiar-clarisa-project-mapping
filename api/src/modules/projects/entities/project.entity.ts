import {
  Column,
  Entity,
  ManyToOne,
  ManyToMany,
  JoinColumn,
  JoinTable,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { ProjectStatus } from '../enums/project-status.enum';
import { FundingSource } from '../enums/funding-source.enum';
import { Center } from '../../reference-data/entities/center.entity';
import { Country } from '../../reference-data/entities/country.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Represents a research project in the PRMS registry.
 *
 * Projects are the central domain entity. Each project belongs to a
 * CGIAR center, may span multiple countries, and tracks budget and
 * funding information.
 */
@Entity('projects')
export class Project extends BaseEntity {
  /** Unique project code, e.g. 'S0003' or 'T-PJ-004023'. */
  @Column({ type: 'varchar', length: 50, unique: true })
  code: string;

  /** Full name of the project. */
  @Column({ type: 'varchar', length: 255 })
  name: string;

  /** Detailed description of the project scope and objectives. */
  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** Executive summary of the project. */
  @Column({ type: 'text', nullable: true })
  summary: string | null;

  /** Key results or expected outcomes. */
  @Column({ type: 'text', nullable: true })
  results: string | null;

  /** Date when the project officially starts. */
  @Column({ name: 'start_date', type: 'date', nullable: true })
  startDate: Date | null;

  /** Date when the project is expected to end. */
  @Column({ name: 'end_date', type: 'date', nullable: true })
  endDate: Date | null;

  /** Total approved budget for the project. */
  @Column({
    name: 'total_budget',
    type: 'decimal',
    precision: 10,
    scale: 2,
    default: 0,
  })
  totalBudget: number;

  /** Remaining unspent budget. */
  @Column({
    name: 'remaining_budget',
    type: 'decimal',
    precision: 10,
    scale: 2,
    default: 0,
  })
  remainingBudget: number;

  /** Source of the project's funding. */
  @Column({
    name: 'funding_source',
    type: 'enum',
    enum: FundingSource,
    nullable: true,
  })
  fundingSource: FundingSource | null;

  /** Name of the funding organization or donor. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  funder: string | null;

  /** Current lifecycle status of the project. */
  @Column({
    type: 'enum',
    enum: ProjectStatus,
    default: ProjectStatus.ACTIVE,
  })
  status: ProjectStatus;

  /** The CGIAR center responsible for the project. */
  @ManyToOne(() => Center, { nullable: false })
  @JoinColumn({ name: 'center_id' })
  center: Center;

  /** FK column for the center. */
  @Column({ name: 'center_id', type: 'varchar', length: 36 })
  centerId: string;

  /** The user who created this project record. */
  @ManyToOne(() => User, { nullable: false })
  @JoinColumn({ name: 'created_by' })
  createdBy: User;

  /** FK column for the creating user. */
  @Column({ name: 'created_by', type: 'varchar', length: 36 })
  createdById: string;

  /** Countries where the project operates. */
  @ManyToMany(() => Country)
  @JoinTable({
    name: 'project_countries',
    joinColumn: { name: 'project_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'country_id', referencedColumnName: 'id' },
  })
  countries: Country[];
}
