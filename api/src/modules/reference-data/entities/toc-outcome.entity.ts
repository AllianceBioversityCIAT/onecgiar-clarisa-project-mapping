import {
  Column,
  Entity,
  Index,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Program } from './program.entity';
import { TocAow } from './toc-aow.entity';

/**
 * Discriminator for the two TOC outcome flavours we ingest.
 *
 *  - `intermediate` — source `category=OUTCOME` (intermediate outcomes).
 *  - `portfolio`    — source `category=EOI` (2030 portfolio outcomes).
 */
export enum TocOutcomeType {
  INTERMEDIATE = 'intermediate',
  PORTFOLIO = 'portfolio',
}

/**
 * Outcome node synced from the TOC API.
 *
 * Backed by both `category=OUTCOME` (intermediate outcomes) and
 * `category=EOI` (2030 portfolio outcomes) — they share the same
 * graph shape and are distinguished by the {@link TocOutcomeType}
 * column.
 */
@Entity('toc_outcomes')
@Index('UQ_toc_outcomes_program_node', ['programId', 'nodeId'], {
  unique: true,
})
@Index('IDX_toc_outcomes_program', ['programId'])
@Index('IDX_toc_outcomes_aow', ['aowId'])
export class TocOutcome extends BaseEntity {
  /** Stable per-program identifier (`related_node_id ?? id`). */
  @Column({ name: 'node_id', type: 'varchar', length: 36 })
  nodeId: string;

  /** Display title (e.g. "HLO4.AOW1.IO1 Foster motivations"). */
  @Column({ type: 'varchar', length: 500, nullable: true })
  title: string | null;

  /** Long-form description from the TOC graph. */
  @Column({ type: 'text', nullable: true })
  description: string | null;

  /**
   * Whether this row came from `OUTCOME` (intermediate) or `EOI`
   * (2030 portfolio outcome). Required so the consuming UI can
   * keep the two strata visually distinct.
   */
  @Column({
    name: 'outcome_type',
    type: 'enum',
    enum: TocOutcomeType,
  })
  outcomeType: TocOutcomeType;

  /** Cross-link to whatever node this feeds into. */
  @Column({
    name: 'related_node_id',
    type: 'varchar',
    length: 36,
    nullable: true,
  })
  relatedNodeId: string | null;

  /**
   * Legacy single-parent AOW FK.
   *
   * @deprecated Outcomes are now multi-AOW — read {@link aows} (the
   * `toc_outcome_aows` junction) instead. The sync service keeps this
   * column populated with the FIRST AOW in the resolved union purely
   * for rollback safety; no current code path SHOULD rely on it.
   */
  @Column({ name: 'aow_id', type: 'int', nullable: true })
  aowId: number | null;

  /**
   * @deprecated See {@link aowId}. Use {@link aows} for the real
   * multi-parent mapping.
   */
  @ManyToOne(() => TocAow, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'aow_id' })
  aow: TocAow | null;

  /**
   * All AOWs this outcome belongs to.
   *
   * Outcomes can legitimately have multiple parent AOWs — the
   * upstream TOC graph encodes them either on the outcome's `group`
   * field OR (commonly) as inbound LINK edges from OUTPUT nodes whose
   * own `group` IS the AOW. The sync service unions both sources into
   * the `toc_outcome_aows` junction.
   *
   * Empty array is valid (truly unparented outcomes). The TOC
   * Contribution picker treats those as universally available so they
   * don't become unreachable from the UI.
   */
  @ManyToMany(() => TocAow)
  @JoinTable({
    name: 'toc_outcome_aows',
    joinColumn: { name: 'outcome_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'aow_id', referencedColumnName: 'id' },
  })
  aows: TocAow[];

  /** Program (initiative) this outcome belongs to. */
  @Column({ name: 'program_id', type: 'int' })
  programId: number;

  @ManyToOne(() => Program, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'program_id' })
  program: Program;

  /** Timestamp of the last successful sync from the TOC API. */
  @Column({ name: 'synced_at', type: 'datetime' })
  syncedAt: Date;
}
