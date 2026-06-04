import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { ProjectMapping } from './entities/project-mapping.entity';
import { MappingNegotiation } from './entities/mapping-negotiation.entity';
import { ProjectNegotiationMessage } from './entities/project-negotiation-message.entity';
import {
  MappingTocLink,
  MappingTocLinkType,
} from './entities/mapping-toc-link.entity';
import { NegotiationGateway } from './gateways/negotiation.gateway';
import { Project } from '../projects/entities/project.entity';
import { Program } from '../reference-data/entities/program.entity';
import { TocAow } from '../reference-data/entities/toc-aow.entity';
import { TocOutput } from '../reference-data/entities/toc-output.entity';
import { TocOutcome } from '../reference-data/entities/toc-outcome.entity';
import { CreateMappingDto } from './dto/create-mapping.dto';
import { CounterProposeDto } from './dto/counter-propose.dto';
import { AgreeDto } from './dto/agree.dto';
import { UpdateAllocationDto } from './dto/update-allocation.dto';
import { SetTocLinksDto } from './dto/set-toc-links.dto';
import { MappingQueryDto } from './dto/mapping-query.dto';
import { MappingStatus } from './enums/mapping-status.enum';
import { NegotiationEventType } from './enums/negotiation-event-type.enum';
import { ActorRole } from './enums/actor-role.enum';
import { Rating } from './enums/rating.enum';
import { ProjectStatus } from '../projects/enums/project-status.enum';
import { UserRole } from '../users/enums/user-role.enum';
import { User } from '../users/entities/user.entity';
import { AuditService } from '../audit/audit.service';
import { AuditEntityType } from '../audit/entities/audit-event.entity';

/**
 * Single event in a project's consolidated negotiation stream.
 *
 * Merges two logical event sources:
 *  - `mapping`  — rows from `mapping_negotiations` for any non-removed
 *                 mapping on the project (initiated, counter_proposed,
 *                 agreed, reopened, removed).
 *  - `message`  — free-text project-level chat from
 *                 `project_negotiation_messages`.
 */
export interface ConsolidatedEvent {
  id: number;
  kind: 'mapping' | 'message';
  /** Null for `message` kind (chat is project-scoped, not mapping-scoped). */
  mappingId: number | null;
  /** Display label for the related program; null for `message` kind. */
  programName: string | null;
  actorId: number;
  actorRole: UserRole;
  actorName: string;
  /** `NegotiationEventType` for `mapping` kind; literal `'message'` for chat. */
  eventType: NegotiationEventType | 'message';
  proposedPercentage: number | null;
  message: string | null;
  createdAt: Date;
}

/**
 * Consolidated view payload returned by `GET /mappings/projects/:projectId/consolidated`.
 *
 * Mappings carry their negotiation state (allocation, status, agreement
 * flags) but NOT per-mapping threads anymore — the full history lives
 * in the project-level `events` stream.
 */
export interface ConsolidatedView {
  project: {
    id: number;
    code: string;
    name: string;
    center: { id: number; name: string };
  };
  isLocked: boolean;
  canLock: boolean;
  totalAllocated: number;
  unallocated: number;
  mappings: Array<{
    id: number;
    programId: number;
    programName: string;
    allocationPercentage: number;
    status: MappingStatus;
    centerAgreed: boolean;
    programAgreed: boolean;
    needsAssistance: boolean;
    flaggedAt: Date | null;
    /** Latest program-rep submitted complementarity rating (null until first submission). */
    complementarityRating: Rating | null;
    /** Latest program-rep submitted efficiency rating (null until first submission). */
    efficiencyRating: Rating | null;
    /** True when a program-rep removal request is pending center decision. */
    removalRequested: boolean;
    /** Program rep who raised the request; null when no request pending. */
    removalRequestedById: number | null;
    /** ISO timestamp when the request was raised; null when no request pending. */
    removalRequestedAt: Date | null;
    /** Program rep's stated reason; null when no request pending. */
    removalJustification: string | null;
    /**
     * TOC contribution links the program rep has attached to this
     * mapping. Hydrated from `mapping_toc_links` joined to the
     * relevant TOC table per link_type. Empty arrays when no links
     * are set (the common case for legacy / imported mappings).
     */
    tocLinks: MappingTocLinksPayload;
  }>;
  events: ConsolidatedEvent[];
}

/**
 * Hydrated TOC link payload returned on `findOne()` and embedded on
 * every mapping in `getConsolidatedView()`. Full entity rows are
 * returned (id, title/name, code, parent AOW, …) so the consolidated
 * page can render labels without a follow-up call.
 */
export interface MappingTocLinksPayload {
  aows: TocAow[];
  outputs: TocOutput[];
  outcomes: TocOutcome[];
}

/**
 * Allocation summary for a project, showing how much has been
 * claimed by various programs and what remains.
 */
export interface AllocationSummary {
  totalAllocated: number;
  remaining: number;
  isComplete: boolean;
  isLocked: boolean;
  canLock: boolean;
  mappings: Array<{
    id: number;
    programId: number;
    programName: string;
    allocation: number;
    status: MappingStatus;
    centerAgreed: boolean;
    programAgreed: boolean;
    /** Latest program-rep submitted complementarity rating (null until first submission). */
    complementarityRating: Rating | null;
    /** Latest program-rep submitted efficiency rating (null until first submission). */
    efficiencyRating: Rating | null;
  }>;
}

/**
 * Service handling the mapping negotiation workflow.
 *
 * Center representatives initiate mappings, then negotiate allocation
 * percentages with program representatives. Both sides must agree
 * before the center can lock the project round.
 */
/**
 * Hard cap on the number of active (non-removed) program mappings a single
 * project may have. Enforced on user-initiated creation paths only — CSV /
 * Signalling imports bypass this so legacy portfolios can be loaded as-is.
 */
const MAX_ACTIVE_MAPPINGS_PER_PROJECT = 3;

@Injectable()
export class MappingsService {
  private readonly logger = new Logger(MappingsService.name);

  constructor(
    @InjectRepository(ProjectMapping)
    private readonly mappingRepository: Repository<ProjectMapping>,
    @InjectRepository(MappingNegotiation)
    private readonly negotiationRepository: Repository<MappingNegotiation>,
    @InjectRepository(ProjectNegotiationMessage)
    private readonly chatMessageRepository: Repository<ProjectNegotiationMessage>,
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(Program)
    private readonly programRepository: Repository<Program>,
    @InjectRepository(MappingTocLink)
    private readonly tocLinkRepository: Repository<MappingTocLink>,
    @InjectRepository(TocAow)
    private readonly tocAowRepository: Repository<TocAow>,
    @InjectRepository(TocOutput)
    private readonly tocOutputRepository: Repository<TocOutput>,
    @InjectRepository(TocOutcome)
    private readonly tocOutcomeRepository: Repository<TocOutcome>,
    private readonly dataSource: DataSource,
    private readonly negotiationGateway: NegotiationGateway,
    private readonly auditService: AuditService,
  ) {}

  // ─── Creation ─────────────────────────────────────────────────────

  /**
   * Creates a new mapping in draft status.
   *
   * Only center representatives can create mappings for projects
   * belonging to their center. If a removed mapping exists for the
   * same project+program, it is reused (reset to draft).
   */
  async create(dto: CreateMappingDto, user: User): Promise<ProjectMapping> {
    // Workflow_admin can create on any project's behalf; center reps
    // must own the project's center. Admin is intentionally excluded
    // from every negotiation mutation (read-only on negotiation).
    //
    // NOTE: user.centerId reflects the active center (possibly overlaid
    // by ActiveCenterInterceptor from the X-Active-Center header). A
    // multi-center rep can only create mappings in their currently
    // active center; the interceptor has already validated that the
    // header value is in user.centerIds.
    const isWorkflowAdmin = user.role === UserRole.WORKFLOW_ADMIN;
    const isOwningCenterRep =
      user.role === UserRole.CENTER_REP && !!user.centerId;
    if (!isWorkflowAdmin && !isOwningCenterRep) {
      throw new ForbiddenException(
        'Only center representatives or workflow admins can create mappings',
      );
    }

    const project = await this.projectRepository.findOneBy({
      id: dto.projectId,
    });
    if (!project) {
      throw new NotFoundException(
        `Project with ID "${dto.projectId}" not found`,
      );
    }
    if (project.status !== ProjectStatus.ACTIVE) {
      throw new BadRequestException(
        'Mappings can only be created for active projects',
      );
    }
    if (!isWorkflowAdmin && project.centerId !== user.centerId) {
      throw new ForbiddenException(
        'You can only create mappings for projects in your center',
      );
    }

    const program = await this.programRepository.findOneBy({
      id: dto.programId,
    });
    if (!program) {
      throw new NotFoundException(
        `Program with ID "${dto.programId}" not found`,
      );
    }

    // Check for existing mapping (unique constraint)
    const existing = await this.mappingRepository.findOneBy({
      projectId: dto.projectId,
      programId: dto.programId,
    });

    if (existing && existing.status !== MappingStatus.REMOVED) {
      throw new ConflictException(
        'Mapping already exists for this project and program',
      );
    }

    await this.assertMappingCapNotExceeded(dto.projectId);

    const now = new Date();

    const result = await this.dataSource.transaction(async (manager) => {
      let saved: ProjectMapping;

      if (existing) {
        // Reuse removed mapping row. Starts as draft — invisible to programs
        // until the center rep clicks Start Negotiation.
        existing.allocationPercentage = dto.allocationPercentage;
        existing.status = MappingStatus.DRAFT;
        existing.centerAgreed = false;
        existing.programAgreed = false;
        existing.initiatedById = user.id;
        existing.initiatedAt = now;
        existing.rejectionReason = null;
        // Center-set ratings — overwrite whatever was on the legacy row.
        existing.complementarityRating = dto.complementarityRating;
        existing.efficiencyRating = dto.efficiencyRating;
        saved = await manager.save(ProjectMapping, existing);
        this.logger.log(
          `Mapping reused (was removed): project=${dto.projectId}, program=${dto.programId}`,
        );
      } else {
        const mapping = new ProjectMapping();
        mapping.projectId = dto.projectId;
        mapping.programId = dto.programId;
        mapping.allocationPercentage = dto.allocationPercentage;
        // Starts as draft — invisible to programs until the center rep
        // clicks Start Negotiation, which bulk-promotes drafts to negotiating.
        mapping.status = MappingStatus.DRAFT;
        mapping.centerAgreed = false;
        mapping.programAgreed = false;
        mapping.initiatedById = user.id;
        mapping.initiatedAt = now;
        // Center-set ratings — required at DTO level.
        mapping.complementarityRating = dto.complementarityRating;
        mapping.efficiencyRating = dto.efficiencyRating;
        // Legacy columns
        mapping.submittedById = user.id;
        mapping.submittedAt = now;
        saved = await manager.save(ProjectMapping, mapping);
        this.logger.log(
          `Mapping created: project=${dto.projectId}, program=${dto.programId}, allocation=${dto.allocationPercentage}%`,
        );
      }

      // Record initiated event with the actor's real role.
      const event = new MappingNegotiation();
      event.mappingId = saved.id;
      event.actorId = user.id;
      event.actorRole = this.toActorRole(user);
      event.eventType = NegotiationEventType.INITIATED;
      event.proposedAllocation = dto.allocationPercentage;
      await manager.save(MappingNegotiation, event);

      return manager.findOne(ProjectMapping, {
        where: { id: saved.id },
        relations: ['project', 'project.center', 'program', 'initiatedBy'],
      }) as Promise<ProjectMapping>;
    });

    this.negotiationGateway.emitProjectUpdate(dto.projectId, 'mapping.created');

    /* Audit: a center rep (or admin) opened a mapping. record() is
     * post-commit and best-effort — failures are swallowed inside the
     * service. Programs are referenced by id only here; the consolidated
     * page resolves names from `mapping_negotiations` joins. */
    await this.auditService.record({
      entityType: AuditEntityType.PROJECT_MAPPING,
      entityId: result.id,
      action: 'mapping.create',
      summary: `Initiated mapping to program ${dto.programId} (${dto.allocationPercentage}%)`,
    });

    return result;
  }

