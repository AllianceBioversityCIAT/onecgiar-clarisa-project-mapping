import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { ProjectMapping } from './project-mapping.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Discriminator for which TOC table {@link MappingTocLink.tocId}
 * references. Stored as a string so adding a fourth flavour later
 * (e.g. `eoi` for portfolio outcomes) doesn't require a migration
 * — just widen the enum on the DB column.
 *
 * The polymorphic shape is deliberate: outcomes / outputs / aows
 * are all small per-program lookups (≤ a few dozen rows) so a
 * single junction table keeps query and validation logic simple.
 * A FK against each TOC table would force three near-identical
 * link tables for no win.
 */
export enum MappingTocLinkType {
  AOW = 'aow',
  OUTPUT = 'output',
  OUTCOME = 'outcome',
}

/**
 * Link between a project_mapping and one TOC graph node (AOW,
 * Output, or Intermediate Outcome). One row per (mapping, type, id).
 *
 * Polymorphic by design — `tocId` references `toc_aows.id` /
 * `toc_outputs.id` / `toc_outcomes.id` depending on `linkType`.
 * Validation that the target exists AND belongs to the mapping's
 * program is enforced at the service layer (no FK on `tocId`
 * because MySQL doesn't support conditional FKs).
 *
 * Outcome links are restricted to `outcome_type='intermediate'`
 * by the service — portfolio EOIs are never linked here.
 *
 * Mutations are atomic delete-all + reinsert inside
 * {@link MappingsService.setTocLinks} so the row set always
 * reflects the latest submission. The `toc_updated` event in
 * `mapping_negotiations` is the audit trail.
 */
@Entity('mapping_toc_links')
@Unique('UQ_mapping_toc_links_mapping_type_toc', [
  'projectMappingId',
  'linkType',
  'tocId',
])
@Index('IDX_mapping_toc_links_mapping', ['projectMappingId'])
export class MappingTocLink {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  /** FK to project_mappings.id (CASCADE on delete). */
  @Column({ name: 'project_mapping_id', type: 'bigint' })
  projectMappingId: string;

  @ManyToOne(() => ProjectMapping, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_mapping_id' })
  mapping: ProjectMapping;

  /** Which TOC table the {@link tocId} points at. */
  @Column({ name: 'link_type', type: 'enum', enum: MappingTocLinkType })
  linkType: MappingTocLinkType;

  /**
   * Numeric PK in the corresponding TOC table. Stored as bigint so
   * it can scale even though `toc_*` tables currently use int PKs.
   */
  @Column({ name: 'toc_id', type: 'bigint' })
  tocId: string;

  /**
   * User who last set this link (the program rep or workflow admin
   * whose call appended the row). Nullable so a CASCADE on user
   * removal does not destroy historic link rows.
   */
  @Column({ name: 'created_by_user_id', type: 'bigint', nullable: true })
  createdByUserId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by_user_id' })
  createdBy: User | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
