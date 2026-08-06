import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { PublishedSnapshot } from './entities/published-snapshot.entity';
import { PublishedProject } from './entities/published-project.entity';
import {
  PublishedMappingData,
  PublishedTocContribution,
  PublishedTocNode,
} from './entities/published-mapping.interface';
import {
  PublishedCountryData,
  PublishedProjectDetails,
} from './entities/published-details.interface';
import { Project } from '../projects/entities/project.entity';
import { ProjectMapping } from '../mappings/entities/project-mapping.entity';
import { ProjectStatus } from '../projects/enums/project-status.enum';
import { MappingStatus } from '../mappings/enums/mapping-status.enum';
import {
  MappingsService,
  MappingTocLinksPayload,
} from '../mappings/mappings.service';
import { TocAow } from '../reference-data/entities/toc-aow.entity';
import { TocOutcome } from '../reference-data/entities/toc-outcome.entity';
import { TocOutput } from '../reference-data/entities/toc-output.entity';
import { CreateSnapshotDto } from './dto/create-snapshot.dto';
import { PublishedProjectQueryDto } from './dto/published-project-query.dto';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { SnapshotCreatorRole } from './entities/published-snapshot.entity';
import { AuditService } from '../audit/audit.service';
import { AuditEntityType } from '../audit/entities/audit-event.entity';

/**
 * Identity of the snapshot a set of published rows was frozen from.
 *
 * Returned alongside every published-projects page so an unauthenticated
 * consumer can tell which version it is reading — and detect that a newer
 * snapshot was published mid-pagination (the `id` changes).
 */
export interface PublishedSnapshotRef {
  id: number;
  versionLabel: string;
  description: string | null;
  publishedAt: Date;
  projectCount: number;
  totalBudget: number;
}

/**
 * One row of `GET /published/snapshots` — the snapshot reference plus the
 * two fields that only make sense in a list of versions: who published it
 * (display name only, never the account) and whether it's the live one.
 */
export interface PublishedSnapshotListItem extends PublishedSnapshotRef {
  publishedBy: { firstName: string; lastName: string } | null;
  isActive: boolean;
}

/**
 * Payload of `GET /published/latest` — the list item plus the aggregate
 * rollups the public home page renders. Mapped rather than returned as an
 * entity for the same reason as the list: the `publishedBy` relation would
 * otherwise serialise the whole User row (email, role, center/program ids)
 * to anonymous callers.
 */
export interface PublishedSnapshotSummary extends PublishedSnapshotListItem {
  summaryStats: PublishedSnapshot['summaryStats'];
}

