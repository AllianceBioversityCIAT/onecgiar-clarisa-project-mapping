import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectExclusion } from '../entities/project-exclusion.entity';
import { ExcludeProjectDto } from '../dto/exclude-project.dto';
import { Project } from '../entities/project.entity';
import { User } from '../../users/entities/user.entity';
import { UserRole } from '../../users/enums/user-role.enum';
import { AuditService } from '../../audit/audit.service';
import {
  AuditEntityType,
  AuditEventChanges,
} from '../../audit/entities/audit-event.entity';

/**
 * Service handling project exclusion lifecycle (exclude / unexclude).
 *
 * Exclusion is per-center: a center rep hides a project from their own
 * center's default view without affecting any other role or center.
 * Admins may exclude/unexclude under the project's owning center.
 *
 * Business rules enforced here:
 *  - Center reps may only exclude projects whose `center_id` matches
 *    their own `centerId`. (Admins may exclude any project.)
 *  - A 409 is raised if the (project, center) pair already has an
 *    exclusion row — idempotency is the caller's concern.
 *  - A 404 is raised on unexclude when no matching exclusion exists.
 *  - Audit events use `action = 'project.excluded'` / `'project.unexcluded'`
 *    and record before/after on a synthetic field keyed by centerId so the
 *    history tab can distinguish per-center exclusion events.
 */
@Injectable()
export class ProjectExclusionService {
  private readonly logger = new Logger(ProjectExclusionService.name);

