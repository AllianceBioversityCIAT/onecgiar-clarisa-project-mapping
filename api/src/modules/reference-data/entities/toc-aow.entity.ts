import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Program } from './program.entity';

/**
 * Areas of Work (AOW) node synced from the TOC API.
 *
 * In the TOC graph these are `category=WP` nodes filtered to
 * `wp_type === "AOW"`. The richer metadata lives in the nested
 * `ost_wp` block (acronym, official code, name, CLARISA toc_id);
 * the top-level `id` is the graph-link target used by
 * Output / Outcome `group` references.
 *
 * Storage strategy:
 *  - `node_id` (= the graph node's `id` or its `related_node_id`,
 *    whichever is truthy) is what other rows reference.
 *  - `clarisa_toc_id` (= `ost_wp.toc_id`) is stored separately so
 *    we can correlate to CLARISA / other systems later.
 *  - Uniqueness is `(program_id, node_id)` — AOW graphs are scoped
 *    per program, and the same node may exist in multiple programs.
 */
@Entity('toc_aows')
@Index('UQ_toc_aows_program_node', ['programId', 'nodeId'], { unique: true })
@Index('IDX_toc_aows_program', ['programId'])
export class TocAow extends BaseEntity {
  /**
   * Stable per-program identifier for this AOW node.
   *
   * Computed as `related_node_id ?? id` on the source graph row —
   * see {@link TocSyncService} for the resolution rule.
   */
  @Column({ name: 'node_id', type: 'varchar', length: 36 })
  nodeId: string;

  /**
   * CLARISA-side stable identifier from `ost_wp.toc_id`.
   * Nullable because not every AOW node has an `ost_wp` block.
   */
  @Column({
    name: 'clarisa_toc_id',
    type: 'varchar',
    length: 36,
    nullable: true,
  })
  clarisaTocId: string | null;

  /** Short code, e.g. "AOW03" — from `ost_wp.acronym`. */
  @Column({ type: 'varchar', length: 50, nullable: true })
  acronym: string | null;

  /** Full official code, e.g. "SP01-AOW03" — from `ost_wp.wp_official_code`. */
  @Column({
    name: 'wp_official_code',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  wpOfficialCode: string | null;

  /** Display name, e.g. "Inclusive Delivery" — from `ost_wp.name` (fall back to `title`). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  name: string | null;

  /** Program (initiative) this AOW belongs to. */
  @Column({ name: 'program_id', type: 'int' })
  programId: number;

  @ManyToOne(() => Program, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'program_id' })
  program: Program;

  /** Timestamp of the last successful sync from the TOC API. */
  @Column({ name: 'synced_at', type: 'datetime' })
  syncedAt: Date;
}
