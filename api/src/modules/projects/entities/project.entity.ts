import {
  Column,
  Entity,
  ManyToOne,
  ManyToMany,
  OneToMany,
  JoinColumn,
  JoinTable,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { ProjectStatus } from '../enums/project-status.enum';
import { FundingSource } from '../enums/funding-source.enum';
import { NatureOfFunder } from '../enums/nature-of-funder.enum';
import { ProjectCategory } from '../enums/project-category.enum';
import { CspFlag } from '../enums/csp-flag.enum';
import { In2026 } from '../enums/in-2026.enum';
import { Center } from '../../reference-data/entities/center.entity';
import { Country } from '../../reference-data/entities/country.entity';
import { User } from '../../users/entities/user.entity';
import { ProjectBudget } from './project-budget.entity';

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
  @Column({ type: 'varchar', length: 500 })
  name: string;

  /** Detailed description of the project scope and objectives. */
  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** Executive summary of the project. */
  @Column({ type: 'text', nullable: true })
  summary: string | null;

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

  /**
   * Whether project-level negotiation is locked. When true, no further
   * mapping changes (proposals, counter-proposals, agreements) are
   * permitted. Decoupled from per-mapping status so the lock can be
   * toggled independently of individual mapping lifecycles.
   */
  @Column({
    name: 'negotiation_locked',
    type: 'boolean',
    default: false,
  })
  negotiationLocked: boolean;

  /**
   * Whether the project has no country-specific scope (spans every
   * geography). When true, the project's countries relation must be
   * empty — the service layer enforces this invariant on create /
   * update / import. Drives UI (the form hides the countries selector)
   * and importer behaviour (TOC `Location = Global` flips this flag).
   */
  @Column({
    name: 'is_global',
    type: 'boolean',
    default: false,
  })
  isGlobal: boolean;

  /** The CGIAR center responsible for the project. */
  @ManyToOne(() => Center, { nullable: false })
  @JoinColumn({ name: 'center_id' })
  center: Center;

  /** FK column for the center. */
  @Column({ name: 'center_id', type: 'int' })
  centerId: number;

  /** The user who created this project record. */
  @ManyToOne(() => User, { nullable: false })
  @JoinColumn({ name: 'created_by' })
  createdBy: User;

  /** FK column for the creating user. */
  @Column({ name: 'created_by', type: 'int' })
  createdById: number;

  /** Countries where the project operates. */
  @ManyToMany(() => Country)
  @JoinTable({
    name: 'project_countries',
    joinColumn: { name: 'project_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'country_id', referencedColumnName: 'id' },
  })
  countries: Country[];

  /* ------------------------------------------------------------------ */
  /* Optional fields sourced from the CGIAR PRMS 4.1 Project Info CSV.  */
  /* All eight columns are nullable so existing rows remain valid       */
  /* without a backfill. See migration                                  */
  /* AddProjectInfoFieldsAndBudgets for the schema details.             */
  /* ------------------------------------------------------------------ */

  /** Funder of the primary CGIAR center (distinct from `funder`). */
  @Column({
    name: 'funder_primary_center',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  funderPrimaryCenter: string | null;

  /** Nature of the funding organization (app-level enum as varchar). */
  @Column({
    name: 'nature_of_funder',
    type: 'varchar',
    length: 60,
    nullable: true,
  })
  natureOfFunder: NatureOfFunder | null;

  /** Funding category — Restricted or Unrestricted. */
  @Column({
    name: 'category',
    type: 'varchar',
    length: 40,
    nullable: true,
  })
  category: ProjectCategory | null;

  /** Whether the project collects a Cost Sharing Percentage. */
  @Column({
    name: 'csp',
    type: 'enum',
    enum: CspFlag,
    nullable: true,
  })
  csp: CspFlag | null;

  /** Reason CSP is not collected (only applicable when csp = NO). */
  @Column({
    name: 'csp_non_collection_reason',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  cspNonCollectionReason: string | null;

  /** Total pledged amount (distinct from total_budget). */
  @Column({
    name: 'total_pledge',
    type: 'decimal',
    precision: 14,
    scale: 2,
    nullable: true,
  })
  totalPledge: number | null;

  /** Principal investigator free-text name. */
  @Column({
    name: 'principal_investigator',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  principalInvestigator: string | null;

  /** Signed contract title (full legal title). */
  @Column({
    name: 'signed_contract_title',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  signedContractTitle: string | null;

  /* ------------------------------------------------------------------ */
  /* New Anaplan 2026 fields (sheet "4.1-update5May26"). All nullable.  */
  /* See migration AddAnaplan2026ProjectFields.                         */
  /* ------------------------------------------------------------------ */

  /** Principal-investigator contact email. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  email: string | null;

  /** Actual 2025 expenditure (USD). */
  @Column({
    name: 'exp_2025',
    type: 'decimal',
    precision: 14,
    scale: 2,
    nullable: true,
  })
  exp2025: number | null;

  /**
   * Planned 2026 budget figure from Anaplan (USD).
   *
   * Named `anaplanBudget2026` to avoid shadowing the existing derived
   * `budget2026` value on `ProjectListItem`, which is computed by
   * summing project_budgets fiscal-year rows. The DB column stays
   * `budget_2026` for readability.
   */
  @Column({
    name: 'budget_2026',
    type: 'decimal',
    precision: 14,
    scale: 2,
    nullable: true,
  })
  anaplanBudget2026: number | null;

  /** Actual 2026 expenditure to date (USD). */
  @Column({
    name: 'exp_2026',
    type: 'decimal',
    precision: 14,
    scale: 2,
    nullable: true,
  })
  exp2026: number | null;

  /** Anaplan YES/NO flag — is the project in the 2026 portfolio. */
  @Column({
    name: 'in_2026',
    type: 'enum',
    enum: In2026,
    nullable: true,
  })
  in2026: In2026 | null;

  /**
   * Simulated / canonical 2026 budget. Treated as the authoritative
   * source for `total_budget` by the 4.1 importer; the raw column is
   * kept here for traceability.
   */
  @Column({
    name: 'budget_2026_simulation',
    type: 'decimal',
    precision: 14,
    scale: 2,
    nullable: true,
  })
  budget2026Simulation: number | null;

  /**
   * Fiscal-year budget breakdown (1:N). Loaded explicitly by the detail
   * endpoint via leftJoinAndSelect; not eager so the list endpoint
   * stays lightweight.
   */
  @OneToMany(() => ProjectBudget, (budget) => budget.project, {
    cascade: true,
    eager: false,
  })
  budgets?: ProjectBudget[];
}