  // ─── Negotiation Actions ──────────────────────────────────────────

  /**
   * Opens negotiation on a draft mapping (draft → negotiating).
   * Only the center rep who owns the project can do this.
   */
  async openNegotiation(
    mappingId: number,
    user: User,
  ): Promise<ProjectMapping> {
    const mapping = await this.findOneInternal(mappingId);
    this.validateCenterRepOwnership(mapping, user);

    if (mapping.status !== MappingStatus.DRAFT) {
      throw new BadRequestException(
        'Only draft mappings can be opened for negotiation',
      );
    }

    /* 100% allocation gate — same rule as startNegotiationRound. A draft
     * cannot go live until the project's non-removed mappings total
     * exactly 100%. */
    await this.assertProjectFullyAllocated(mapping.projectId);

    await this.dataSource.transaction(async (manager) => {
      mapping.status = MappingStatus.NEGOTIATING;
      await manager.save(ProjectMapping, mapping);

      // Append a timeline event so the consolidated thread shows the
      // moment the mapping went live. Mirrors the per-mapping rows that
      // the bulk `startNegotiationRound` writes.
      const event = new MappingNegotiation();
      event.mappingId = mappingId;
      event.actorId = user.id;
      event.actorRole = this.toActorRole(user);
      event.eventType = NegotiationEventType.NEGOTIATION_STARTED;
      event.proposedAllocation = mapping.allocationPercentage;
      event.justification = null;
      await manager.save(MappingNegotiation, event);
    });

    this.logger.log(`Mapping ${mappingId} opened for negotiation`);

    this.negotiationGateway.emitProjectUpdate(
      mapping.projectId,
      'mapping.opened',
    );
    return this.findOneInternal(mappingId);
  }

  /**
   * Submits a counter-proposal on a mapping.
   *
   * Either center rep (owning center) or program rep (owning program)
   * can counter-propose. Resets both agreement flags. The 100% rule
   * is NOT enforced here — only at lock time.
   */
  async counterPropose(
    mappingId: number,
    dto: CounterProposeDto,
    user: User,
  ): Promise<ProjectMapping> {
    const mapping = await this.findOneInternal(mappingId);

    // Counter-proposals are allowed on negotiating AND agreed mappings.
    // Agreed-then-counter is the standard path to unblock an over-allocated
    // round (both sides agreed on terms that sum > 100, and one side now
    // proposes lower). Draft / removed rows still reject.
    if (
      mapping.status !== MappingStatus.NEGOTIATING &&
      mapping.status !== MappingStatus.AGREED
    ) {
      throw new BadRequestException(
        'Counter-proposals can only be made on negotiating or agreed mappings',
      );
    }

    const { actorRole, side } = this.validateNegotiationAccess(mapping, user);

    /* Snapshot the prior allocation BEFORE the TX mutates the entity, so
     * the post-commit audit row carries an accurate before/after. */
    const previousAllocation = Number(mapping.allocationPercentage);

    const result = await this.dataSource.transaction(async (manager) => {
      // Update allocation and reset agreement flags. The proposer
      // implicitly agrees to their own offer — only the counter-party
      // still needs to confirm. Ratings are intentionally NOT touched
      // here — they are a center-side responsibility set at create +
      // allocation edit only.
      mapping.allocationPercentage = dto.proposedAllocation;
      mapping.centerAgreed = side === 'center';
      mapping.programAgreed = side === 'program';
      // If the row was already AGREED, this counter reverts it back to
      // negotiating so the counter-party can re-agree on the new terms.
      if (mapping.status === MappingStatus.AGREED) {
        mapping.status = MappingStatus.NEGOTIATING;
      }
      await manager.save(ProjectMapping, mapping);

      // Record the event with the actor's real role (admin/workflow_admin
      // are no longer collapsed into center_rep).
      const event = new MappingNegotiation();
      event.mappingId = mappingId;
      event.actorId = user.id;
      event.actorRole = actorRole;
      event.eventType = NegotiationEventType.COUNTER_PROPOSED;
      event.proposedAllocation = dto.proposedAllocation;
      event.justification = dto.justification;
      await manager.save(MappingNegotiation, event);

      this.logger.log(
        `Mapping ${mappingId} counter-proposed by ${actorRole} (user ${user.id}): ${dto.proposedAllocation}%`,
      );

      // Auto-flag for workflow-admin assistance once the program rep
      // has counter-proposed at least twice on this mapping. We count
      // ALL program-rep counter-proposals on the mapping (including the
      // one just inserted above) — the >= 2 threshold is the documented
      // signal that the parties are deadlocked.
      // Note: TypeORM returns MySQL tinyint(1) as 0/1 integers, so we use
      // a truthy check instead of `=== false` (which would never match).
      if (actorRole === ActorRole.PROGRAM_REP && !mapping.needsAssistance) {
        const programRepCounters = await manager.count(MappingNegotiation, {
          where: {
            mappingId,
            eventType: NegotiationEventType.COUNTER_PROPOSED,
            actorRole: ActorRole.PROGRAM_REP,
          },
        });

        if (programRepCounters >= 2) {
          mapping.needsAssistance = true;
          mapping.flaggedAt = new Date();
          await manager.save(ProjectMapping, mapping);

          // Second audit row so the consolidated stream surfaces the
          // flag transition explicitly. Actor is the program rep who
          // tripped the threshold; their real role is recorded.
          const flagEvent = new MappingNegotiation();
          flagEvent.mappingId = mappingId;
          flagEvent.actorId = user.id;
          flagEvent.actorRole = actorRole;
          flagEvent.eventType = NegotiationEventType.FLAGGED_FOR_ASSISTANCE;
          await manager.save(MappingNegotiation, flagEvent);

          this.logger.log(
            `Mapping ${mappingId} flagged for assistance after ${programRepCounters} program-rep counter-proposals`,
          );
        }
      }

      return manager.findOne(ProjectMapping, {
        where: { id: mappingId },
        relations: ['project', 'project.center', 'program', 'initiatedBy'],
      }) as Promise<ProjectMapping>;
    });

    this.negotiationGateway.emitProjectUpdate(
      mapping.projectId,
      'mapping.counter_proposed',
    );

    /* Audit the counter-proposal. The before/after captures the
     * allocation delta since that's the change the negotiating
     * parties care about; the justification is preserved verbatim. */
    await this.auditService.record({
      entityType: AuditEntityType.PROJECT_MAPPING,
      entityId: mappingId,
      action: 'mapping.counter_proposed',
      changes: {
        allocation: {
          before: previousAllocation,
          after: dto.proposedAllocation,
        },
      },
      justification: dto.justification ?? null,
    });

    return result;
  }

  /**
   * Marks the current user's agreement on the mapping's current terms.
   *
   * If both sides have agreed, transitions status to `agreed`.
   * Idempotent: calling again from the same side is a no-op.
   *
   * No body is required. Ratings are intentionally NOT collected here —
   * they are a center-side responsibility set at create + allocation
   * edit only and remain unchanged across agreement events.
   */
  async agree(
    mappingId: number,
    _dto: AgreeDto,
    user: User,
  ): Promise<ProjectMapping> {
    const mapping = await this.findOneInternal(mappingId);

    if (mapping.status !== MappingStatus.NEGOTIATING) {
      throw new BadRequestException('Can only agree on negotiating mappings');
    }

    const { actorRole, side } = this.validateNegotiationAccess(mapping, user);

    /* Program-side TOC gate.
     *
     * When the program rep accepts the current terms, they must have
     * attached at least one AOW AND at least one Output or Intermediate
     * Outcome to the mapping. Pre-existing legacy `agreed` rows are
     * grandfathered (we only enforce on new agree() calls), and
     * center-side agree() calls are exempt — the obligation lives with
     * the program rep who is committing to deliver against the TOC.
     */
    if (side === 'program') {
      await this.assertTocLinksSatisfyAgreeGate(mappingId);
    }

    const { reloaded, autoLocked } = await this.dataSource.transaction(
      async (manager) => {
        // Set the appropriate flag based on which side the actor represents.
        if (side === 'center') {
          mapping.centerAgreed = true;
        } else {
          mapping.programAgreed = true;
        }

        // If both agreed, transition to agreed status and auto-clear any
        // outstanding "needs assistance" flag — the parties resolved
        // themselves, no arbitration needed. No audit event for the clear:
        // the AGREED event already tells that story.
        let justAgreed = false;
        if (mapping.centerAgreed && mapping.programAgreed) {
          mapping.status = MappingStatus.AGREED;
          justAgreed = true;
          if (mapping.needsAssistance) {
            mapping.needsAssistance = false;
            mapping.flaggedAt = null;
          }
          this.logger.log(
            `Mapping ${mappingId} fully agreed — both sides confirmed`,
          );
        }

        await manager.save(ProjectMapping, mapping);

        // Record the event with the actor's real role. Justification is
        // null for an agree event — ratings are no longer collected here.
        const event = new MappingNegotiation();
        event.mappingId = mappingId;
        event.actorId = user.id;
        event.actorRole = actorRole;
        event.eventType = NegotiationEventType.AGREED;
        event.justification = null;
        await manager.save(MappingNegotiation, event);

        this.logger.log(
          `Mapping ${mappingId}: ${actorRole} agreed (center=${mapping.centerAgreed}, program=${mapping.programAgreed})`,
        );

        // When this agree sealed the mapping, the whole round may now be
        // fully agreed — if so, auto-lock it rather than waiting for a
        // manual center lock. Runs in the same transaction so the lock is
        // atomic with the agreement that triggered it.
        const locked = justAgreed
          ? await this.tryAutoLockOnFullAgreement(
              manager,
              mapping.projectId,
              user,
            )
          : false;

        const reloadedMapping = (await manager.findOne(ProjectMapping, {
          where: { id: mappingId },
          relations: ['project', 'project.center', 'program', 'initiatedBy'],
        })) as ProjectMapping;

        return { reloaded: reloadedMapping, autoLocked: locked };
      },
    );

    this.negotiationGateway.emitProjectUpdate(
      mapping.projectId,
      'mapping.agreed',
    );

    /* Audit the agreement. No diff payload — the event itself is the
     * signal; the consolidated thread already records who agreed and
     * when via mapping_negotiations. */
    await this.auditService.record({
      entityType: AuditEntityType.PROJECT_MAPPING,
      entityId: mappingId,
      action: 'mapping.agreed',
    });

    // If the round auto-locked, mirror lockProjectRound's post-commit
    // side effects so listeners and the audit log can't tell the
    // difference between a manual and an auto lock.
    if (autoLocked) {
      this.negotiationGateway.emitProjectUpdate(
        mapping.projectId,
        'project.locked',
      );
      await this.auditService.record({
        entityType: AuditEntityType.PROJECT,
        entityId: mapping.projectId,
        action: 'project.locked',
      });
    }

    return reloaded;
  }

