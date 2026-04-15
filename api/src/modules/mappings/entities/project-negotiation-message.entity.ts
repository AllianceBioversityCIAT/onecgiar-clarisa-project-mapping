import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Project } from '../../projects/entities/project.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Free-text chat message posted at the project level during
 * negotiation. Unlike `MappingNegotiation` (which is a per-mapping
 * audit event), these rows are unscoped from any one mapping and are
 * merged into the consolidated event stream alongside mapping events.
 */
@Entity('project_negotiation_messages')
@Index('IDX_project_negotiation_messages_project_created', [
  'projectId',
  'createdAt',
])
export class ProjectNegotiationMessage {
  @PrimaryGeneratedColumn('increment')
  id: number;

  /** FK to the project this chat message belongs to. */
  @Column({ name: 'project_id', type: 'int' })
  projectId: number;

  @ManyToOne(() => Project, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: Project;

  /** FK to the user who posted the message. */
  @Column({ name: 'actor_id', type: 'int' })
  actorId: number;

  @ManyToOne(() => User, { nullable: false })
  @JoinColumn({ name: 'actor_id' })
  actor: User;

  /** Free-text chat message (1–2000 chars, validated in the DTO). */
  @Column({ type: 'text' })
  message: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