/** Response envelope for `GET /published/latest/projects`. */
export interface PaginatedPublishedProjects {
  /** Null only when nothing has been published yet (`data` is then empty). */
  snapshot: PublishedSnapshotRef | null;
  data: PublishedProject[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Mapping statuses that represent a settled allocation and therefore belong
 * in a published snapshot. `ADMIN_DECISION` is agreed-equivalent — a
 * workflow admin imposed the allocation and locked the project on the same
 * action — so excluding it would publish an arbitrated project with an
 * empty program list. Mirrors `MappingsService.isAgreedLike()`.
 */
const PUBLISHABLE_MAPPING_STATUSES = [
  MappingStatus.AGREED,
  MappingStatus.ADMIN_DECISION,
];

@Injectable()
export class PublishedService {
  private readonly logger = new Logger(PublishedService.name);

  constructor(
    @InjectRepository(PublishedSnapshot)
    private readonly snapshotRepo: Repository<PublishedSnapshot>,
    @InjectRepository(PublishedProject)
    private readonly publishedProjectRepo: Repository<PublishedProject>,
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(ProjectMapping)
    private readonly mappingRepo: Repository<ProjectMapping>,
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
    private readonly mappingsService: MappingsService,
  ) {}

  /**
   * Creates a new published snapshot from every active project whose
   * negotiation round is locked, together with its settled mappings.
   * Deactivates any previous active snapshot.
   *
   * Only locked projects are published. A project mid-negotiation has no
   * agreed allocation to report — publishing it would put a provisional (or
   * empty) program split in front of the public, and `projectCount` /
   * `totalBudget` / `summaryStats` would count work that has not been
   * settled. `negotiation_locked` is the single source of truth for "this
   * round is final", so it is the single gate here.
   */
  async createSnapshot(
    actor: User,
    dto: CreateSnapshotDto,
  ): Promise<PublishedSnapshot> {
    /* Map the actor's UserRole to the snapshot's narrower creator-role enum.
     * Only admin and unit_admin can publish snapshots — the controller's
     * @Roles guard enforces this — so any other value is a programmer error. */
    const createdByRole: SnapshotCreatorRole =
      actor.role === UserRole.UNIT_ADMIN ? UserRole.UNIT_ADMIN : UserRole.ADMIN;

    const snapshot = await this.dataSource.transaction(async (manager) => {
      /* Deactivate all currently active snapshots */
      await manager
        .createQueryBuilder()
        .update(PublishedSnapshot)
        .set({ isActive: false })
        .where('is_active = 1')
        .execute();

      /* Load every locked active project with center + both country
       * allocation lists (Location of Benefit and Country of
       * Implementation are independent lists with their own Global flag). */
      const projects = await this.projectRepo
        .createQueryBuilder('project')
        .leftJoinAndSelect('project.center', 'center')
        .leftJoinAndSelect('project.benefitCountries', 'benefitCountries')
        .leftJoinAndSelect('benefitCountries.country', 'benefitCountry')
        .leftJoinAndSelect(
          'project.implementationCountries',
          'implementationCountries',
        )
        .leftJoinAndSelect('implementationCountries.country', 'implCountry')
        .where('project.status = :status', { status: ProjectStatus.ACTIVE })
        .andWhere('project.negotiationLocked = :locked', { locked: true })
        .getMany();

      /* Load the settled mappings for those projects. No lock predicate
       * needed here — `projects` is already lock-filtered. */
      const projectIds = projects.map((p) => p.id);
      let mappings: ProjectMapping[] = [];
      if (projectIds.length > 0) {
        mappings = await this.mappingRepo
          .createQueryBuilder('mapping')
          .leftJoinAndSelect('mapping.program', 'program')
          .where('mapping.projectId IN (:...projectIds)', { projectIds })
          .andWhere('mapping.status IN (:...statuses)', {
            statuses: PUBLISHABLE_MAPPING_STATUSES,
          })
          .getMany();
      }

      /* Hydrate TOC contributions for every published mapping in one
       * batch (4 queries total, not 3 per mapping). This is the data the
       * program-side agree gate exists to guarantee, so a snapshot
       * without it under-reports what each program committed to. */
      const tocByMapping =
        await this.mappingsService.hydrateTocLinksForMappings(
          mappings.map((m) => m.id),
        );

      /* Group mappings by project ID */
      const mappingsByProject = new Map<number, ProjectMapping[]>();
      for (const m of mappings) {
        const list = mappingsByProject.get(m.projectId) || [];
        list.push(m);
        mappingsByProject.set(m.projectId, list);
      }

      /* Compute summary stats. Budget rolls up alongside the counts:
       * per program it is the *allocated* share (budget × %), which is
       * the only budget figure that is meaningful per program — raw
       * project budgets would be double-counted across its programs. */
      const centerCounts = new Map<
        string,
        { name: string; count: number; budget: number }
      >();
      const programCounts = new Map<
        string,
        { name: string; count: number; allocatedBudget: number }
      >();
      let totalBudget = 0;

      for (const project of projects) {
        const projectBudget = Number(project.totalBudget) || 0;
        totalBudget += projectBudget;

        const acronym = project.center?.acronym || 'Unknown';
        const centerEntry = centerCounts.get(acronym) || {
          name: project.center?.name || 'Unknown',
          count: 0,
          budget: 0,
        };
        centerEntry.count++;
        centerEntry.budget += projectBudget;
        centerCounts.set(acronym, centerEntry);

        const projectMappings = mappingsByProject.get(project.id) || [];
        for (const mapping of projectMappings) {
          const code = mapping.program?.officialCode || 'Unknown';
          const programEntry = programCounts.get(code) || {
            name: mapping.program?.name || 'Unknown',
            count: 0,
            allocatedBudget: 0,
          };
          programEntry.count++;
          programEntry.allocatedBudget += this.allocatedBudget(
            projectBudget,
            mapping.allocationPercentage,
          );
          programCounts.set(code, programEntry);
        }
      }

      const summaryStats = {
        projectsByCenter: Array.from(centerCounts.entries()).map(
          ([acronym, { name, count, budget }]) => ({
            acronym,
            name,
            count,
            budget: this.round2(budget),
          }),
        ),
        projectsByProgram: Array.from(programCounts.entries()).map(
          ([code, { name, count, allocatedBudget }]) => ({
            code,
            name,
            count,
            allocatedBudget: this.round2(allocatedBudget),
          }),
        ),
      };

      /* Create snapshot entity */
      const snapshot = manager.create(PublishedSnapshot, {
        versionLabel: dto.versionLabel,
        description: dto.description || null,
        publishedAt: new Date(),
        publishedById: actor.id,
        createdByRole,
        projectCount: projects.length,
        totalBudget,
        summaryStats,
        isActive: true,
      });

      const savedSnapshot = await manager.save(PublishedSnapshot, snapshot);

      /* Create published project rows */
      const publishedProjects = projects.map((project) => {
        const projectBudget = Number(project.totalBudget) || 0;
        const projectMappings = mappingsByProject.get(project.id) || [];
        const mappingsData: PublishedMappingData[] = projectMappings.map(
          (m) => ({
            programId: m.programId,
            programName: m.program?.name || '',
            programCode: m.program?.officialCode || '',
            allocationPercentage: Number(m.allocationPercentage),
            allocatedBudget: this.round2(
              this.allocatedBudget(projectBudget, m.allocationPercentage),
            ),
            status: m.status,
            complementarityRating: m.complementarityRating,
            efficiencyRating: m.efficiencyRating,
            toc: this.toPublishedToc(tocByMapping.get(m.id)),
          }),
        );

        const details: PublishedProjectDetails = {
          summary: project.summary ?? null,
          category: project.category ?? null,
          natureOfFunder: project.natureOfFunder ?? null,
          isBenefitGlobal: !!project.isBenefitGlobal,
          isImplementationGlobal: !!project.isImplementationGlobal,
          implementationCountries: this.toPublishedCountries(
            project.implementationCountries,
          ),
        };

        return manager.create(PublishedProject, {
          snapshotId: savedSnapshot.id,
          sourceProjectId: project.id,
          code: project.code,
          name: project.name,
          description: project.description,
          centerName: project.center?.name || '',
          centerAcronym: project.center?.acronym || '',
          countries: this.toPublishedCountries(project.benefitCountries),
          totalBudget: projectBudget,
          fundingSource: project.fundingSource,
          funder: project.funder,
          status: project.status,
          startDate: project.startDate,
          endDate: project.endDate,
          mappings: mappingsData,
          details,
        });
      });

      if (publishedProjects.length > 0) {
        await manager.save(PublishedProject, publishedProjects);
      }

      this.logger.log(
        `Snapshot "${dto.versionLabel}" created with ${projects.length} locked projects and ${mappings.length} settled mappings`,
      );

      // Reload with the publishedBy relation so the API response matches the
      // shape the frontend list expects ({ publishedBy: { firstName, lastName } }).
      return manager.findOneOrFail(PublishedSnapshot, {
        where: { id: savedSnapshot.id },
        relations: ['publishedBy'],
      });
    });

    /* Audit the publish action. record() is post-commit and best-effort
     * — failures are swallowed so a flaky audit table cannot block a
     * published portfolio from going live. */
    await this.auditService.record({
      entityType: AuditEntityType.PUBLISHED_SNAPSHOT,
      entityId: snapshot.id,
      action: 'snapshot.create',
      summary: `Published ${snapshot.projectCount} projects (${snapshot.versionLabel})`,
    });

    return snapshot;
  }

  // ── Payload helpers ──────────────────────────────────────────────

  /** Rounds to cents. Snapshot figures are money, never raw floats. */
  private round2(value: number): number {
    return Math.round(value * 100) / 100;
  }

  /** A program's share of a project's budget, in currency units. */
  private allocatedBudget(
    projectBudget: number,
    allocationPercentage: number,
  ): number {
    return (projectBudget * (Number(allocationPercentage) || 0)) / 100;
  }

  /**
   * Flattens a project's country allocation rows into the published JSON
   * shape. Rows whose `country` relation failed to resolve are dropped
   * rather than published as a nameless entry.
   */
  private toPublishedCountries(
    rows:
      | Array<{
          allocationPercentage: number;
          country?: { name: string; isoAlpha2: string } | null;
        }>
      | null
      | undefined,
  ): PublishedCountryData[] {
    return (rows || [])
      .filter((row) => !!row.country)
      .map((row) => ({
        name: row.country!.name,
        isoAlpha2: row.country!.isoAlpha2,
        allocationPercentage: Number(row.allocationPercentage),
      }));
  }

  /**
   * Denormalises hydrated TOC entity rows into the compact published
   * shape. Only the fields a public consumer can render are copied —
   * program ids, sync timestamps and graph cross-links stay internal.
   */
  private toPublishedToc(
    payload: MappingTocLinksPayload | undefined,
  ): PublishedTocContribution {
    const aow = (row: TocAow): PublishedTocNode => ({
      id: row.id,
      nodeId: row.nodeId,
      title: row.name ?? row.acronym ?? '',
      code: row.wpOfficialCode ?? row.acronym ?? null,
      type: null,
    });
    const output = (row: TocOutput): PublishedTocNode => ({
      id: row.id,
      nodeId: row.nodeId,
      title: row.title ?? '',
      code: null,
      type: row.typeOfOutput ?? null,
    });
    const outcome = (row: TocOutcome): PublishedTocNode => ({
      id: row.id,
      nodeId: row.nodeId,
      title: row.title ?? '',
      code: null,
      type: null,
    });

    return {
      aows: (payload?.aows || []).map(aow),
      outputs: (payload?.outputs || []).map(output),
      outcomes: (payload?.outcomes || []).map(outcome),
    };
  }

  /**
   * Returns the latest active snapshot entity (metadata only, no projects).
   *
   * Internal use — it carries the full `publishedBy` User relation, so it
   * must never be returned straight to a caller. `toSnapshotSummary()` is
   * the public-facing projection.
   */
  async getLatestSnapshot(): Promise<PublishedSnapshot | null> {
    return this.snapshotRepo.findOne({
      where: { isActive: true as unknown as boolean },
      order: { publishedAt: 'DESC' },
      relations: ['publishedBy'],
    });
  }

  /**
   * Public projection of the active snapshot for `GET /published/latest`.
   *
   * The entity's `publishedBy` is a full User row — email, role, center and
   * program ids — and the route is unauthenticated, so the publisher is
   * reduced to a display name here exactly as in `listSnapshots()`.
   */
  toSnapshotSummary(snapshot: PublishedSnapshot): PublishedSnapshotSummary {
    return {
      ...this.toSnapshotRef(snapshot),
      publishedBy: snapshot.publishedBy
        ? {
            firstName: snapshot.publishedBy.firstName,
            lastName: snapshot.publishedBy.lastName,
          }
        : null,
      isActive: snapshot.isActive,
      summaryStats: snapshot.summaryStats,
    };
  }

  /**
   * Condenses a snapshot into the reference that rides along with every
   * published-projects page, so a consumer can tell which frozen artifact
   * the rows came from without a second call.
   *
   * Deliberately narrower than the `/published/latest` payload: no
   * `publishedBy` (this identifies a version, not a person) and no
   * `summaryStats` (kilobytes of aggregates repeated on every page).
   */
  private toSnapshotRef(snapshot: PublishedSnapshot): PublishedSnapshotRef {
    return {
      id: snapshot.id,
      versionLabel: snapshot.versionLabel,
      description: snapshot.description ?? null,
      publishedAt: snapshot.publishedAt,
      projectCount: snapshot.projectCount,
      totalBudget: snapshot.totalBudget,
    };
  }

  /** Paginated published projects for a given snapshot. */
  async getPublishedProjects(
    snapshot: PublishedSnapshot,
    query: PublishedProjectQueryDto,
  ): Promise<PaginatedPublishedProjects> {
    const qb = this.publishedProjectRepo
      .createQueryBuilder('pp')
      .where('pp.snapshotId = :snapshotId', { snapshotId: snapshot.id });

    if (query.search) {
      qb.andWhere(
        '(pp.code LIKE :search OR pp.name LIKE :search OR pp.centerName LIKE :search)',
        { search: `%${query.search}%` },
      );
    }

    if (query.center) {
      qb.andWhere('pp.centerAcronym = :center', { center: query.center });
    }

    const offset = (query.page - 1) * query.limit;
    qb.orderBy('pp.code', 'ASC').offset(offset).limit(query.limit);

    const [data, total] = await qb.getManyAndCount();

    return {
      snapshot: this.toSnapshotRef(snapshot),
      data,
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /** Returns a single published project by ID within a snapshot. */
  async getPublishedProjectById(
    snapshotId: number,
    projectId: number,
  ): Promise<PublishedProject | null> {
    return this.publishedProjectRepo.findOne({
      where: { id: projectId, snapshotId },
    });
  }

  /**
   * Lists all snapshots ordered by most recent first.
   *
   * The endpoint is unauthenticated, so rows are mapped rather than
   * returned as entities: `publishedBy` is a `User` relation whose columns
   * (email, role, center/program ids) would otherwise all be serialised to
   * the public. Only the publisher's display name survives — the same
   * detail the public home page already shows for the active snapshot.
   */
  async listSnapshots(): Promise<PublishedSnapshotListItem[]> {
    const snapshots = await this.snapshotRepo.find({
      order: { publishedAt: 'DESC' },
      relations: ['publishedBy'],
    });

    return snapshots.map((s) => ({
      ...this.toSnapshotRef(s),
      publishedBy: s.publishedBy
        ? {
            firstName: s.publishedBy.firstName,
            lastName: s.publishedBy.lastName,
          }
        : null,
      isActive: s.isActive,
    }));
  }
}
