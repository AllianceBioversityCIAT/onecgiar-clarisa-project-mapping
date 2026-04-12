import { Column, Entity, ManyToOne, OneToMany, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';
import { PublishedProject } from './published-project.entity';

/**
 * A frozen snapshot of the project portfolio at a point in time.
 *
 * Only one snapshot can be active (`isActive = true`) at any time.
 * Creating a new snapshot deactivates all previous ones.
 */
@Entity('published_snapshots')
export class PublishedSnapshot extends BaseEntity {
  @Column({ name: 'version_label', type: 'varchar', length: 100 })
  versionLabel: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'published_at', type: 'datetime' })
  publishedAt: Date;

  @ManyToOne(() => User, { nullable: false })
  @JoinColumn({ name: 'published_by' })
  publishedBy: User;

  @Column({ name: 'published_by', type: 'int' })
  publishedById: number;

  @Column({ name: 'project_count', type: 'int', default: 0 })
  projectCount: number;

  @Column({
    name: 'total_budget',
    type: 'decimal',
    precision: 14,
    scale: 2,
    default: 0,
  })
  totalBudget: number;

  @Column({ name: 'summary_stats', type: 'json' })
  summaryStats: Record<string, unknown>;

  @Column({ name: 'is_active', type: 'tinyint', default: 1 })
  isActive: boolean;

  @OneToMany(() => PublishedProject, (pp) => pp.snapshot, { cascade: true })
  projects: PublishedProject[];
}
