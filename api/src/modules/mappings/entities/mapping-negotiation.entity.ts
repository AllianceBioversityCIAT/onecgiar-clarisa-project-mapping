import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ProjectMapping } from './project-mapping.entity';
import { User } from '../../users/entities/user.entity';
import { NegotiationEventType } from '../enums/negotiation-event-type.enum';

/**
 * Immutable audit entry representing a single event in a mapping negotiation.
 *
 * Each row is a "move" in the conversation: initiation, counter-proposal,
 * agreement, or reopening. The full ordered list of events for a mapping
 * forms the negotiation thread (contract-like history).
 */
@Entity('mapping_negotiations')
export class MappingNegotiation {
  @PrimaryGeneratedColumn('increment')
  id: number;

  /** FK to the mapping this event belongs to. */
  @Column({ name: 'mapping_id', type: 'int' })
  mappingId: number;

  @ManyToOne(() => ProjectMapping, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mapping_id' })
  mapping: ProjectMapping;

  /** FK to the user who performed this action. */
  @Column({ name: 'actor_id', type: 'int' })
  actorId: number;

  @ManyToOne(() => User, { nullable: false })
  @JoinColumn({ name: 'actor_id' })
  actor: User;

  /** Role of the actor at the time of the event. */
  @Column({
    name: 'actor_role',
    type: 'enum',
    enum: ['center_rep', 'program_rep'],
  })
  actorRole: 'center_rep' | 'program_rep';

  /** What happened in this event. */
  @Column({
    name: 'event_type',
    type: 'enum',
    enum: NegotiationEventType,
  })
  eventType: NegotiationEventType;

  /** The allocation % proposed in this move (null for agree/reopen events). */
  @Column({
    name: 'proposed_allocation',
    type: 'decimal',
    precision: 5,
    scale: 2,
    nullable: true,
  })
  proposedAllocation: number | null;

  /** Written justification (required for counter-proposals). */
  @Column({ type: 'text', nullable: true })
  justification: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