  constructor(
    @InjectRepository(ProjectExclusion)
    private readonly exclusionRepo: Repository<ProjectExclusion>,
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    private readonly auditService: AuditService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────
  //  exclude()
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Marks a project as excluded for the acting user's center (center_rep)
   * or the project's owning center (admin).
   *
   * @param projectId  The project to exclude.
   * @param dto        Exclusion payload — reason only.
   * @param actor      The authenticated user performing the action.
   * @returns          The newly created ProjectExclusion row with relations.
   * @throws ForbiddenException   Center rep attempts to exclude a project
   *                              that does not belong to their center.
   * @throws NotFoundException    Project does not exist.
   * @throws ConflictException    The (project, center) pair is already excluded.
   */
  async exclude(
    projectId: number,
    dto: ExcludeProjectDto,
    actor: User,
  ): Promise<ProjectExclusion> {
    // Load the project — we need centerId to validate center-rep scope and
    // to record the correct centerId for admin actors.
    const project = await this.projectRepo.findOne({
      where: { id: projectId },
      select: ['id', 'centerId', 'code', 'name'],
    });
    if (!project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }

    // Center reps may only act on projects that belong to their own center.
    // This check uses the project's centerId (not the actor's resolved centerId)
    // to prevent a rep from excluding projects outside their center.
    if (
      actor.role === UserRole.CENTER_REP &&
      project.centerId !== actor.centerId
    ) {
      throw new ForbiddenException(
        'You may only exclude projects belonging to your own center',
      );
    }

    // Determine which center this exclusion belongs to.
    const centerId = this.resolveExclusionCenter(actor, project);

    // Check for an existing exclusion — the UNIQUE constraint would catch
    // duplicates at the DB level too, but we raise a cleaner 409 here.
    const existing = await this.exclusionRepo.findOneBy({
      projectId,
      centerId,
    });
    if (existing) {
      throw new ConflictException(
        `Project ${project.code} is already excluded for this center`,
      );
    }

    const now = new Date();
    const exclusion = this.exclusionRepo.create({
      projectId,
      centerId,
      excludedByUserId: actor.id,
      reason: dto.reason,
      excludedAt: now,
    });

    const saved = await this.exclusionRepo.save(exclusion);

    this.logger.log(
      `Project ${project.code} (id=${projectId}) excluded for center ${centerId} by user ${actor.id}`,
    );

    // Audit — field_name is keyed by centerId so the history tab can surface
    // which center performed the action when viewing a project.
    const changes: AuditEventChanges = {
      [`excluded_by_center_${centerId}`]: { before: null, after: dto.reason },
    };
    await this.auditService.record({
      entityType: AuditEntityType.PROJECT,
      entityId: projectId,
      action: 'project.excluded',
      summary: `Project excluded for center ${centerId}: ${dto.reason.slice(0, 100)}`,
      justification: dto.reason,
      changes,
    });

    // Return the saved row with the excludedBy relation hydrated for the
    // response body (caller needs firstName/lastName for the detail banner).
    return this.exclusionRepo.findOne({
      where: { id: saved.id },
      relations: ['excludedBy', 'center'],
    }) as Promise<ProjectExclusion>;
  }

  // ─────────────────────────────────────────────────────────────────────
  //  unexclude()
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Removes an existing exclusion for the acting user's center.
   *
   * @param projectId  The project to unexclude.
   * @param actor      The authenticated user performing the action.
   * @returns          `{ message }` confirmation object.
   * @throws ForbiddenException   Center rep attempts to act on a different center's project.
   * @throws NotFoundException    Project or exclusion row does not exist.
   */
  async unexclude(
    projectId: number,
    actor: User,
    centerIdOverride?: number,
  ): Promise<{ message: string }> {
    const project = await this.projectRepo.findOne({
      where: { id: projectId },
      select: ['id', 'centerId', 'code'],
    });
    if (!project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }

    // Center reps may only unexclude projects in their own center.
    if (
      actor.role === UserRole.CENTER_REP &&
      project.centerId !== actor.centerId
    ) {
      throw new ForbiddenException(
        'You may only unexclude projects belonging to your own center',
      );
    }

    /* Admins viewing the cross-center "Show excluded" filter may need to
     * unexclude under a center other than the project's owning center
     * (since exclusions are per-(project, center)). centerIdOverride lets the
     * client name the exact exclusion row. Center reps ignore the override
     * and always act under their own centerId. */
    const centerId =
      actor.role === UserRole.ADMIN && typeof centerIdOverride === 'number'
        ? centerIdOverride
        : this.resolveExclusionCenter(actor, project);

    const exclusion = await this.exclusionRepo.findOneBy({
      projectId,
      centerId,
    });
    if (!exclusion) {
      throw new NotFoundException(
        `No exclusion found for project ${project.code} under this center`,
      );
    }

    const previousReason = exclusion.reason;
    await this.exclusionRepo.remove(exclusion);

    this.logger.log(
      `Project ${project.code} (id=${projectId}) unexcluded for center ${centerId} by user ${actor.id}`,
    );

    // Audit
    const changes: AuditEventChanges = {
      [`excluded_by_center_${centerId}`]: {
        before: previousReason,
        after: null,
      },
    };
    await this.auditService.record({
      entityType: AuditEntityType.PROJECT,
      entityId: projectId,
      action: 'project.unexcluded',
      summary: `Project exclusion removed for center ${centerId}`,
      changes,
    });

    return { message: `Project ${project.code} has been unexcluded` };
  }

  // ─────────────────────────────────────────────────────────────────────
  //  findExclusion()
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Returns the exclusion record for a (project, center) pair, or null
   * if none exists. Used by the project detail endpoint to attach
   * exclusion info for the center-rep banner.
   *
   * @param projectId  The project to check.
   * @param centerId   The center whose exclusion state is queried.
   */
  async findExclusion(
    projectId: number,
    centerId: number,
  ): Promise<ProjectExclusion | null> {
    return this.exclusionRepo.findOne({
      where: { projectId, centerId },
      relations: ['excludedBy'],
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Private helpers
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Returns the centerId to use for the exclusion row.
   *
   * Center reps use their own centerId. Admins exclude under the project's
   * owning center so the exclusion shows up when any center rep of that
   * center views the project list.
   */
  private resolveExclusionCenter(
    actor: User,
    project: Pick<Project, 'centerId'>,
  ): number {
    if (actor.role === UserRole.ADMIN) {
      return project.centerId;
    }
    // CENTER_REP — centerId must be set (enforced by RolesGuard upstream).
    if (!actor.centerId) {
      throw new ForbiddenException(
        'Your account is not assigned to a center. Contact an administrator.',
      );
    }
    return actor.centerId;
  }
}