  /**
   * Removes a program from the negotiation.
   *
   * Asymmetric flow — the program rep does NOT remove unilaterally:
   *  - Center side (admin / center_rep / workflow_admin): removes immediately,
   *    using either their own justification OR (when accepting a pending
   *    program-rep request) the program rep's stored justification.
   *  - Program rep: must call `requestRemoval` instead — this method rejects
   *    them with 403. The center then accepts via this same endpoint.
   *
   * A written justification is recorded in the negotiation thread as a
   * `removed` event. When the center is accepting a pending request, the
   * event is annotated so the audit trail tells the full story.
   */
  async removeProgram(
    mappingId: number,
    justification: string,
    user: User,
  ): Promise<ProjectMapping> {
    const mapping = await this.findOneInternal(mappingId);

    if (
      mapping.status !== MappingStatus.DRAFT &&
      mapping.status !== MappingStatus.NEGOTIATING
    ) {
      throw new BadRequestException(
        'Only draft or negotiating mappings can be removed',
      );
    }

    // Either the owning center rep, owning program rep, admin, or
    // workflow_admin can pass RBAC. Program reps are then rejected
    // explicitly — they must go through requestRemoval().
    const { actorRole } = this.validateNegotiationAccess(mapping, user);
    if (actorRole === ActorRole.PROGRAM_REP) {
      throw new ForbiddenException(
        'Program reps must request removal — the center will accept or decline',
      );
    }

    // If a program-rep request is pending, the center is accepting it.
    // Carry over the program rep's original justification verbatim and
    // tag the audit event so the timeline reads "requested → removed".
    const acceptingRequest = mapping.removalRequested;
    const effectiveJustification = acceptingRequest
      ? this.buildAcceptanceJustification(mapping, justification)
      : justification;

    const result = await this.dataSource.transaction(async (manager) => {
      mapping.status = MappingStatus.REMOVED;
      mapping.centerAgreed = false;
      mapping.programAgreed = false;
      // Clear any pending request — the request is now resolved.
      mapping.removalRequested = false;
      mapping.removalRequestedById = null;
      mapping.removalRequestedAt = null;
      mapping.removalJustification = null;
      await manager.save(ProjectMapping, mapping);

      const event = new MappingNegotiation();
      event.mappingId = mappingId;
      event.actorId = user.id;
      event.actorRole = actorRole;
      event.eventType = NegotiationEventType.REMOVED;
      event.justification = effectiveJustification;
      await manager.save(MappingNegotiation, event);

      this.logger.log(
        `Mapping ${mappingId} removed by ${actorRole} (user ${user.id})${
          acceptingRequest ? ' [accepted program-rep request]' : ''
        }`,
      );

      return manager.findOne(ProjectMapping, {
        where: { id: mappingId },
        relations: ['project', 'project.center', 'program', 'initiatedBy'],
      }) as Promise<ProjectMapping>;
    });

    this.negotiationGateway.emitProjectUpdate(
      mapping.projectId,
      'mapping.removed',
    );

    /* Audit the removal. Justification is required by the DTO so we
     * forward it verbatim — it's the operator's reason on record. */
    await this.auditService.record({
      entityType: AuditEntityType.PROJECT_MAPPING,
      entityId: mappingId,
      action: acceptingRequest
        ? 'mapping.removal_request_accepted'
        : 'mapping.removed',
      justification: effectiveJustification,
    });

    return result;
  }

  /**
   * Program rep raises a removal request on their own mapping.
   *
   * The mapping stays in its current state (draft / negotiating) — only
   * a `removal_requested` flag and audit event are added. The center
   * side then resolves the request via accept (calls `removeProgram`)
   * or decline (calls `declineRemoval`).
   *
   * Idempotency: a 409 is raised if a request is already pending.
   */
  async requestRemoval(
    mappingId: number,
    justification: string,
    user: User,
  ): Promise<ProjectMapping> {
    const mapping = await this.findOneInternal(mappingId);

    if (
      mapping.status !== MappingStatus.DRAFT &&
      mapping.status !== MappingStatus.NEGOTIATING
    ) {
      throw new BadRequestException(
        'Only draft or negotiating mappings can be removed',
      );
    }

    // RBAC — only the matching program rep can raise the request.
    const { actorRole } = this.validateNegotiationAccess(mapping, user);
    if (actorRole !== ActorRole.PROGRAM_REP) {
      throw new ForbiddenException(
        'Only program reps raise removal requests; other roles remove directly',
      );
    }

    if (mapping.removalRequested) {
      throw new ConflictException(
        'A removal request is already pending on this mapping',
      );
    }

    const result = await this.dataSource.transaction(async (manager) => {
      mapping.removalRequested = true;
      mapping.removalRequestedById = user.id;
      mapping.removalRequestedAt = new Date();
      mapping.removalJustification = justification;
      await manager.save(ProjectMapping, mapping);

      const event = new MappingNegotiation();
      event.mappingId = mappingId;
      event.actorId = user.id;
      event.actorRole = actorRole;
      event.eventType = NegotiationEventType.REMOVAL_REQUESTED;
      event.justification = justification;
      await manager.save(MappingNegotiation, event);

      this.logger.log(
        `Mapping ${mappingId} removal requested by program rep ${user.id}`,
      );

      return manager.findOne(ProjectMapping, {
        where: { id: mappingId },
        relations: ['project', 'project.center', 'program', 'initiatedBy'],
      }) as Promise<ProjectMapping>;
    });

    this.negotiationGateway.emitProjectUpdate(
      mapping.projectId,
      'mapping.removal_requested',
    );

    await this.auditService.record({
      entityType: AuditEntityType.PROJECT_MAPPING,
      entityId: mappingId,
      action: 'mapping.removal_requested',
      justification,
    });

    return result;
  }

  /**
   * Center side rejects a pending program-rep removal request. The
   * mapping continues negotiation as before; only the pending flag is
   * cleared and a `removal_declined` event is recorded with the optional
   * reason from the decliner.
   */
  async declineRemoval(
    mappingId: number,
    reason: string | undefined,
    user: User,
  ): Promise<ProjectMapping> {
    const mapping = await this.findOneInternal(mappingId);

    if (!mapping.removalRequested) {
      throw new BadRequestException(
        'No removal request is pending on this mapping',
      );
    }

    // RBAC — program reps cannot decline; only center / admin / workflow_admin.
    const { actorRole } = this.validateNegotiationAccess(mapping, user);
    if (actorRole === ActorRole.PROGRAM_REP) {
      throw new ForbiddenException(
        'Program reps cannot decline a removal request',
      );
    }

    const result = await this.dataSource.transaction(async (manager) => {
      mapping.removalRequested = false;
      mapping.removalRequestedById = null;
      mapping.removalRequestedAt = null;
      mapping.removalJustification = null;
      await manager.save(ProjectMapping, mapping);

      const event = new MappingNegotiation();
      event.mappingId = mappingId;
      event.actorId = user.id;
      event.actorRole = actorRole;
      event.eventType = NegotiationEventType.REMOVAL_DECLINED;
      event.justification = reason ?? null;
      await manager.save(MappingNegotiation, event);

      this.logger.log(
        `Mapping ${mappingId} removal declined by ${actorRole} (user ${user.id})`,
      );

      return manager.findOne(ProjectMapping, {
        where: { id: mappingId },
        relations: ['project', 'project.center', 'program', 'initiatedBy'],
      }) as Promise<ProjectMapping>;
    });

    this.negotiationGateway.emitProjectUpdate(
      mapping.projectId,
      'mapping.removal_declined',
    );

    await this.auditService.record({
      entityType: AuditEntityType.PROJECT_MAPPING,
      entityId: mappingId,
      action: 'mapping.removal_declined',
      justification: reason ?? null,
    });

    return result;
  }

  /**
   * Builds the negotiation-event justification used when the center
   * accepts a pending program-rep removal request. Combines both reasons
   * so the final `removed` event is self-contained — readers don't need
   * to scroll back to the original `removal_requested` event.
   */
  private buildAcceptanceJustification(
    mapping: ProjectMapping,
    centerJustification: string,
  ): string {
    const programReason = (mapping.removalJustification ?? '').trim();
    const centerReason = (centerJustification ?? '').trim();
    if (!programReason) return centerReason;
    return `${centerReason}\n\n[Program-rep request: ${programReason}]`;
  }

  // ─── Project-Level Actions ────────────────────────────────────────

  /**
   * Locks project-level negotiation by flipping `projects.negotiation_locked`
   * to true. Gate: every non-removed mapping must be `agreed` AND the sum
   * of allocation percentages must NOT exceed 100. Locking with under-100%
   * allocation is allowed — the unallocated portion is intentional.
   *
   * Uses pessimistic_write on the project row so two concurrent lock
   * attempts cannot both pass the gate. Mapping rows are NOT mutated
   * here — the project flag is the source of truth for lock state.
   */
  async lockProjectRound(projectId: number, user: User): Promise<Project> {
    const result = await this.dataSource.transaction(async (manager) => {
      // Pessimistic-lock the project row before reading mappings,
      // so a concurrent lock/mapping-update can't invalidate our gate.
      const project = await manager
        .createQueryBuilder(Project, 'project')
        .setLock('pessimistic_write')
        .where('project.id = :projectId', { projectId })
        .getOne();

      if (!project) {
        throw new NotFoundException(`Project with ID "${projectId}" not found`);
      }

      this.assertCanToggleLock(project, user);

      const mappings = await manager.find(ProjectMapping, {
        where: { projectId },
      });
      const active = mappings.filter((m) => m.status !== MappingStatus.REMOVED);

      if (active.length === 0) {
        throw new BadRequestException(
          'Cannot lock: no active mappings exist for this project',
        );
      }

      const total = active.reduce(
        (sum, m) => sum + Number(m.allocationPercentage),
        0,
      );
      if (total - 100 > 0.01) {
        throw new BadRequestException(
          `Cannot lock: allocations total ${total}%, cannot exceed 100%`,
        );
      }

      const notAgreed = active.filter((m) => m.status !== MappingStatus.AGREED);
      if (notAgreed.length > 0) {
        throw new BadRequestException(
          `Cannot lock: ${notAgreed.length} mapping(s) are not in 'agreed' status`,
        );
      }

      project.negotiationLocked = true;
      await manager.save(Project, project);

      // Append one LOCKED event per active mapping so the consolidated
      // timeline shows the round being sealed on every program's thread.
      // Mirrors the per-mapping REOPENED pattern in `reopenProjectRound`.
      // `proposed_allocation` captures the mapping's current % at lock
      // time so the snapshot is self-describing.
      const role = this.toActorRole(user);
      for (const m of active) {
        const event = new MappingNegotiation();
        event.mappingId = m.id;
        event.actorId = user.id;
        event.actorRole = role;
        event.eventType = NegotiationEventType.LOCKED;
        event.proposedAllocation = m.allocationPercentage;
        event.justification = null;
        await manager.save(MappingNegotiation, event);
      }

      this.logger.log(
        `Project ${projectId} negotiation locked by user ${user.id}`,
      );

      return project;
    });

    this.negotiationGateway.emitProjectUpdate(projectId, 'project.locked');

    /* Audit the lock at the project level. The mapping rows that were
     * agreed on the way to lock are already covered by their own
     * mapping.agreed events. */
    await this.auditService.record({
      entityType: AuditEntityType.PROJECT,
      entityId: projectId,
      action: 'project.locked',
    });

    return result;
  }

  /**
   * Attempts to auto-lock a project round from inside an existing
   * transaction. Called after an `agree()` flips a mapping to `AGREED`:
   * once both sides agree on every active mapping, there's nothing left
   * to negotiate, so the round seals itself with no manual center lock.
   *
   * Auto-lock gate (stricter than the manual `lockProjectRound` gate,
   * which also accepts under-100% rounds): every active (non-removed)
   * mapping must be `agreed` AND the allocation total must equal exactly
   * 100%. An under-allocated but fully-agreed round is left open so the
   * center can still rebalance and lock it manually.
   *
   * Idempotent and side-effect-light at the data layer: flips
   * `negotiation_locked` and appends one LOCKED event per active mapping
   * (mirroring `lockProjectRound`). Returns true if it locked, so the
   * caller can emit the project-level lock/audit events after commit.
   *
   * RBAC is intentionally NOT checked here — auto-lock is a system
   * consequence of mutual agreement, attributed to whoever cast the
   * final agree (passed as `user`), not a privileged lock action.
   */
  private async tryAutoLockOnFullAgreement(
    manager: EntityManager,
    projectId: number,
    user: User,
  ): Promise<boolean> {
    const project = await manager
      .createQueryBuilder(Project, 'project')
      .setLock('pessimistic_write')
      .where('project.id = :projectId', { projectId })
      .getOne();

    // Already locked, or gone — nothing to do.
    if (!project || project.negotiationLocked) {
      return false;
    }

    const mappings = await manager.find(ProjectMapping, {
      where: { projectId },
    });
    const active = mappings.filter((m) => m.status !== MappingStatus.REMOVED);

    // No active mappings, or any not yet fully agreed → not done.
    if (active.length === 0) {
      return false;
    }
    if (active.some((m) => m.status !== MappingStatus.AGREED)) {
      return false;
    }

    // Auto-lock requires the round to be fully allocated. A fully-agreed
    // but under-100% round stays open for manual lock.
    const total = active.reduce(
      (sum, m) => sum + Number(m.allocationPercentage),
      0,
    );
    if (Math.abs(total - 100) > 0.01) {
      return false;
    }

    project.negotiationLocked = true;
    await manager.save(Project, project);

    // One LOCKED event per active mapping, matching lockProjectRound so
    // the consolidated timeline reads identically whether the round was
    // sealed manually or auto-sealed on full agreement.
    const role = this.toActorRole(user);
    for (const m of active) {
      const event = new MappingNegotiation();
      event.mappingId = m.id;
      event.actorId = user.id;
      event.actorRole = role;
      event.eventType = NegotiationEventType.LOCKED;
      event.proposedAllocation = m.allocationPercentage;
      event.justification = null;
      await manager.save(MappingNegotiation, event);
    }

    this.logger.log(
      `Project ${projectId} auto-locked on full agreement (final agree by user ${user.id})`,
    );

    return true;
  }

