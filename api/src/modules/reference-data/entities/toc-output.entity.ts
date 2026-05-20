import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Program } from './program.entity';
import { TocAow } from './toc-aow.entity';

/**
 * Output node synced from the TOC API (source `category=OUTPUT`).
 *
 * These are the High-Level Outputs (HLOs) that feed into outcomes.
 * Each output belongs to one AOW (via the source `group` field
 * which references the AOW node's raw graph `id`).
 */
@Entity('toc_outputs')
@Index('UQ_toc_outputs_program_node', ['programId', 'nodeId'], {
  unique: true,
})
@Index('IDX_toc_outputs_program', ['programId'])
@Index('IDX_toc_outputs_aow', ['aowId'])
export class TocOutput extends BaseEntity {
  /** Stable per-program identifier (`related_node_id ?? id`). */
  @Column({ name: 'node_id', type: 'varchar', length: 36 })
  nodeId: string;

  /** Display title from the TOC graph. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  title: string | null;

  /** Long-form description from the TOC graph. */
  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** OUTPUT-only categorization (e.g. "Knowledge product"). */
  @Column({
    name: 'type_of_output',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  typeOfOutput: string | null;

  /** Cross-link to whatever node this feeds into. */
  @Column({
    name: 'related_node_id',
    type: 'varchar',
    length: 36,
    nullable: true,
  })
  relatedNodeId: string | null;

  /**
   * Parent AOW. Resolved from the source row's `group` field by
   * looking up the AOW with matching `WP.id` within the same
   * program. Nullable so a missing/empty group does not block the
   * import.
   */
  @Column({ name: 'aow_id', type: 'int', nullable: true })
  aowId: number | null;

  @ManyToOne(() => TocAow, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'aow_id' })
  aow: TocAow | null;

  /** Program (initiative) this output belongs to. */
  @Column({ name: 'program_id', type: 'int' })
  programId: number;

  @ManyToOne(() => Program, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'program_id' })
  program: Program;

  /** Timestamp of the last successful sync from the TOC API. */
  @Column({ name: 'synced_at', type: 'datetime' })
  syncedAt: Date;
}
