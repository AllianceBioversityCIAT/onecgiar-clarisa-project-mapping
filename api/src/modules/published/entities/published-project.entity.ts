import { Column, Entity, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { PublishedSnapshot } from './published-snapshot.entity';
import { PublishedMappingData } from './published-mapping.interface';

/**
 * A denormalized copy of a project frozen at snapshot time.
 *
 * All fields are copied from the live project + its relations at the
 * moment the snapshot is created. Changes to the live project after
 * the snapshot do NOT affect this row.
 */
@Entity('published_projects')
export class PublishedProject extends BaseEntity {
  @Column({ name: 'snapshot_id', type: 'int' })
  snapshotId: number;

  @ManyToOne(() => PublishedSnapshot, (s) => s.projects, { nullable: false })
  @JoinColumn({ name: 'snapshot_id' })
  snapshot: PublishedSnapshot;

  @Column({ name: 'source_project_id', type: 'int' })
  sourceProjectId: number;

  @Column({ type: 'varchar', length: 50 })
  code: string;

  @Column({ type: 'varchar', length: 1000 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'center_name', type: 'varchar', length: 255 })
  centerName: string;

  @Column({ name: 'center_acronym', type: 'varchar', length: 50 })
  centerAcronym: string;

  @Column({ type: 'json' })
  countries: {
    name: string;
    isoAlpha2: string;
    allocationPercentage: number;
  }[];

  @Column({
    name: 'total_budget',
    type: 'decimal',
    precision: 14,
    scale: 2,
    default: 0,
  })
  totalBudget: number;

  @Column({
    name: 'funding_source',
    type: 'varchar',
    length: 60,
    nullable: true,
  })
  fundingSource: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  funder: string | null;

  @Column({ type: 'varchar', length: 20 })
  status: string;

  @Column({ name: 'start_date', type: 'date', nullable: true })
  startDate: Date | null;

  @Column({ name: 'end_date', type: 'date', nullable: true })
  endDate: Date | null;

  @Column({ type: 'json' })
  mappings: PublishedMappingData[];
}