  /**
   * Reopens project-level negotiation by flipping `projects.negotiation_locked`
   * to false. No gate beyond RBAC — admin/workflow_admin/owning center_rep can
   * always reopen.
   *
   * Reopen returns ALL non-removed mappings to `draft` status so the center
   * rep can edit allocations privately (program reps don't see drafts) before
   * relaunching the round via `startNegotiationRound`. Both agreement flags
   * are cleared on every non-removed mapping so each side must re-confirm
   * once negotiation is restarted.
   */
  async reopenProjectRound(projectId: number, user: User): Promise<Project> {
    const result = await this.dataSource.transaction(async (manager) => {
      const project = await manager.findOneBy(Project, { id: projectId });
      if (!project) {
        throw new NotFoundException(`Project with ID "${projectId}" not found`);
      }

      this.assertCanToggleLock(project, user);

      project.negotiationLocked = false;
      await manager.save(Project, project);

      // Revert ALL non-removed mappings (draft / negotiating / agreed) back
      // to draft so they're invisible to program reps until the center rep
      // explicitly re-launches the round via startNegotiationRound. Both
      // agreement flags are cleared so each side must re-confirm post-restart.
      await manager
        .createQueryBuilder()
        .update(ProjectMapping)
        .set({
          status: MappingStatus.DRAFT,
          centerAgreed: false,
          programAgreed: false,
        })
        .where('project_id = :projectId', { projectId })
        .andWhere('status != :removed', { removed: MappingStatus.REMOVED })
        .execute();

      // Record a reopened event against every non-removed mapping so the
      // feed shows the transition per program. The `needs_assistance`
      // flag is intentionally NOT cleared here — a reopened round may
      // still need workflow-admin attention until both sides re-agree.
      // The current allocation is captured as the snapshot on the event
      // so the new "open offer" is anchored to this fresh row — replies
      // (Agree / Counter-Propose) target the reopen event, not the
      // historical proposals from the prior round.
      const active = await manager.find(ProjectMapping, {
        where: { projectId },
      });
      const role = this.toActorRole(user);
      for (const m of active) {
        if (m.status === MappingStatus.REMOVED) continue;
        const event = new MappingNegotiation();
        event.mappingId = m.id;
        event.actorId = user.id;
        event.actorRole = role;
        event.eventType = NegotiationEventType.REOPENED;
        event.proposedAllocation = m.allocationPercentage;
        await manager.save(MappingNegotiation, event);
      }

      this.logger.log(
        `Project ${projectId} negotiation reopened by user ${user.id}`,
      );

      return project;
    });

    this.negotiationGateway.emitProjectUpdate(projectId, 'project.reopened');

    /* Audit the reopen. Mapping rows reverted from agreed to negotiating
     * are covered by their own mapping_negotiations REOPENED rows. */
    await this.auditService.record({
      entityType: AuditEntityType.PROJECT,
      entityId: projectId,
      action: 'project.reopened',
    });

    return result;
  }

  /**
   * Bulk-promotes every `draft` mapping on a project to `negotiating`,
   * marking the start of a (re-)opened negotiation round.
   *
   * Driven by the new "Start Negotiation" button on the consolidated
   * page. Until this is called after a reopen, mappings stay in draft
   * status and remain invisible to program reps — giving the center rep
   * a private window to edit allocations before re-engaging the program
   * side.
   *
   * Gates: same RBAC as lock/reopen (admin / workflow_admin / owning
   * center_rep). The project must NOT be locked, and there must be at
   * least one draft mapping to promote.
   *
   * Each promoted mapping gets a `negotiation_started` row in
   * `mapping_negotiations` so the consolidated thread shows the moment
   * the round became visible to program reps. `proposed_allocation`
   * captures the current allocation snapshot to anchor subsequent
   * Agree / Counter-Propose replies.
   */
  async startNegotiationRound(projectId: number, user: User): Promise<Project> {
    const result = await this.dataSource.transaction(async (manager) => {
      const project = await manager.findOneBy(Project, { id: projectId });
      if (!project) {
        throw new NotFoundException(`Project with ID "${projectId}" not found`);
      }

      this.assertCanToggleLock(project, user);

      if (project.negotiationLocked) {
        throw new BadRequestException(
          'Cannot start negotiation: project is locked. Reopen the round first.',
        );
      }

      // Load every draft mapping; bail if there's nothing to promote.
      const drafts = await manager.find(ProjectMapping, {
        where: { projectId, status: MappingStatus.DRAFT },
      });
      if (drafts.length === 0) {
        throw new BadRequestException(
          'Cannot start negotiation: no draft mappings exist for this project.',
        );
      }

      /* 100% allocation gate. The center cannot launch a round until the
       * project is fully allocated: the sum of allocation_percentage over
       * ALL non-removed mappings (drafts + any already-negotiating/agreed)
       * must equal exactly 100. This mirrors the lock gate so a round can
       * only go live when it's balanced. */
      const active = await manager.find(ProjectMapping, {
        where: { projectId },
      });
      const total = active
        .filter((m) => m.status !== MappingStatus.REMOVED)
        .reduce((sum, m) => sum + Number(m.allocationPercentage), 0);
      if (Math.abs(total - 100) > 0.01) {
        throw new BadRequestException(
          `Cannot start negotiation: allocations total ${total}%, must equal 100% before the round can begin.`,
        );
      }

      // Bulk update: drafts -> negotiating. We don't reset agreement flags
      // here — they were already cleared on entry to draft (by reopen or
      // by the create-as-draft flow), so leaving them alone keeps the row
      // honest about what's been confirmed since the last allocation edit.
      await manager
        .createQueryBuilder()
        .update(ProjectMapping)
        .set({ status: MappingStatus.NEGOTIATING })
        .where('project_id = :projectId', { projectId })
        .andWhere('status = :draft', { draft: MappingStatus.DRAFT })
        .execute();

      // Record one negotiation_started event per promoted mapping so the
      // consolidated stream shows which programs (re)entered negotiation.
      const role = this.toActorRole(user);
      for (const m of drafts) {
        const event = new MappingNegotiation();
        event.mappingId = m.id;
        event.actorId = user.id;
        event.actorRole = role;
        event.eventType = NegotiationEventType.NEGOTIATION_STARTED;
        event.proposedAllocation = m.allocationPercentage;
        event.justification = null;
        await manager.save(MappingNegotiation, event);
      }

      this.logger.log(
        `Project ${projectId} negotiation started by user ${user.id}: ${drafts.length} mapping(s) promoted to negotiating`,
      );

      return project;
    });

    this.negotiationGateway.emitProjectUpdate(
      projectId,
      'project.negotiation_started',
    );

    /* Audit the round restart at the project level. Per-mapping promotion
     * events live in mapping_negotiations as `negotiation_started` rows. */
    await this.auditService.record({
      entityType: AuditEntityType.PROJECT,
      entityId: projectId,
      action: 'project.negotiation_started',
    });

    return result;
  }

  /**
   * RBAC gate shared by lock/reopen: workflow_admin OR center_rep
   * whose centerId matches the project's centerId. Admin is excluded
   * — admins can read negotiation state but cannot mutate it.
   *
   * NOTE: user.centerId is the active center, possibly overlaid by
   * ActiveCenterInterceptor. All center_rep equality checks in this file
   * follow the same overlay model.
   */
  private assertCanToggleLock(project: Project, user: User): void {
    if (user.role === UserRole.WORKFLOW_ADMIN) {
      return;
    }
    if (
      user.role === UserRole.CENTER_REP &&
      user.centerId === project.centerId
    ) {
      return;
    }
    throw new ForbiddenException(
      'Only workflow admins or the project center representative can toggle lock state',
    );
  }

  /**
   * Asserts that a project's non-removed mappings total exactly 100%.
   *
   * The 100% allocation gate for going live: the center cannot open a
   * draft (`openNegotiation`) or launch the round (`startNegotiationRound`)
   * until every percentage point is allocated. Mirrors the lock gate.
   *
   * @throws BadRequestException when the sum is not 100 (±0.01 tolerance).
   */
  private async assertProjectFullyAllocated(projectId: number): Promise<void> {
    const mappings = await this.mappingRepository.find({
      where: { projectId },
    });
    const total = mappings
      .filter((m) => m.status !== MappingStatus.REMOVED)
      .reduce((sum, m) => sum + Number(m.allocationPercentage), 0);
    if (Math.abs(total - 100) > 0.01) {
      throw new BadRequestException(
        `Cannot start negotiation: allocations total ${total}%, must equal 100% before the round can begin.`,
      );
    }
  }

  // ─── Queries ──────────────────────────────────────────────────────

  /**
   * Retrieves a paginated list of mappings with role-based filtering.
   *
   * - Admin: sees all mappings.
   * - Program rep: sees only negotiating/agreed/locked for their program (not draft/removed).
   * - Center rep: sees mappings for projects belonging to their center.
   */
  async findAll(
    query: MappingQueryDto,
    user: User,
  ): Promise<{
    data: ProjectMapping[];
    total: number;
    page: number;
    limit: number;
  }> {
    // NOTE: user.centerId reflects the active center (possibly overlaid by
    // ActiveCenterInterceptor from X-Active-Center). For a multi-center
    // center_rep, the list is scoped to whichever center is currently
    // active — not their primary. The center-exclusion filter below also
    // uses the active center so excluded projects in the active center
    // are hidden.
    const qb = this.mappingRepository
      .createQueryBuilder('mapping')
      .leftJoinAndSelect('mapping.project', 'project')
      .leftJoinAndSelect('project.center', 'center')
      .leftJoinAndSelect('mapping.program', 'program')
      .leftJoinAndSelect('mapping.initiatedBy', 'initiator');

    /* Role-based access scoping. Admin and workflow_admin see every
     * mapping; the others are scoped to their program / center. */
    if (user.role === UserRole.PROGRAM_REP) {
      qb.andWhere('mapping.programId = :userProgramId', {
        userProgramId: user.programId,
      });
      // Program reps don't see drafts or removed
      qb.andWhere('mapping.status NOT IN (:...hiddenStatuses)', {
        hiddenStatuses: [MappingStatus.DRAFT, MappingStatus.REMOVED],
      });
    } else if (user.role === UserRole.CENTER_REP) {
      qb.andWhere('project.centerId = :userCenterId', {
        userCenterId: user.centerId,
      });

      /* Hide mappings for projects the center rep's center has excluded,
       * consistent with the project list's default filter behaviour. */
      if (user.centerId) {
        qb.andWhere(
          `NOT EXISTS (
            SELECT 1 FROM project_exclusions pe_map
            WHERE pe_map.project_id = project.id
              AND pe_map.center_id = :mapExcludingCenterId
          )`,
          { mapExcludingCenterId: user.centerId },
        );
      }
    }
    /* Admin and workflow_admin see everything (no scoping). */

    /* Optional filters */
    if (query.status) {
      qb.andWhere('mapping.status = :status', { status: query.status });
    }
    if (query.programId) {
      qb.andWhere('mapping.programId = :programId', {
        programId: query.programId,
      });
    }
    if (query.projectId) {
      qb.andWhere('mapping.projectId = :projectId', {
        projectId: query.projectId,
      });
    }
    if (query.search) {
      qb.andWhere('project.name LIKE :search', {
        search: `%${query.search}%`,
      });
    }

    /* Pagination */
    const offset = (query.page - 1) * query.limit;
    qb.orderBy('mapping.created_at', 'DESC').offset(offset).limit(query.limit);

    const [data, total] = await qb.getManyAndCount();

    return { data, total, page: query.page, limit: query.limit };
  }

