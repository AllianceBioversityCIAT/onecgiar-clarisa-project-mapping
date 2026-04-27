import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Project } from './project.entity';
import { User } from '../../users/entities/user.entity';
import { ActorRole } from '../../mappings/enums/actor-role.enum';

/**
 * Append-only audit event for project metadata edits and snapshot
 * republishes. One row is written per changed field on `field_edited`
 * events, so editing two fields in a single PATCH writes two rows.
 *
 * Not extending BaseEntity because audit rows never update — there is
 * no `updated_at` column.
 */
export enum ProjectAuditEventType {
  FIELD_EDITED = 'field_edited',
  SNAPSHOT_REPUBLISHED = 'snapshot_republished',
}

@Entity('project_audit_events')
@Index('IDX_project_audit_project', ['projectId', 'createdAt'])
@Index('IDX_project_audit_actor', ['actorUserId', 'createdAt'])
export class ProjectAuditEvent {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @ManyToOne(() => Project, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: Project;

  @Column({ name: 'project_id', type: 'int' })
  projectId: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'actor_user_id' })
  actorUser: User;

  @Column({ name: 'actor_user_id', type: 'int' })
  actorUserId: number;

  @Column({
    name: 'actor_role',
    type: 'enum',
    enum: ActorRole,
  })
  actorRole: ActorRole;

  @Column({
    name: 'event_type',
    type: 'enum',
    enum: ProjectAuditEventType,
  })
  eventType: ProjectAuditEventType;

  /** NULL for snapshot_republished events; set to the field key for field_edited. */
  @Column({ name: 'field_name', type: 'varchar', length: 100, nullable: true })
  fieldName: string | null;

  /** Prior value, JSON-encoded so the column can carry strings, numbers, and dates uniformly. */
  @Column({ name: 'value_before', type: 'json', nullable: true })
  valueBefore: unknown;

  @Column({ name: 'value_after', type: 'json', nullable: true })
  valueAfter: unknown;

  /** Reason given by the editor; required at the API layer for unit_admin edits. */
  @Column({ type: 'text', nullable: true })
  justification: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt: Date;
}