  /**
   * Retrieves a single mapping by ID with access control.
   */
  async findOne(
    id: number,
    user: User,
  ): Promise<ProjectMapping & { tocLinks: MappingTocLinksPayload }> {
    const mapping = await this.findOneInternal(id);
    this.checkReadAccess(mapping, user);
    const tocLinks = await this.hydrateTocLinks(id);
    /* Attach TOC links so the consolidated page and any direct
     * GET /mappings/:id consumer get the full picture in one call. */
    return Object.assign(mapping, { tocLinks });
  }

  /**
   * Returns the negotiation thread (conversation history) for a mapping.
   */
  async getNegotiationThread(
    mappingId: number,
    user: User,
  ): Promise<{ mapping: ProjectMapping; negotiations: MappingNegotiation[] }> {
    const mapping = await this.findOneInternal(mappingId);
    this.checkReadAccess(mapping, user);

    const negotiations = await this.negotiationRepository.find({
      where: { mappingId },
      relations: ['actor'],
      order: { createdAt: 'ASC' },
    });

    return { mapping, negotiations };
  }

  /**
   * Returns the allocation summary for a project.
   */
  async getAllocationSummary(projectId: number): Promise<AllocationSummary> {
    const project = await this.projectRepository.findOneBy({ id: projectId });
    if (!project) {
      throw new NotFoundException(`Project with ID "${projectId}" not found`);
    }

    const mappings = await this.mappingRepository.find({
      where: { projectId },
      relations: ['program'],
      order: { createdAt: 'ASC' },
    });

    // Non-removed mappings count toward the total
    const active = mappings.filter((m) => m.status !== MappingStatus.REMOVED);
    const totalAllocated = active.reduce(
      (sum, m) => sum + Number(m.allocationPercentage),
      0,
    );
    const allAgreed =
      active.length > 0 &&
      active.every((m) => m.status === MappingStatus.AGREED);
    const isLocked = project.negotiationLocked;
    // Lock-eligible: all active mappings agreed AND no over-allocation.
    // Under-allocation (e.g. 80% mapped, 20% unallocated) is allowed.
    const isComplete = allAgreed && totalAllocated - 100 <= 0.01;

    return {
      totalAllocated,
      remaining: 100 - totalAllocated,
      isComplete,
      isLocked,
      canLock: isComplete && !isLocked,
      mappings: mappings.map((m) => ({
        id: m.id,
        programId: m.programId,
        programName: m.program.name,
        allocation: Number(m.allocationPercentage),
        status: m.status,
        centerAgreed: m.centerAgreed,
        programAgreed: m.programAgreed,
        complementarityRating: m.complementarityRating,
        efficiencyRating: m.efficiencyRating,
      })),
    };
  }

  /**
   * Returns mappings for a project with role-scoped visibility.
   *
   * - Admin / workflow_admin: all mappings.
   * - Center rep (matching center): all mappings.
   * - Any other authenticated user (program_rep / center_rep of another
   *   center): all non-draft, non-removed mappings (read-only audit view).
   */
  async getReviewSummary(
    projectId: number,
    user: User,
  ): Promise<ProjectMapping[]> {
    const project = await this.projectRepository.findOneBy({ id: projectId });
    if (!project) {
      throw new NotFoundException(`Project with ID "${projectId}" not found`);
    }

    const isOwningCenterRep =
      user.role === UserRole.CENTER_REP && user.centerId === project.centerId;
    const canSeeAll =
      user.role === UserRole.ADMIN ||
      user.role === UserRole.WORKFLOW_ADMIN ||
      isOwningCenterRep;

    const qb = this.mappingRepository
      .createQueryBuilder('mapping')
      .leftJoinAndSelect('mapping.project', 'project')
      .leftJoinAndSelect('project.center', 'center')
      .leftJoinAndSelect('mapping.program', 'program')
      .leftJoinAndSelect('mapping.initiatedBy', 'initiator')
      .where('mapping.projectId = :projectId', { projectId })
      .orderBy('mapping.created_at', 'ASC');

    if (!canSeeAll) {
      // Non-owners see only non-draft, non-removed mappings
      qb.andWhere('mapping.status NOT IN (:...hidden)', {
        hidden: [MappingStatus.DRAFT, MappingStatus.REMOVED],
      });
    }

    return qb.getMany();
  }

  /**
   * Returns the consolidated negotiation view for a project: header,
   * lock state, totals, every non-removed mapping, AND a single
   * chronological `events` stream that merges mapping negotiation
   * audit rows with project-level chat messages.
   *
   * Single trip to the DB per source (project, mappings, negotiations,
   * chat). Actors are eager-joined to avoid N+1 when building actor
   * display names.
   */
  async getConsolidatedView(projectId: number): Promise<ConsolidatedView> {
    // Project + center header
    const project = await this.projectRepository
      .createQueryBuilder('project')
      .leftJoinAndSelect('project.center', 'center')
      .where('project.id = :projectId', { projectId })
      .getOne();

    if (!project) {
      throw new NotFoundException(`Project with ID "${projectId}" not found`);
    }

    // ALL mappings for the project (including removed) — the removed ones
    // aren't shown in the allocation pane but their negotiation events
    // still need to surface in the chat thread so the history of how a
    // program got removed isn't erased the moment removal is accepted.
    const allMappings = await this.mappingRepository
      .createQueryBuilder('mapping')
      .leftJoinAndSelect('mapping.program', 'program')
      .where('mapping.projectId = :projectId', { projectId })
      .orderBy('mapping.created_at', 'ASC')
      .getMany();

    // Active subset — drives the right-pane allocation table and totals.
    const mappings = allMappings.filter(
      (m) => m.status !== MappingStatus.REMOVED,
    );

    // Fast lookup: mappingId -> programName, for labeling mapping events.
    // Built from `allMappings` so removed-mapping events still get their
    // program name in the chat (instead of rendering as null/blank).
    const programNameByMapping = new Map<number, string>();
    for (const m of allMappings) {
      programNameByMapping.set(m.id, m.program?.name ?? '');
    }

    // Negotiation events for every mapping on the project, removed or not.
    const mappingIds = allMappings.map((m) => m.id);
    const negotiationRows = mappingIds.length
      ? await this.negotiationRepository
          .createQueryBuilder('event')
          .leftJoinAndSelect('event.actor', 'actor')
          .where('event.mappingId IN (:...ids)', { ids: mappingIds })
          .orderBy('event.created_at', 'ASC')
          .getMany()
      : [];

    // Project-level chat messages
    const chatRows = await this.chatMessageRepository
      .createQueryBuilder('msg')
      .leftJoinAndSelect('msg.actor', 'actor')
      .where('msg.projectId = :projectId', { projectId })
      .orderBy('msg.created_at', 'ASC')
      .getMany();

    // Merge both sources into one chronological stream
    const events: ConsolidatedEvent[] = [
      ...negotiationRows.map((ev) =>
        this.toMappingEvent(ev, programNameByMapping.get(ev.mappingId) ?? null),
      ),
      ...chatRows.map((msg) => this.toChatEvent(msg)),
    ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    // Batched TOC link hydration for all active mappings — three
    // queries total (one per link_type) rather than 3 per mapping.
    const tocLinksByMapping = await this.hydrateTocLinksForMappings(
      mappings.map((m) => m.id),
    );
    const emptyTocLinks: MappingTocLinksPayload = {
      aows: [],
      outputs: [],
      outcomes: [],
    };

    const totalAllocated = mappings.reduce(
      (sum, m) => sum + Number(m.allocationPercentage),
      0,
    );
    // Lock-eligible: at least one active mapping, all of them agreed,
    // and no over-allocation. Under-100 is intentional and allowed.
    const canLock =
      mappings.length > 0 &&
      mappings.every((m) => m.status === MappingStatus.AGREED) &&
      totalAllocated - 100 <= 0.01 &&
      !project.negotiationLocked;

    return {
      project: {
        id: project.id,
        code: project.code,
        name: project.name,
        center: {
          id: project.center?.id ?? project.centerId,
          name: project.center?.name ?? '',
        },
      },
      isLocked: project.negotiationLocked,
      canLock,
      totalAllocated,
      unallocated: 100 - totalAllocated,
      mappings: mappings.map((m) => ({
        id: m.id,
        programId: m.programId,
        programName: m.program?.name ?? '',
        allocationPercentage: Number(m.allocationPercentage),
        status: m.status,
        centerAgreed: m.centerAgreed,
        programAgreed: m.programAgreed,
        needsAssistance: Boolean(m.needsAssistance),
        flaggedAt: m.flaggedAt,
        complementarityRating: m.complementarityRating,
        efficiencyRating: m.efficiencyRating,
        removalRequested: Boolean(m.removalRequested),
        removalRequestedById: m.removalRequestedById,
        removalRequestedAt: m.removalRequestedAt,
        removalJustification: m.removalJustification,
        tocLinks: tocLinksByMapping.get(m.id) ?? emptyTocLinks,
      })),
      events,
    };
  }

  /**
   * Posts a free-text chat message on a project's consolidated
   * negotiation thread.
   *
   * RBAC: admin, the owning center rep of the project, or a program
   * rep whose `user.programId` matches a non-removed mapping on the
   * project. Rejected if the project's negotiation is locked.
   */
  async postChatMessage(
    projectId: number,
    message: string,
    user: User,
  ): Promise<ConsolidatedEvent> {
    // Load the project to check the lock flag and ownership
    const project = await this.projectRepository.findOne({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundException(`Project with ID "${projectId}" not found`);
    }
    if (project.negotiationLocked) {
      throw new ForbiddenException(
        'Project negotiation is locked; chat is read-only',
      );
    }

    // Authorization check — admin / center rep of project / program rep
    // with a non-removed mapping on this project
    await this.assertCanChat(project, user);

    // Persist the message
    const entity = this.chatMessageRepository.create({
      projectId,
      actorId: user.id,
      message,
    });
    const saved = await this.chatMessageRepository.save(entity);

    // Re-read with actor relation so we can build a consistent event
    // payload (actor name/role) without trusting the in-memory `user`
    // in case of stale fields.
    const withActor = await this.chatMessageRepository
      .createQueryBuilder('msg')
      .leftJoinAndSelect('msg.actor', 'actor')
      .where('msg.id = :id', { id: saved.id })
      .getOne();

    this.logger.log(
      `Chat message posted: project=${projectId} actor=${user.id} messageId=${saved.id}`,
    );

    this.negotiationGateway.emitProjectUpdate(projectId, 'chat.posted');
    return this.toChatEvent(withActor ?? saved);
  }

  /**
   * Verifies the caller is allowed to post a chat message on this
   * project. Throws `ForbiddenException` otherwise.
   */
  private async assertCanChat(project: Project, user: User): Promise<void> {
    // workflow_admin is the cross-center arbiter and may chat on any
    // project. Admin is intentionally excluded.
    if (user.role === UserRole.WORKFLOW_ADMIN) {
      return;
    }
    if (
      user.role === UserRole.CENTER_REP &&
      user.centerId &&
      user.centerId === project.centerId
    ) {
      return;
    }
    if (user.role === UserRole.PROGRAM_REP && user.programId) {
      // Program rep must own at least one non-removed mapping on this
      // project. A single count query keeps this cheap.
      const count = await this.mappingRepository
        .createQueryBuilder('mapping')
        .where('mapping.projectId = :projectId', { projectId: project.id })
        .andWhere('mapping.programId = :programId', {
          programId: user.programId,
        })
        .andWhere('mapping.status != :removed', {
          removed: MappingStatus.REMOVED,
        })
        .getCount();
      if (count > 0) {
        return;
      }
    }
    throw new ForbiddenException(
      'You do not have permission to post on this project',
    );
  }

  /**
   * Rejects creation of a new mapping when the project already has
   * MAX_ACTIVE_MAPPINGS_PER_PROJECT non-removed mappings. Removed rows
   * are excluded so a center can swap a program out and another in.
   */
  private async assertMappingCapNotExceeded(projectId: number): Promise<void> {
    const activeCount = await this.mappingRepository
      .createQueryBuilder('mapping')
      .where('mapping.projectId = :projectId', { projectId })
      .andWhere('mapping.status != :removed', {
        removed: MappingStatus.REMOVED,
      })
      .getCount();

    if (activeCount >= MAX_ACTIVE_MAPPINGS_PER_PROJECT) {
      throw new BadRequestException(
        `A project can have at most ${MAX_ACTIVE_MAPPINGS_PER_PROJECT} program mappings`,
      );
    }
  }

  /** Formats a mapping negotiation row as a ConsolidatedEvent. */
  private toMappingEvent(
    ev: MappingNegotiation,
    programName: string | null,
  ): ConsolidatedEvent {
    return {
      id: ev.id,
      kind: 'mapping',
      mappingId: ev.mappingId,
      programName,
      actorId: ev.actorId,
      // ActorRole values map 1:1 onto UserRole values for the four roles
      // we model — the cast is safe because both enums share the same
      // string literals (`admin`, `workflow_admin`, `center_rep`,
      // `program_rep`). Older rows stored prior to A3 will still be
      // `center_rep` for events triggered by an admin.
      actorRole: ev.actorRole as unknown as UserRole,
      actorName: ev.actor
        ? `${ev.actor.firstName ?? ''} ${ev.actor.lastName ?? ''}`.trim() ||
          ev.actor.email
        : '',
      eventType: ev.eventType,
      proposedPercentage:
        ev.proposedAllocation === null ? null : Number(ev.proposedAllocation),
      message: ev.justification,
      createdAt: ev.createdAt,
    };
  }

  /** Formats a project chat message row as a ConsolidatedEvent. */
  private toChatEvent(msg: ProjectNegotiationMessage): ConsolidatedEvent {
    return {
      id: msg.id,
      kind: 'message',
      mappingId: null,
      programName: null,
      actorId: msg.actorId,
      actorRole: (msg.actor?.role as UserRole) ?? UserRole.ADMIN,
      actorName: msg.actor
        ? `${msg.actor.firstName ?? ''} ${msg.actor.lastName ?? ''}`.trim() ||
          msg.actor.email
        : '',
      eventType: 'message',
      proposedPercentage: null,
      message: msg.message,
      createdAt: msg.createdAt,
    };
  }

  /**
   * Inline update of a mapping's allocation percentage from the
   * consolidated allocation pane. Treated as a counter-proposal in
   * audit terms but with the proposer's side implicitly agreed —
   * mirrors `counterPropose()` so a center rep tweaking the % from
   * the right pane doesn't have to also click Agree afterwards to
   * close the loop. The other side still has to agree.
   *
   * No-op edits (same percentage as before) short-circuit and do not
   * reset agreement flags or write an audit event — guards against the
   * "I saved 50% over 50% and it cleared everyone's agreement" footgun.
   *
   * Rejected when the project is locked.
   */
  async updateAllocation(
    mappingId: number,
    dto: UpdateAllocationDto,
    user: User,
  ): Promise<ProjectMapping> {
    const newPercentage = dto.allocationPercentage;
    const mapping = await this.findOneInternal(mappingId);

    if (mapping.project.negotiationLocked) {
      throw new ForbiddenException(
        'Project negotiation is locked; allocations cannot be modified',
      );
    }

    // RBAC: admin, workflow_admin, owning center_rep, or owning program_rep.
    const actorRole = this.resolveAllocationActorRole(mapping, user);

    // Editor's "side" — admin / workflow_admin / center_rep all act on
    // behalf of the center; program_rep acts on the program side. Resolved
    // up-front so the rating gate can run before any short-circuit paths.
    const side: 'center' | 'program' =
      actorRole === ActorRole.PROGRAM_REP ? 'program' : 'center';

    // Pre-compute whether the % is changing so the no-op guard below can
    // distinguish "rating-only edit" from "true no-op".
    const allocationChanged =
      Number(mapping.allocationPercentage) !== Number(newPercentage);

    /* Center-side rating gate: when the editor acts on behalf of the
     * center, BOTH ratings are required and applied to the mapping.
     * Program rep edits ignore rating fields entirely (program reps
     * never set ratings). Throws BadRequestException if a center-side
     * caller omits either rating. Runs BEFORE the no-op short-circuit
     * so a center-side caller that only tweaks ratings still persists. */
    const ratingsChanged =
      side === 'center' &&
      (mapping.complementarityRating !== dto.complementarityRating ||
        mapping.efficiencyRating !== dto.efficiencyRating);
    this.validateAndApplyCenterRatings(mapping, side, dto);

    // No-op guard: nothing changed (same %, same ratings). Return as-is
    // without resetting agreement flags or appending an audit event.
    if (!allocationChanged && !ratingsChanged) {
      return mapping;
    }

    // Rating-only edit: persist the new ratings and append a
    // RATING_UPDATED event so the qualitative scoring history is
    // visible alongside allocation moves. Agreement flags and status
    // are intentionally NOT touched — only the negotiated allocation
    // resets agreement; ratings are a parallel center-side concern.
    if (!allocationChanged) {
      const result = await this.dataSource.transaction(async (manager) => {
        await manager.save(ProjectMapping, mapping);

        const event = new MappingNegotiation();
        event.mappingId = mappingId;
        event.actorId = user.id;
        event.actorRole = actorRole;
        event.eventType = NegotiationEventType.RATING_UPDATED;
        event.proposedAllocation = null;
        event.justification = null;
        await manager.save(MappingNegotiation, event);

        return manager.findOne(ProjectMapping, {
          where: { id: mappingId },
          relations: ['project', 'project.center', 'program', 'initiatedBy'],
        }) as Promise<ProjectMapping>;
      });
      this.negotiationGateway.emitProjectUpdate(
        mapping.projectId,
        'allocation.updated',
      );
      return result;
    }

    // Draft path: drafts are pre-negotiation and only the center side
    // (or admin / workflow_admin) can touch them. Ratings already applied
    // above. No agree-flag toggles — the row is being shaped before
    // Start Negotiation promotes it. Still append a COUNTER_PROPOSED
    // event so the timeline records every allocation move (the user's
    // explicit "nothing should be updated silently" requirement).
    if (mapping.status === MappingStatus.DRAFT) {
      if (actorRole === ActorRole.PROGRAM_REP) {
        throw new ForbiddenException('Program reps cannot edit draft mappings');
      }
      // Center-side draft edits (typically the "Propose" popover after a
      // project reopen) require a justification ≥ 10 chars. The DTO
      // declares it optional so program reps can omit ratings on the
      // shared non-draft inline editor; the draft-specific requirement
      // is enforced here at the service layer to match the popover UX
      // and persisted on the appended event so the timeline carries the
      // reason.
      const justification = dto.justification?.trim() ?? '';
      if (justification.length < 10) {
        throw new BadRequestException(
          'Justification (min 10 chars) is required when editing a draft allocation',
        );
      }

      const result = await this.dataSource.transaction(async (manager) => {
        mapping.allocationPercentage = newPercentage;
        await manager.save(ProjectMapping, mapping);

        const event = new MappingNegotiation();
        event.mappingId = mappingId;
        event.actorId = user.id;
        event.actorRole = actorRole;
        event.eventType = NegotiationEventType.COUNTER_PROPOSED;
        event.proposedAllocation = newPercentage;
        event.justification = justification;
        await manager.save(MappingNegotiation, event);

        return manager.findOne(ProjectMapping, {
          where: { id: mappingId },
          relations: ['project', 'project.center', 'program', 'initiatedBy'],
        }) as Promise<ProjectMapping>;
      });
      this.negotiationGateway.emitProjectUpdate(
        mapping.projectId,
        'allocation.updated',
      );
      return result;
    }

    const result = await this.dataSource.transaction(async (manager) => {
      mapping.allocationPercentage = newPercentage;
      // Implicit-agree on the editor's side, reset the other — the
      // editor proposed this number, so they're agreeing to it; the
      // other party hasn't seen it yet and must reconfirm.
      mapping.centerAgreed = side === 'center';
      mapping.programAgreed = side === 'program';
      // If already agreed, drop back to negotiating — terms changed.
      if (mapping.status === MappingStatus.AGREED) {
        mapping.status = MappingStatus.NEGOTIATING;
      }
      // Rating fields (when present and side === 'center') are already
      // mutated on `mapping` by validateAndApplyCenterRatings(); this
      // single save() persists allocation + ratings in one transaction.
      await manager.save(ProjectMapping, mapping);

      const event = new MappingNegotiation();
      event.mappingId = mappingId;
      event.actorId = user.id;
      event.actorRole = actorRole;
      event.eventType = NegotiationEventType.COUNTER_PROPOSED;
      event.proposedAllocation = newPercentage;
      event.justification = null;
      await manager.save(MappingNegotiation, event);

      this.logger.log(
        `Mapping ${mappingId} allocation updated to ${newPercentage}% by user ${user.id} (${actorRole}); ${side} side implicitly agreed`,
      );

      return manager.findOne(ProjectMapping, {
        where: { id: mappingId },
        relations: ['project', 'project.center', 'program', 'initiatedBy'],
      }) as Promise<ProjectMapping>;
    });

    this.negotiationGateway.emitProjectUpdate(
      mapping.projectId,
      'allocation.updated',
    );
    return result;
  }

  /**
   * URL-scoped alias for creating a mapping on a specific project.
   * Enforces the project-lock gate and RBAC (admin or owning center_rep),
   * then delegates to `create()`. Conflicts surface as 409. Both ratings
   * are required — ratings are a center-side responsibility set at
   * create + allocation edit only.
   */
  async addProgramToProject(
    projectId: number,
    programId: number,
    allocationPercentage: number,
    complementarityRating: Rating,
    efficiencyRating: Rating,
    user: User,
  ): Promise<ProjectMapping> {
    const project = await this.projectRepository.findOneBy({ id: projectId });
    if (!project) {
      throw new NotFoundException(`Project with ID "${projectId}" not found`);
    }

    if (project.negotiationLocked) {
      throw new ForbiddenException(
        'Project negotiation is locked; programs cannot be added',
      );
    }

    // RBAC: workflow_admin or owning center rep. Admin is excluded.
    const isWorkflowAdmin = user.role === UserRole.WORKFLOW_ADMIN;
    const isOwningCenterRep =
      user.role === UserRole.CENTER_REP && user.centerId === project.centerId;
    if (!isWorkflowAdmin && !isOwningCenterRep) {
      throw new ForbiddenException(
        'Only workflow admins or the project center representative can add programs',
      );
    }

    // 409 if a non-removed mapping already exists
    const existing = await this.mappingRepository.findOneBy({
      projectId,
      programId,
    });
    if (existing && existing.status !== MappingStatus.REMOVED) {
      throw new ConflictException(
        'Mapping already exists for this project and program',
      );
    }

    await this.assertMappingCapNotExceeded(projectId);

    // workflow_admin routes through the elevated path so we skip the
    // center_rep ownership gate inside create() while keeping the
    // audit row attributed to the actor's real role.
    if (isWorkflowAdmin) {
      return this.createAsAdminOrCenter(
        projectId,
        programId,
        allocationPercentage,
        complementarityRating,
        efficiencyRating,
        user,
        project.centerId,
      );
    }

    return this.create(
      {
        projectId,
        programId,
        allocationPercentage,
        complementarityRating,
        efficiencyRating,
      },
      user,
    );
  }

  /**
   * Internal variant of create() that skips the center_rep role gate so
   * admins can create mappings via the consolidated page. Mirrors the
   * transactional behavior of create(): reuses removed rows and records
   * an `initiated` event attributed to the caller.
   */
  private async createAsAdminOrCenter(
    projectId: number,
    programId: number,
    allocationPercentage: number,
    complementarityRating: Rating,
    efficiencyRating: Rating,
    user: User,
    projectCenterId: number,
  ): Promise<ProjectMapping> {
    const program = await this.programRepository.findOneBy({ id: programId });
    if (!program) {
      throw new NotFoundException(`Program with ID "${programId}" not found`);
    }

    const existing = await this.mappingRepository.findOneBy({
      projectId,
      programId,
    });

    const now = new Date();

    const result = await this.dataSource.transaction(async (manager) => {
      let saved: ProjectMapping;

      if (existing) {
        existing.allocationPercentage = allocationPercentage;
        // Starts as draft — invisible to programs until Start Negotiation.
        existing.status = MappingStatus.DRAFT;
        existing.centerAgreed = false;
        existing.programAgreed = false;
        existing.initiatedById = user.id;
        existing.initiatedAt = now;
        existing.rejectionReason = null;
        existing.complementarityRating = complementarityRating;
        existing.efficiencyRating = efficiencyRating;
        saved = await manager.save(ProjectMapping, existing);
      } else {
        const mapping = new ProjectMapping();
        mapping.projectId = projectId;
        mapping.programId = programId;
        mapping.allocationPercentage = allocationPercentage;
        // Starts as draft — invisible to programs until Start Negotiation.
        mapping.status = MappingStatus.DRAFT;
        mapping.centerAgreed = false;
        mapping.programAgreed = false;
        mapping.initiatedById = user.id;
        mapping.initiatedAt = now;
        mapping.complementarityRating = complementarityRating;
        mapping.efficiencyRating = efficiencyRating;
        mapping.submittedById = user.id;
        mapping.submittedAt = now;
        saved = await manager.save(ProjectMapping, mapping);
      }

      const event = new MappingNegotiation();
      event.mappingId = saved.id;
      event.actorId = user.id;
      // Record the actor's real role — admin / workflow_admin are
      // first-class actor roles since A3 widened the enum.
      event.actorRole = this.toActorRole(user);
      event.eventType = NegotiationEventType.INITIATED;
      event.proposedAllocation = allocationPercentage;
      await manager.save(MappingNegotiation, event);

      this.logger.log(
        `Program ${programId} added to project ${projectId} by user ${user.id} (center ${projectCenterId})`,
      );

      return manager.findOne(ProjectMapping, {
        where: { id: saved.id },
        relations: ['project', 'project.center', 'program', 'initiatedBy'],
      }) as Promise<ProjectMapping>;
    });

    this.negotiationGateway.emitProjectUpdate(projectId, 'program.added');
    return result;
  }

  /**
   * RBAC resolver for `updateAllocation`. Validates that the user can
   * touch the allocation and returns the ActorRole to record on the
   * audit row. Admin is intentionally excluded from negotiation
   * mutations — workflow_admin is the system-office arbiter instead.
   */
  private resolveAllocationActorRole(
    mapping: ProjectMapping,
    user: User,
  ): ActorRole {
    if (user.role === UserRole.WORKFLOW_ADMIN) {
      return ActorRole.WORKFLOW_ADMIN;
    }
    if (
      user.role === UserRole.CENTER_REP &&
      user.centerId === mapping.project.centerId
    ) {
      return ActorRole.CENTER_REP;
    }
    if (
      user.role === UserRole.PROGRAM_REP &&
      user.programId === mapping.programId
    ) {
      return ActorRole.PROGRAM_REP;
    }
    throw new ForbiddenException(
      'You do not have access to update this allocation',
    );
  }

  // ─── Private helpers ──────────────────────────────────────────────

  /** Loads a mapping by ID with all relations. Throws if not found. */
  private async findOneInternal(id: number): Promise<ProjectMapping> {
    const mapping = await this.mappingRepository.findOne({
      where: { id },
      relations: ['project', 'project.center', 'program', 'initiatedBy'],
    });

    if (!mapping) {
      throw new NotFoundException(`Mapping with ID "${id}" not found`);
    }

    return mapping;
  }

  /** Checks that the user has read access to the given mapping. */
  private checkReadAccess(mapping: ProjectMapping, user: User): void {
    // Admin and workflow_admin can read any mapping (workflow_admin
    // arbitrates across centers — they need the full picture).
    if (user.role === UserRole.ADMIN || user.role === UserRole.WORKFLOW_ADMIN) {
      return;
    }

    if (
      user.role === UserRole.PROGRAM_REP &&
      mapping.programId === user.programId
    ) {
      // Program reps can't see drafts
      if (mapping.status === MappingStatus.DRAFT) {
        throw new ForbiddenException('You do not have access to this mapping');
      }
      return;
    }

    if (
      user.role === UserRole.CENTER_REP &&
      mapping.project.centerId === user.centerId
    ) {
      return;
    }

    throw new ForbiddenException('You do not have access to this mapping');
  }

  /**
   * Validates that the user is a center rep who owns the project
   * this mapping belongs to.
   */
  private validateCenterRepOwnership(
    mapping: ProjectMapping,
    user: User,
  ): void {
    if (user.role !== UserRole.CENTER_REP) {
      throw new ForbiddenException(
        'Only center representatives can perform this action',
      );
    }
    if (user.centerId !== mapping.project.centerId) {
      throw new ForbiddenException(
        'You can only manage mappings for projects in your center',
      );
    }
  }

  /**
   * Validates that the user can participate in negotiation for this mapping.
   *
   * Returns:
   *  - `actorRole` — what to record on the negotiation event (admin and
   *    workflow_admin are recorded as themselves rather than collapsed
   *    into `center_rep`).
   *  - `side` — which side's agreement flag (`centerAgreed` /
   *    `programAgreed`) the actor's confirmation should set. Admin and
   *    workflow_admin are treated as the center side because they act
   *    on behalf of the project's owning center.
   */
  private validateNegotiationAccess(
    mapping: ProjectMapping,
    user: User,
  ): { actorRole: ActorRole; side: 'center' | 'program' } {
    // Admin is intentionally excluded from all negotiation mutations —
    // they retain read access only. workflow_admin is the cross-center
    // arbiter and acts on the center side.
    //
    // NOTE: For multi-center reps, user.centerId is the active center
    // (overlaid by ActiveCenterInterceptor). A rep can only act on a
    // mapping in their currently active center; switching the
    // X-Active-Center header shifts the scope.
    if (user.role === UserRole.WORKFLOW_ADMIN) {
      return { actorRole: ActorRole.WORKFLOW_ADMIN, side: 'center' };
    }
    if (
      user.role === UserRole.CENTER_REP &&
      user.centerId === mapping.project.centerId
    ) {
      return { actorRole: ActorRole.CENTER_REP, side: 'center' };
    }
    if (
      user.role === UserRole.PROGRAM_REP &&
      user.programId === mapping.programId
    ) {
      return { actorRole: ActorRole.PROGRAM_REP, side: 'program' };
    }

    throw new ForbiddenException(
      'You do not have access to negotiate this mapping',
    );
  }

  /**
   * Maps a User to the matching ActorRole for audit rows. Used by call
   * sites that have already verified RBAC and just need to stamp the
   * actor's real role onto the event.
   */
  private toActorRole(user: User): ActorRole {
    switch (user.role) {
      case UserRole.ADMIN:
        return ActorRole.ADMIN;
      case UserRole.WORKFLOW_ADMIN:
        return ActorRole.WORKFLOW_ADMIN;
      case UserRole.PROGRAM_REP:
        return ActorRole.PROGRAM_REP;
      case UserRole.CENTER_REP:
      default:
        return ActorRole.CENTER_REP;
    }
  }

  /**
   * Center-side rating gate for `updateAllocation()`. Ratings are a
   * center-side responsibility — set on create / add-program /
   * allocation edit only. Program-rep allocation edits ignore rating
   * fields entirely.
   *
   * Behavior:
   *  - side === 'center': BOTH `complementarityRating` and
   *    `efficiencyRating` are required. Missing/invalid →
   *    BadRequestException. Both fields are written to the in-memory
   *    `mapping` (latest wins).
   *  - side === 'program': rating fields in the body are silently
   *    ignored — never persisted, never error.
   *
   * The mapping mutation participates in the caller's existing
   * transactional save — this helper does NOT save anything itself.
   */
  private validateAndApplyCenterRatings(
    mapping: ProjectMapping,
    side: 'center' | 'program',
    dto: { complementarityRating?: Rating; efficiencyRating?: Rating },
  ): void {
    if (side !== 'center') {
      return;
    }

    if (!dto.complementarityRating || !dto.efficiencyRating) {
      throw new BadRequestException(
        'Both complementarityRating and efficiencyRating are required when the center side edits an allocation.',
      );
    }

    mapping.complementarityRating = dto.complementarityRating;
    mapping.efficiencyRating = dto.efficiencyRating;
  }

  // ─── TOC contribution links ───────────────────────────────────────

  /**
   * Replaces the TOC contribution links on a mapping with the
   * submitted set (atomic delete-all + reinsert in one transaction).
   *
   * Authoriztion: program rep for the mapping's program OR
   * workflow_admin. Other roles → 403.
   *
   * State gate: mapping must be `negotiating` or `agreed` and the
   * project must NOT be locked. Drafts are private to the center rep
   * and link editing is not allowed there.
   *
   * Validation: every submitted id must belong to `mapping.programId`.
   * Outcome ids are additionally constrained to
   * `outcome_type='intermediate'`. Cross-program or unknown ids
   * produce a single 400 listing every offending id.
   *
   * Audit: appends exactly one `toc_updated` event to
   * `mapping_negotiations` regardless of whether the new set differs
   * from the prior one. Agreement flags (`centerAgreed` /
   * `programAgreed`) are NOT reset — link updates are an
   * implementation detail of the program's commitment, not a
   * renegotiation of allocation.
   *
   * Returns the hydrated link payload so the consolidated page can
   * refresh inline without a follow-up GET.
   */
  async setTocLinks(
    mappingId: number,
    dto: SetTocLinksDto,
    user: User,
  ): Promise<MappingTocLinksPayload> {
    const mapping = await this.findOneInternal(mappingId);

    // RBAC — only program reps for the mapping's program or
    // workflow_admin can edit. Reuse the negotiation-access check so
    // the rules stay aligned; then narrow to the program side.
    if (
      user.role !== UserRole.WORKFLOW_ADMIN &&
      !(
        user.role === UserRole.PROGRAM_REP &&
        user.programId === mapping.programId
      )
    ) {
      throw new ForbiddenException(
        'Only the program rep or workflow admin can edit TOC links on this mapping',
      );
    }

    // State gate — drafts and removed mappings reject; locked projects
    // reject. NEGOTIATING and AGREED are allowed (link edits don't
    // change agreement flags, so editing on an agreed mapping is safe).
    if (
      mapping.status !== MappingStatus.NEGOTIATING &&
      mapping.status !== MappingStatus.AGREED
    ) {
      throw new BadRequestException(
        'TOC links can only be edited while the mapping is negotiating or agreed',
      );
    }
    if (mapping.project.negotiationLocked) {
      throw new ForbiddenException(
        'Project negotiation is locked; TOC links cannot be edited',
      );
    }

    const aowIds = dto.aowIds ?? [];
    const outputIds = dto.outputIds ?? [];
    const outcomeIds = dto.outcomeIds ?? [];

    /* Validate every submitted id belongs to the mapping's program.
     * Outcome ids must additionally be `intermediate`. We collect
     * offenders by type so the error message points the caller at
     * the exact rows that need fixing. */
    await this.assertTocIdsBelongToProgram(
      mapping.programId,
      aowIds,
      outputIds,
      outcomeIds,
    );

    const actorRole = this.toActorRole(user);

    await this.dataSource.transaction(async (manager) => {
      // Atomic replace — drop everything then reinsert. Cheap because
      // the per-mapping row count is small.
      await manager.delete(MappingTocLink, {
        projectMappingId: String(mappingId),
      });

      const rows: MappingTocLink[] = [];
      const buildRow = (linkType: MappingTocLinkType, tocId: number) => {
        const r = new MappingTocLink();
        r.projectMappingId = String(mappingId);
        r.linkType = linkType;
        r.tocId = String(tocId);
        r.createdByUserId = user.id !== undefined ? String(user.id) : null;
        return r;
      };
      for (const id of aowIds) rows.push(buildRow(MappingTocLinkType.AOW, id));
      for (const id of outputIds)
        rows.push(buildRow(MappingTocLinkType.OUTPUT, id));
      for (const id of outcomeIds)
        rows.push(buildRow(MappingTocLinkType.OUTCOME, id));

      if (rows.length > 0) {
        await manager.save(MappingTocLink, rows);
      }

      // Append the audit event. `proposed_allocation` and `justification`
      // are null — the row payload is the link set.
      const event = new MappingNegotiation();
      event.mappingId = mappingId;
      event.actorId = user.id;
      event.actorRole = actorRole;
      event.eventType = NegotiationEventType.TOC_UPDATED;
      event.justification = null;
      await manager.save(MappingNegotiation, event);
    });

    this.logger.log(
      `Mapping ${mappingId}: ${actorRole} updated TOC links (aows=${aowIds.length}, outputs=${outputIds.length}, outcomes=${outcomeIds.length})`,
    );

    this.negotiationGateway.emitProjectUpdate(
      mapping.projectId,
      'mapping.toc_updated',
    );

    await this.auditService.record({
      entityType: AuditEntityType.PROJECT_MAPPING,
      entityId: mappingId,
      action: 'mapping.toc_updated',
    });

    return this.hydrateTocLinks(mappingId);
  }

  /**
   * Loads the hydrated TOC link payload for one mapping.
   *
   * Three small queries — one per link_type — each joined to the
   * corresponding TOC table so the caller gets full entity rows
   * (title/name, code, parent AOW) without N+1 follow-ups.
   *
   * Empty arrays are returned when no links exist (common for legacy
   * imported mappings). Used by both `findOne()` and the consolidated
   * view.
   */
  async hydrateTocLinks(mappingId: number): Promise<MappingTocLinksPayload> {
    const links = await this.tocLinkRepository.find({
      where: { projectMappingId: String(mappingId) },
    });

    if (links.length === 0) {
      return { aows: [], outputs: [], outcomes: [] };
    }

    const aowIds = links
      .filter((l) => l.linkType === MappingTocLinkType.AOW)
      .map((l) => Number(l.tocId));
    const outputIds = links
      .filter((l) => l.linkType === MappingTocLinkType.OUTPUT)
      .map((l) => Number(l.tocId));
    const outcomeIds = links
      .filter((l) => l.linkType === MappingTocLinkType.OUTCOME)
      .map((l) => Number(l.tocId));

    const [aows, outputs, outcomes] = await Promise.all([
      aowIds.length
        ? this.tocAowRepository
            .createQueryBuilder('aow')
            .where('aow.id IN (:...ids)', { ids: aowIds })
            .orderBy('aow.wp_official_code', 'ASC')
            .getMany()
        : Promise.resolve([] as TocAow[]),
      outputIds.length
        ? this.tocOutputRepository
            .createQueryBuilder('output')
            .leftJoinAndSelect('output.aow', 'aow')
            .where('output.id IN (:...ids)', { ids: outputIds })
            .orderBy('output.title', 'ASC')
            .getMany()
        : Promise.resolve([] as TocOutput[]),
      outcomeIds.length
        ? this.tocOutcomeRepository
            .createQueryBuilder('outcome')
            .leftJoinAndSelect('outcome.aow', 'aow')
            .where('outcome.id IN (:...ids)', { ids: outcomeIds })
            .orderBy('outcome.title', 'ASC')
            .getMany()
        : Promise.resolve([] as TocOutcome[]),
    ]);

    return { aows, outputs, outcomes };
  }

  /**
   * Batched variant of {@link hydrateTocLinks} for the consolidated
   * view — one query per link_type for ALL the project's mappings,
   * then grouped by mappingId. Avoids the per-mapping 3-query fan-out
   * the consolidated page would otherwise incur.
   *
   * Returns a Map keyed by mappingId. Missing keys map to an empty
   * payload so callers can `.get(id) ?? emptyPayload`.
   */
  async hydrateTocLinksForMappings(
    mappingIds: number[],
  ): Promise<Map<number, MappingTocLinksPayload>> {
    const result = new Map<number, MappingTocLinksPayload>();
    if (mappingIds.length === 0) return result;

    const idStrings = mappingIds.map((id) => String(id));

    const links = await this.tocLinkRepository
      .createQueryBuilder('link')
      .where('link.projectMappingId IN (:...ids)', { ids: idStrings })
      .getMany();

    if (links.length === 0) {
      for (const id of mappingIds) {
        result.set(id, { aows: [], outputs: [], outcomes: [] });
      }
      return result;
    }

    // Collect distinct TOC ids per type for a single batch fetch per table.
    const aowTocIds = new Set<number>();
    const outputTocIds = new Set<number>();
    const outcomeTocIds = new Set<number>();
    for (const l of links) {
      const tocId = Number(l.tocId);
      if (l.linkType === MappingTocLinkType.AOW) aowTocIds.add(tocId);
      else if (l.linkType === MappingTocLinkType.OUTPUT)
        outputTocIds.add(tocId);
      else if (l.linkType === MappingTocLinkType.OUTCOME)
        outcomeTocIds.add(tocId);
    }

    const [aowRows, outputRows, outcomeRows] = await Promise.all([
      aowTocIds.size
        ? this.tocAowRepository
            .createQueryBuilder('aow')
            .where('aow.id IN (:...ids)', { ids: [...aowTocIds] })
            .getMany()
        : Promise.resolve([] as TocAow[]),
      outputTocIds.size
        ? this.tocOutputRepository
            .createQueryBuilder('output')
            .leftJoinAndSelect('output.aow', 'aow')
            .where('output.id IN (:...ids)', { ids: [...outputTocIds] })
            .getMany()
        : Promise.resolve([] as TocOutput[]),
      outcomeTocIds.size
        ? this.tocOutcomeRepository
            .createQueryBuilder('outcome')
            .leftJoinAndSelect('outcome.aow', 'aow')
            .where('outcome.id IN (:...ids)', { ids: [...outcomeTocIds] })
            .getMany()
        : Promise.resolve([] as TocOutcome[]),
    ]);

    const aowById = new Map(aowRows.map((r) => [r.id, r]));
    const outputById = new Map(outputRows.map((r) => [r.id, r]));
    const outcomeById = new Map(outcomeRows.map((r) => [r.id, r]));

    // Seed empty payloads so callers see consistent shape.
    for (const id of mappingIds) {
      result.set(id, { aows: [], outputs: [], outcomes: [] });
    }

    for (const l of links) {
      const mappingId = Number(l.projectMappingId);
      const tocId = Number(l.tocId);
      const bucket = result.get(mappingId);
      if (!bucket) continue;
      if (l.linkType === MappingTocLinkType.AOW) {
        const row = aowById.get(tocId);
        if (row) bucket.aows.push(row);
      } else if (l.linkType === MappingTocLinkType.OUTPUT) {
        const row = outputById.get(tocId);
        if (row) bucket.outputs.push(row);
      } else if (l.linkType === MappingTocLinkType.OUTCOME) {
        const row = outcomeById.get(tocId);
        if (row) bucket.outcomes.push(row);
      }
    }

    return result;
  }

  /**
   * Service-layer validator for `PATCH /:id/toc-links` body.
   *
   * For each provided id list, runs a single `IN (:ids)` query against
   * the relevant TOC table, narrowed by `programId` (and
   * `outcomeType='intermediate'` for outcomes). Any id that doesn't
   * come back is an offender — wrong program, doesn't exist, or
   * (for outcomes) is a portfolio EOI.
   *
   * Collects offenders across all three lists and throws a single
   * BadRequestException with the full list so the caller can fix
   * everything in one round-trip rather than playing whack-a-mole.
   */
  private async assertTocIdsBelongToProgram(
    programId: number,
    aowIds: number[],
    outputIds: number[],
    outcomeIds: number[],
  ): Promise<void> {
    const offenders: { type: MappingTocLinkType; id: number }[] = [];

    if (aowIds.length > 0) {
      const found = await this.tocAowRepository
        .createQueryBuilder('aow')
        .select('aow.id', 'id')
        .where('aow.id IN (:...ids)', { ids: aowIds })
        .andWhere('aow.programId = :programId', { programId })
        .getRawMany<{ id: number }>();
      const foundSet = new Set(found.map((r) => Number(r.id)));
      for (const id of aowIds) {
        if (!foundSet.has(id))
          offenders.push({ type: MappingTocLinkType.AOW, id });
      }
    }

    if (outputIds.length > 0) {
      const found = await this.tocOutputRepository
        .createQueryBuilder('output')
        .select('output.id', 'id')
        .where('output.id IN (:...ids)', { ids: outputIds })
        .andWhere('output.programId = :programId', { programId })
        .getRawMany<{ id: number }>();
      const foundSet = new Set(found.map((r) => Number(r.id)));
      for (const id of outputIds) {
        if (!foundSet.has(id))
          offenders.push({ type: MappingTocLinkType.OUTPUT, id });
      }
    }

    if (outcomeIds.length > 0) {
      /* Accept both intermediate and portfolio (2030 EOI) outcomes —
       * the program-rep picker now surfaces both as a single pool, so
       * the write-side allow-list must match. Per-program scope is
       * still enforced. */
      const found = await this.tocOutcomeRepository
        .createQueryBuilder('outcome')
        .select('outcome.id', 'id')
        .where('outcome.id IN (:...ids)', { ids: outcomeIds })
        .andWhere('outcome.programId = :programId', { programId })
        .getRawMany<{ id: number }>();
      const foundSet = new Set(found.map((r) => Number(r.id)));
      for (const id of outcomeIds) {
        if (!foundSet.has(id))
          offenders.push({ type: MappingTocLinkType.OUTCOME, id });
      }
    }

    if (offenders.length > 0) {
      const detail = offenders.map((o) => `${o.type}:${o.id}`).join(', ');
      throw new BadRequestException(
        `Invalid TOC ids for this program (wrong program / unknown): ${detail}`,
      );
    }
  }

  /**
   * Service-layer gate enforced by {@link agree} when the program rep
   * accepts.
   *
   * Counts rows in `mapping_toc_links` grouped by `link_type` and
   * requires:
   *   - ≥ 1 row with link_type='aow'
   *   - AND (≥ 1 with link_type='output' OR ≥ 1 with link_type='outcome')
   *
   * Throws `BadRequestException` with `TOC_LINKS_REQUIRED` so the
   * frontend can swap the generic toast for a contextual one.
   *
   * Legacy mappings (no link rows) hit the throw on their NEXT
   * agree() call — they are not auto-backfilled, but the moment a
   * program rep tries to re-confirm one, they must attach links.
   * This matches the spec ("existing agreed mappings stay agreed; only
   * enforce on new agree() calls").
   */
  private async assertTocLinksSatisfyAgreeGate(
    mappingId: number,
  ): Promise<void> {
    const counts = await this.tocLinkRepository
      .createQueryBuilder('link')
      .select('link.link_type', 'linkType')
      .addSelect('COUNT(*)', 'count')
      .where('link.projectMappingId = :id', { id: String(mappingId) })
      .groupBy('link.link_type')
      .getRawMany<{ linkType: MappingTocLinkType; count: string | number }>();

    let aow = 0;
    let output = 0;
    let outcome = 0;
    for (const row of counts) {
      const n = Number(row.count) || 0;
      if (row.linkType === MappingTocLinkType.AOW) aow = n;
      else if (row.linkType === MappingTocLinkType.OUTPUT) output = n;
      else if (row.linkType === MappingTocLinkType.OUTCOME) outcome = n;
    }

    if (aow === 0 || (output === 0 && outcome === 0)) {
      // statusCode preserves the full object in the response envelope
      // (NestJS otherwise unwraps `{code, message}` and drops `code`).
      throw new BadRequestException({
        statusCode: 400,
        code: 'TOC_LINKS_REQUIRED',
        message:
          'Select at least one AOW and at least one Output or Intermediate Outcome before agreeing.',
      });
    }
  }
}
