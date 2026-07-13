import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import type { Response } from 'express';
import { PassThrough } from 'stream';
import ExcelJS from 'exceljs';

import { ProjectsService, ProjectListItem } from '../projects.service';
import { Project } from '../entities/project.entity';
import { ProjectBudget } from '../entities/project-budget.entity';
import { ProjectMapping } from '../../mappings/entities/project-mapping.entity';
import { MappingNegotiation } from '../../mappings/entities/mapping-negotiation.entity';
import { ProjectNegotiationMessage } from '../../mappings/entities/project-negotiation-message.entity';
import {
  MappingTocLink,
  MappingTocLinkType,
} from '../../mappings/entities/mapping-toc-link.entity';
import { TocAow } from '../../reference-data/entities/toc-aow.entity';
import { TocOutput } from '../../reference-data/entities/toc-output.entity';
import { TocOutcome } from '../../reference-data/entities/toc-outcome.entity';
import { User } from '../../users/entities/user.entity';
import { ProjectExportQueryDto } from '../dto/project-export-query.dto';
import { AuditService } from '../../audit/audit.service';
import {
  AuditEntityType,
  AuditEvent,
} from '../../audit/entities/audit-event.entity';
import { UserRole } from '../../users/enums/user-role.enum';
import { Rating } from '../../mappings/enums/rating.enum';
import { MappingStatus } from '../../mappings/enums/mapping-status.enum';
import { NegotiationEventType } from '../../mappings/enums/negotiation-event-type.enum';
import { MappingHistoryExportQueryDto } from '../dto/mapping-history-export-query.dto';
import { MappingStatusFilter } from '../enums/mapping-status-filter.enum';
import {
  applyHeaderStyle,
  buildTimestamp,
  FMT_CURRENCY,
  FMT_DATE,
  FMT_PERCENT,
  TAB_COLORS,
  mappingStatusFill,
  projectStatusFill,
} from './excel-styles.helper';

/**
 * Maximum audit rows we'll fetch for a single detail-export workbook.
 * The audit sheet is a tail-of-history view, not a paged feed — capping
 * keeps any one project's export from running away if a misbehaved
 * caller (or scripted edit loop) inflates the count beyond reason.
 */
const AUDIT_EXPORT_PAGE_SIZE = 200;
const AUDIT_EXPORT_MAX_PAGES = 50; // 200 × 50 = 10 000 rows max

/**
 * Default hard cap on exportable rows.
 * Overridden at runtime by the EXPORT_MAX_ROWS environment variable.
 */
const DEFAULT_MAX_ROWS = 5_000;

/**
 * Em dash used as the universal "no value" placeholder on the Summary sheet.
 * NOT a hyphen, NOT an en-dash — must be U+2014.
 */
const EM_DASH = '—';

/**
 * Maps a Rating enum value to its single-letter export label.
 * Returns an empty string for null/undefined so the Excel cell renders blank.
 */
function ratingToLetter(rating: Rating | null | undefined): string {
  switch (rating) {
    case Rating.HIGH:
      return 'H';
    case Rating.MEDIUM:
      return 'M';
    case Rating.LOW:
      return 'L';
    default:
      return '';
  }
}

/**
 * Mapping status implied by a negotiation event, used to reconstruct the
 * point-in-time status column on the mapping-history export. Events absent
 * from this map (flags, removal requests, rating/TOC updates) don't change
 * the mapping's status — the previous row's status carries forward.
 *
 * `locked` is not a MappingStatus (lock state lives on the project) but is
 * the clearest label for the LOCKED event row, so the value type is string.
 */
const STATUS_AFTER_EVENT: Partial<Record<NegotiationEventType, string>> = {
  [NegotiationEventType.INITIATED]: MappingStatus.DRAFT,
  [NegotiationEventType.NEGOTIATION_STARTED]: MappingStatus.NEGOTIATING,
  [NegotiationEventType.COUNTER_PROPOSED]: MappingStatus.NEGOTIATING,
  [NegotiationEventType.AGREED]: MappingStatus.AGREED,
  [NegotiationEventType.REOPENED]: MappingStatus.DRAFT,
  [NegotiationEventType.REMOVED]: MappingStatus.REMOVED,
  [NegotiationEventType.ADMIN_DECISION]: MappingStatus.ADMIN_DECISION,
  [NegotiationEventType.LOCKED]: 'locked',
};

/**
 * TOC (Theory of Change) contribution for a single mapping, pre-rendered
 * into the three semicolon-joined display strings the Projects sheet emits
 * (one column each for AOWs, Outputs, Intermediate Outcomes).
 */
interface MappingTocSummary {
  aows: string;
  outputs: string;
  outcomes: string;
}

/** Empty TOC summary reused for mappings with no links. */
const EMPTY_TOC_SUMMARY: MappingTocSummary = {
  aows: '',
  outputs: '',
  outcomes: '',
};

/**
 * Renders a Summary-sheet filter value. Strings/numbers pass through,
 * arrays are joined with ", ", booleans render as "Yes"/"No", empty/undefined
 * collapses to the em-dash placeholder.
 */
function renderFilterValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return EM_DASH;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    return value.length ? value.join(', ') : EM_DASH;
  }
  return String(value);
}

/**
 * ProjectsExportService — orchestrates all Excel export workbooks.
 *
 * Uses ExcelJS streaming writer (`WorkbookWriter`) to pipe the workbook
 * directly into the Express response, avoiding buffering the entire file
 * in memory before the first byte reaches the client.
 *
 * Two public entry points:
 *  - `streamListExport(query, user, res)` — filtered project list (4 sheets:
 *    Summary / Projects / Mappings / Budgets — see template spec)
 *  - `streamDetailExport(id, user, res)` — single-project deep dive
 */
@Injectable()
export class ProjectsExportService {
  private readonly logger = new Logger(ProjectsExportService.name);

  /** Resolved once at first use so repeated exports don't re-read the env. */
  private readonly maxRows: number;

  constructor(
    private readonly projectsService: ProjectsService,
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(ProjectMapping)
    private readonly mappingRepository: Repository<ProjectMapping>,
    @InjectRepository(MappingNegotiation)
    private readonly negotiationRepository: Repository<MappingNegotiation>,
    @InjectRepository(ProjectNegotiationMessage)
    private readonly chatRepository: Repository<ProjectNegotiationMessage>,
    @InjectRepository(ProjectBudget)
    private readonly budgetRepository: Repository<ProjectBudget>,
    @InjectRepository(MappingTocLink)
    private readonly tocLinkRepository: Repository<MappingTocLink>,
    @InjectRepository(TocAow)
    private readonly tocAowRepository: Repository<TocAow>,
    @InjectRepository(TocOutput)
    private readonly tocOutputRepository: Repository<TocOutput>,
    @InjectRepository(TocOutcome)
    private readonly tocOutcomeRepository: Repository<TocOutcome>,
    private readonly auditService: AuditService,
  ) {
    const envMax = parseInt(process.env.EXPORT_MAX_ROWS ?? '', 10);
    this.maxRows =
      Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_ROWS;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // List export
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Streams a filtered project list as a 2-sheet Excel workbook:
   *   Sheet 1 — Summary  (export metadata + applied filters)
   *   Sheet 2 — Projects (all columns including 3 program slots)
   *
   * Hard-capped at `maxRows` — returns 400 when the filter matches more.
   * Role scoping (center rep / program rep) is enforced by
   * `ProjectsService.findAll`; this service makes no role-specific calls.
   *
   * @param query - Export query (same filters as list, no pagination/sort).
   * @param user  - Authenticated user; drives role scoping and Summary sheet.
   * @param res   - Express response stream — headers are set before first commit.
   */
  async streamListExport(
    query: ProjectExportQueryDto,
    user: User,
    res: Response,
  ): Promise<void> {
    const startMs = Date.now();

    /* Fetch one extra row so we can detect the over-cap case cheaply. */
    const result = await this.projectsService.findAll(
      { ...query, page: 1, limit: this.maxRows + 1 },
      user,
    );

    if (result.total > this.maxRows) {
      throw new BadRequestException(
        `Export limit exceeded: the current filters match ${result.total} projects. ` +
          `Please narrow your filters (max ${this.maxRows}).`,
      );
    }

    const projects = result.data;
    const projectIds = projects.map((p) => p.id);

    /* Load mappings + countries in parallel. Mappings include the program
     * relation so the Projects sheet can render the 3 program slot columns
     * without re-querying. Countries are loaded separately because
     * ProjectsService.findAll intentionally omits the countries join for
     * list performance. */
    const [mappings, projectsWithCountries] = await Promise.all([
      projectIds.length
        ? this.mappingRepository.find({
            where: { projectId: In(projectIds) },
            relations: ['program'],
            order: { id: 'ASC' },
          })
        : Promise.resolve([]),
      projectIds.length
        ? this.projectRepository.find({
            where: { id: In(projectIds) },
            relations: [
              'benefitCountries',
              'benefitCountries.country',
              'implementationCountries',
              'implementationCountries.country',
            ],
            /* Must include the Global flags — they drive the "Global" cell
             * value below. Without them they hydrate as undefined and a
             * global project (which has no country rows) renders empty. */
            select: {
              id: true,
              isBenefitGlobal: true,
              isImplementationGlobal: true,
            },
          })
        : Promise.resolve([]),
    ]);

    /* Build id → "Country (XX%)" map for each country column. Rows
     * where the matching Global flag is true render as "Global" so the
     * export reflects the same intent shown in the form. */
    const countriesByProject = new Map<number, string>();
    const implementationCountriesByProject = new Map<number, string>();
    const formatAllocations = (
      rows: Array<{ country: { name: string }; allocationPercentage: number }>,
    ): string =>
      rows
        .map((r) => `${r.country.name} (${Number(r.allocationPercentage)}%)`)
        .join(', ');
    for (const p of projectsWithCountries) {
      countriesByProject.set(
        p.id,
        p.isBenefitGlobal
          ? 'Global'
          : formatAllocations(p.benefitCountries ?? []),
      );
      implementationCountriesByProject.set(
        p.id,
        p.isImplementationGlobal
          ? 'Global'
          : formatAllocations(p.implementationCountries ?? []),
      );
    }

    /* Group active (non-removed) mappings per project, preserving id ASC
     * order. This is the slot ordering used by the Projects sheet columns
     * R–AC (Program 1/2/3 + their %/ratings). */
    const activeMappingsByProject = new Map<number, ProjectMapping[]>();
    /* Projects with ≥1 flagged mapping — ANY status, removed included, so
     * the boolean matches NEEDS_ASSISTANCE_SQL (the needsAssistance filter)
     * and the list UI's flagged-mappings badge, neither of which filters
     * by mapping status. */
    const needsAssistanceProjects = new Set<number>();
    for (const m of mappings) {
      if (m.needsAssistance) needsAssistanceProjects.add(m.projectId);
      if (m.status === MappingStatus.REMOVED) continue;
      const slot = activeMappingsByProject.get(m.projectId) ?? [];
      slot.push(m);
      activeMappingsByProject.set(m.projectId, slot);
    }

    /* Latest non-null justification per active mapping. Used to render the
     * "Program N Justification" column on the Projects sheet — typically
     * the most recent counter-proposal or removal reason captured during
     * negotiation. */
    const activeMappingIds: number[] = [];
    for (const list of activeMappingsByProject.values()) {
      for (const m of list) activeMappingIds.push(m.id);
    }
    const latestJustificationByMapping = new Map<number, string>();
    if (activeMappingIds.length) {
      const events = await this.negotiationRepository.find({
        where: { mappingId: In(activeMappingIds) },
        order: { id: 'DESC' },
        select: ['id', 'mappingId', 'justification'],
      });
      for (const ev of events) {
        if (!ev.justification) continue;
        if (latestJustificationByMapping.has(ev.mappingId)) continue;
        latestJustificationByMapping.set(ev.mappingId, ev.justification);
      }
    }

    /* TOC contribution per active mapping — drives the "Program N AOWs /
     * Outputs / Outcomes" columns on the Projects sheet. */
    const tocByMapping = await this.hydrateTocByMapping(activeMappingIds);

    /* Set HTTP headers before streaming begins. */
    const filename = `prms-projects-${buildTimestamp()}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    /*
     * Use a PassThrough stream as an intermediary between ExcelJS and the
     * Express response. ExcelJS's archiver calls stream.end() when done,
     * which would prematurely close the response if we piped directly.
     * Piping the PassThrough into res lets us await the 'finish' event on
     * the response before resolving, guaranteeing all bytes are flushed.
     */
    const passThrough = new PassThrough();
    passThrough.pipe(res);

    /* Create streaming workbook writing into the PassThrough. */
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: passThrough,
      useStyles: true,
      useSharedStrings: true,
    });
    workbook.creator = 'PRMS Projects Registry';
    workbook.created = new Date();

    /*
     * Same hazard as streamDetailExport: from here on the response is
     * piping and headers cannot be changed. Wrap the writers so we
     * destroy the stream cleanly on failure instead of letting the
     * client hang.
     */
    try {
      /* ── Sheet 1: Summary ───────────────────────────────────────────── */
      await this.writeListSummarySheet(workbook, query, user, projects.length);

      /* ── Sheet 2: Projects ──────────────────────────────────────────── */
      await this.writeProjectsSheet(
        workbook,
        projects,
        activeMappingsByProject,
        countriesByProject,
        implementationCountriesByProject,
        latestJustificationByMapping,
        needsAssistanceProjects,
        tocByMapping,
      );

      /* Finalise the workbook (flushes archiver into the PassThrough). */
      await workbook.commit();

      /* Wait for the response to finish flushing all bytes to the client. */
      await new Promise<void>((resolve, reject) => {
        res.on('finish', resolve);
        res.on('error', reject);
        /* If the response already finished (edge case), resolve immediately. */
        if (res.writableEnded) resolve();
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(
        `Export list failed mid-stream: user=${user.email} rows=${projects.length} — ${message}`,
        stack,
      );

      if (!passThrough.destroyed) {
        passThrough.destroy(err instanceof Error ? err : new Error(message));
      }

      /* Headers already sent — see streamDetailExport for rationale. */
      return;
    }

    this.logger.log(
      `Export list: user=${user.email} rows=${projects.length} ms=${Date.now() - startMs}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Detail export
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Streams a single project as a multi-sheet Excel workbook.
   *
   * Sheets: Project | Budgets | Mappings | Negotiation Events | Chat | Audit
   *
   * @param id   - Project ID.
   * @param user - Authenticated user; used for the Winston log only.
   * @param res  - Express response stream.
   */
  async streamDetailExport(
    id: number,
    user: User,
    res: Response,
  ): Promise<void> {
    const startMs = Date.now();

    /* Load the project — throws 404 if not found. */
    const project = await this.projectsService.findOne(id);
    if (!project) {
      throw new NotFoundException(`Project with ID ${id} not found`);
    }

    /* Load all related data in parallel. The audit sheet pulls from the
     * unified `audit_events` table via AuditService.query() — scoped to
     * this project's entity rows. We use the admin role for visibility
     * scope since the export endpoint is restricted to roles that
     * already have full audit visibility (the controller's @Roles guard
     * is the first gate). */
    const [mappings, budgets, chatMessages, auditEvents] = await Promise.all([
      this.mappingRepository.find({
        where: { projectId: id },
        relations: ['program', 'initiatedBy'],
      }),
      this.budgetRepository.find({
        where: { projectId: id },
      }),
      this.chatRepository.find({
        where: { projectId: id },
        relations: ['actor'],
        order: { createdAt: 'ASC' },
      }),
      this.loadProjectAuditEvents(id, user),
    ]);

    /* Load negotiation events for all mappings of this project. */
    const mappingIds = mappings.map((m) => m.id);
    const negotiationEvents = mappingIds.length
      ? await this.negotiationRepository.find({
          where: { mappingId: In(mappingIds) },
          relations: ['actor', 'mapping', 'mapping.program'],
          order: { createdAt: 'ASC' },
        })
      : [];

    /* Set HTTP headers BEFORE the stream is created. Once
     * `passThrough.pipe(res)` runs, ExcelJS starts writing the workbook
     * header bytes synchronously and the status/headers are locked. */
    const filename = `prms-project-${project.code}-${buildTimestamp()}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    /* PassThrough intermediary — see streamListExport for rationale. */
    const passThrough = new PassThrough();
    passThrough.pipe(res);

    /* Create streaming workbook writing into the PassThrough. */
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: passThrough,
      useStyles: true,
      useSharedStrings: true,
    });
    workbook.creator = 'PRMS Projects Registry';
    workbook.created = new Date();

    /*
     * From this point on we are past the point of no return: response
     * headers are flushed, so any thrown exception cannot be turned into
     * a clean JSON 500 by the global exception filter. If we let the
     * exception bubble, the response just closes silently and the
     * frontend HttpClient (responseType: 'blob') hangs forever waiting
     * for bytes that will never arrive.
     *
     * Wrap the whole sheet-writing + finalise block: on any error,
     * forcibly destroy the PassThrough with the underlying error so the
     * Express response socket is torn down, the client's blob request
     * resolves with an HttpErrorResponse, and the user sees the export
     * failing rather than hanging indefinitely.
     */
    try {
      /* ── Sheet 1: Project ───────────────────────────────────────────── */
      /* A locked round resolved via a workflow-admin Final Decision has at
       * least one non-removed mapping in `admin_decision` status; otherwise
       * the lock came from mutual agreement. Derived from the already-loaded
       * mappings so the detail sheet can spell out the resolution path. */
      const resolvedByAdminDecision = mappings.some(
        (m) => m.status === MappingStatus.ADMIN_DECISION,
      );
      await this.writeDetailProjectSheet(
        workbook,
        project,
        resolvedByAdminDecision,
      );

      /* ── Sheet 2: Budgets ───────────────────────────────────────────── */
      await this.writeDetailBudgetsSheet(workbook, budgets);

      /* ── Sheet 3: Mappings ──────────────────────────────────────────── */
      await this.writeDetailMappingsSheet(workbook, mappings);

      /* ── Sheet 4: Negotiation Events ────────────────────────────────── */
      await this.writeNegotiationEventsSheet(workbook, negotiationEvents);

      /* ── Sheet 5: Chat ──────────────────────────────────────────────── */
      await this.writeChatSheet(workbook, chatMessages);

      /* ── Sheet 6: Audit ─────────────────────────────────────────────── */
      await this.writeAuditSheet(workbook, auditEvents);

      await workbook.commit();

      /* Wait for the response to finish flushing all bytes to the client. */
      await new Promise<void>((resolve, reject) => {
        res.on('finish', resolve);
        res.on('error', reject);
        if (res.writableEnded) resolve();
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(
        `Export detail failed mid-stream: user=${user.email} projectId=${id} code=${project.code} — ${message}`,
        stack,
      );

      /* Forcibly destroy the PassThrough with the underlying error.
       * This propagates to the piped Express response, terminating the
       * socket so the client's blob HttpClient observes an error event
       * (instead of hanging until its own read timeout fires). */
      if (!passThrough.destroyed) {
        passThrough.destroy(err instanceof Error ? err : new Error(message));
      }

      /* Headers are already sent — re-throwing would only trigger the
       * "Cannot set headers after they are sent" warning from the global
       * exception filter without affecting the wire response. Return
       * silently; the failure is logged with full context above. */
      return;
    }

    this.logger.log(
      `Export detail: user=${user.email} projectId=${id} code=${project.code} ms=${Date.now() - startMs}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mapping-history export
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Streams the full mapping negotiation history as a 2-sheet workbook:
   *   Sheet 1 — Summary          (export metadata + center filter)
   *   Sheet 2 — Mapping History  (one row per negotiation event)
   *
   * Every mapping (removed included) contributes its complete event thread.
   * Each row reconstructs the allocation % and mapping status as of that
   * event; the final row of every mapping is stamped `Active Now = Yes` and
   * carries the mapping's live status/allocation, so a consumer can filter
   * on that column to see only current-state rows.
   *
   * Not row-capped like the list export — this is the admin's archival dump
   * and truncating history would defeat its purpose. It streams row-by-row,
   * so memory pressure stays bounded by the raw event fetch.
   *
   * @param query - Optional center filter.
   * @param user  - Authenticated admin; used for the Summary sheet + log.
   * @param res   - Express response stream.
   */
  async streamMappingHistoryExport(
    query: MappingHistoryExportQueryDto,
    user: User,
    res: Response,
  ): Promise<void> {
    const startMs = Date.now();

    /* All mappings (any status) in project/mapping order — the sheet's row
     * grouping. The nested where pushes the center filter into the join. */
    const mappings = await this.mappingRepository.find({
      where: query.centerId
        ? { project: { centerId: query.centerId } }
        : undefined,
      relations: ['program', 'project', 'project.center'],
      order: { projectId: 'ASC', id: 'ASC' },
    });

    /* Full event threads for those mappings, oldest first per mapping. */
    const mappingIds = mappings.map((m) => m.id);
    const events = mappingIds.length
      ? await this.negotiationRepository.find({
          where: { mappingId: In(mappingIds) },
          relations: ['actor'],
          order: { mappingId: 'ASC', id: 'ASC' },
        })
      : [];
    const eventsByMapping = new Map<number, MappingNegotiation[]>();
    for (const ev of events) {
      const thread = eventsByMapping.get(ev.mappingId) ?? [];
      thread.push(ev);
      eventsByMapping.set(ev.mappingId, thread);
    }

    /* Set HTTP headers before streaming begins. */
    const filename = `prms-mapping-history-${buildTimestamp()}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    /* PassThrough intermediary — see streamListExport for rationale. */
    const passThrough = new PassThrough();
    passThrough.pipe(res);

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: passThrough,
      useStyles: true,
      useSharedStrings: true,
    });
    workbook.creator = 'PRMS Projects Registry';
    workbook.created = new Date();

    /* Past this point headers are flushed — same mid-stream failure
     * handling as the other exports. */
    try {
      await this.writeMappingHistorySummarySheet(
        workbook,
        query,
        user,
        mappings,
        events.length,
      );
      await this.writeMappingHistorySheet(workbook, mappings, eventsByMapping);

      await workbook.commit();

      await new Promise<void>((resolve, reject) => {
        res.on('finish', resolve);
        res.on('error', reject);
        if (res.writableEnded) resolve();
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(
        `Export mapping-history failed mid-stream: user=${user.email} centerId=${query.centerId ?? 'all'} — ${message}`,
        stack,
      );
      if (!passThrough.destroyed) {
        passThrough.destroy(err instanceof Error ? err : new Error(message));
      }
      return;
    }

    this.logger.log(
      `Export mapping-history: user=${user.email} centerId=${query.centerId ?? 'all'} mappings=${mappings.length} events=${events.length} ms=${Date.now() - startMs}`,
    );
  }

  /**
   * Writes the Summary sheet for a mapping-history export.
   */
  private async writeMappingHistorySummarySheet(
    workbook: ExcelJS.stream.xlsx.WorkbookWriter,
    query: MappingHistoryExportQueryDto,
    user: User,
    mappings: ProjectMapping[],
    eventCount: number,
  ): Promise<void> {
    const sheet = workbook.addWorksheet('Summary', {
      properties: { tabColor: { argb: TAB_COLORS.navy } },
    });

    sheet.mergeCells('A1:E1');
    const bannerCell = sheet.getCell('A1');
    bannerCell.value = `PRMS Projects Registry ${EM_DASH} Mapping History Export`;
    bannerCell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 14 };
    bannerCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF0F212F' },
    };
    bannerCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(1).height = 32;
    sheet.getRow(1).commit();

    const subtitleRow = sheet.getRow(2);
    subtitleRow.getCell(1).value = `Generated: ${new Date().toISOString()}`;
    subtitleRow.getCell(1).font = { italic: true, color: { argb: 'FF555555' } };
    subtitleRow.commit();

    sheet.getRow(3).commit();

    const writeKV = (rowNum: number, label: string, value: string | number) => {
      const row = sheet.getRow(rowNum);
      const labelCell = row.getCell(1);
      labelCell.value = label;
      labelCell.font = { bold: true };
      row.getCell(2).value = value;
      row.commit();
    };

    /* Resolve a human-readable center label from the loaded mappings —
     * they all share the filtered center when the filter is active. */
    const centerLabel = query.centerId
      ? (mappings[0]?.project?.center?.acronym ??
        `Center #${query.centerId}`)
      : 'All centers';

    writeKV(4, 'Exported By', `${user.email} (${user.role ?? 'no role'})`);
    writeKV(5, 'Center', centerLabel);
    writeKV(6, 'Mappings', mappings.length);
    writeKV(7, 'History Rows', eventCount);

    sheet.getColumn(1).width = 24;
    sheet.getColumn(2).width = 50;

    await sheet.commit();
  }

  /**
   * Writes the Mapping History sheet — one row per negotiation event,
   * grouped by project then mapping, oldest event first.
   *
   * Allocation % is reconstructed by carrying the last proposed allocation
   * forward through events that don't carry one (agree, lock, chat-adjacent
   * events). Status is derived per event via STATUS_AFTER_EVENT with the
   * same carry-forward. The final row of each mapping is authoritative: it
   * shows the mapping's live status + allocation and `Active Now = Yes`.
   * Mappings with no recorded events (legacy imports) emit a single
   * current-state row.
   */
  private async writeMappingHistorySheet(
    workbook: ExcelJS.stream.xlsx.WorkbookWriter,
    mappings: ProjectMapping[],
    eventsByMapping: Map<number, MappingNegotiation[]>,
  ): Promise<void> {
    const sheet = workbook.addWorksheet('Mapping History', {
      views: [{ state: 'frozen', ySplit: 1 }],
      properties: { tabColor: { argb: TAB_COLORS.purple } },
    });

    sheet.columns = [
      { header: 'Project ID', key: 'projectId', width: 10 },
      { header: 'Project Code', key: 'projectCode', width: 16 },
      { header: 'Project Name', key: 'projectName', width: 40 },
      { header: 'Center', key: 'center', width: 14 },
      { header: 'Program Code', key: 'programCode', width: 16 },
      { header: 'Program Name', key: 'programName', width: 40 },
      { header: 'Allocation %', key: 'allocation', width: 14 },
      { header: 'Status', key: 'status', width: 16 },
      { header: 'Event', key: 'event', width: 22 },
      { header: 'Comment', key: 'comment', width: 50 },
      { header: 'Actor', key: 'actor', width: 30 },
      { header: 'Actor Role', key: 'actorRole', width: 16 },
      { header: 'Date', key: 'date', width: 20 },
      { header: 'Active Now', key: 'activeNow', width: 12 },
    ];

    applyHeaderStyle(sheet.getRow(1));
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: sheet.columns.length },
    };

    const allocCol = sheet.columns.findIndex((c) => c.key === 'allocation') + 1;
    const statusCol = sheet.columns.findIndex((c) => c.key === 'status') + 1;
    const dateCol = sheet.columns.findIndex((c) => c.key === 'date') + 1;

    /** Shared per-row styling: % format, date format, status fill. */
    const styleRow = (row: ExcelJS.Row, status: string): void => {
      row.getCell(allocCol).numFmt = FMT_PERCENT;
      row.getCell(dateCol).numFmt = FMT_DATE;
      row.getCell(statusCol).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: mappingStatusFill(status) },
      };
    };

    for (const mapping of mappings) {
      const base = {
        projectId: mapping.projectId,
        projectCode: mapping.project?.code ?? '',
        projectName: mapping.project?.name ?? '',
        center: mapping.project?.center?.acronym ?? '',
        programCode: mapping.program?.officialCode ?? '',
        programName: mapping.program?.name ?? '',
      };

      const thread = eventsByMapping.get(mapping.id) ?? [];
      const currentAllocation =
        mapping.allocationPercentage != null
          ? Number(mapping.allocationPercentage)
          : null;

      if (thread.length === 0) {
        /* Legacy mapping with no negotiation thread — one live-state row. */
        const row = sheet.addRow({
          ...base,
          allocation: currentAllocation,
          status: mapping.status,
          event: '',
          comment: '',
          actor: '',
          actorRole: '',
          date: mapping.updatedAt ? this.toExcelDate(mapping.updatedAt) : null,
          activeNow: 'Yes',
        });
        styleRow(row, mapping.status);
        row.commit();
        continue;
      }

      /* Carry-forward state while replaying the thread oldest → newest. */
      let runningAllocation: number | null = null;
      let runningStatus: string = MappingStatus.DRAFT;

      for (let i = 0; i < thread.length; i++) {
        const ev = thread[i];
        const isLast = i === thread.length - 1;

        if (ev.proposedAllocation != null) {
          runningAllocation = Number(ev.proposedAllocation);
        }
        runningStatus = STATUS_AFTER_EVENT[ev.eventType] ?? runningStatus;

        /* The newest event row represents the mapping as it stands today,
         * so pin it to the live entity state rather than the replay. */
        const allocation = isLast ? currentAllocation : runningAllocation;
        const status = isLast ? mapping.status : runningStatus;

        const row = sheet.addRow({
          ...base,
          allocation,
          status,
          event: ev.eventType,
          comment: ev.justification ?? '',
          actor: ev.actor?.email ?? '',
          actorRole: ev.actorRole,
          date: ev.createdAt ? this.toExcelDate(ev.createdAt) : null,
          activeNow: isLast ? 'Yes' : 'No',
        });
        styleRow(row, status);
        row.commit();
      }
    }

    await sheet.commit();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private sheet writers — List export
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Writes the Summary sheet for a list export.
   *
   * Layout (per template spec):
   *   A1     — "PRMS Projects Registry — Export" (merged A1:E1, bold, ~14pt)
   *   A2     — "Generated: <ISO>"
   *   blank
   *   A4/B4  — Exported By / user (role)
   *   A5/B5  — Row Count / number
   *   blank
   *   A7     — "— Filters Applied —" (bold, merged)
   *   A8..   — one label/value pair per DTO filter, em-dash for empty
   */
  private async writeListSummarySheet(
    workbook: ExcelJS.stream.xlsx.WorkbookWriter,
    query: ProjectExportQueryDto,
    user: User,
    rowCount: number,
  ): Promise<void> {
    const sheet = workbook.addWorksheet('Summary', {
      properties: { tabColor: { argb: TAB_COLORS.navy } },
    });

    /* Banner row — merged A1:E1, bold, ~14pt. */
    sheet.mergeCells('A1:E1');
    const bannerCell = sheet.getCell('A1');
    bannerCell.value = `PRMS Projects Registry ${EM_DASH} Export`;
    bannerCell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 14 };
    bannerCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: `FF0F212F` },
    };
    bannerCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(1).height = 32;
    sheet.getRow(1).commit();

    /* Subtitle row — A2 with the generation timestamp. */
    const subtitleRow = sheet.getRow(2);
    subtitleRow.getCell(1).value = `Generated: ${new Date().toISOString()}`;
    subtitleRow.getCell(1).font = { italic: true, color: { argb: 'FF555555' } };
    subtitleRow.commit();

    /* Blank row 3. */
    sheet.getRow(3).commit();

    /* Helper: write a label/value pair at an explicit row number. The Summary
     * sheet uses absolute rows (matching the template spec) rather than the
     * generic "next row" pattern so the layout is unambiguous. */
    const writeKV = (
      rowNum: number,
      label: string,
      value: string | number,
      opts?: { bold?: boolean; merge?: boolean },
    ): void => {
      const row = sheet.getRow(rowNum);
      if (opts?.merge) {
        sheet.mergeCells(`A${rowNum}:E${rowNum}`);
        const cell = row.getCell(1);
        cell.value = label;
        cell.font = { bold: true };
      } else {
        const labelCell = row.getCell(1);
        labelCell.value = label;
        labelCell.font = { bold: true };
        row.getCell(2).value = value;
      }
      row.commit();
    };

    /* Generation metadata (rows 4–5). */
    writeKV(4, 'Exported By', `${user.email} (${user.role ?? 'no role'})`);
    writeKV(5, 'Row Count', rowCount);

    /* Blank row 6. */
    sheet.getRow(6).commit();

    /* Filter section header (row 7, bold, merged across A:E). */
    writeKV(7, `${EM_DASH} Filters Applied ${EM_DASH}`, '', { merge: true });

    /* Filter rows 8–20, matching the template spec verbatim. */
    writeKV(8, 'Search', renderFilterValue(query.search));
    writeKV(9, 'Center ID', renderFilterValue(query.centerId));
    writeKV(10, 'Status', renderFilterValue(query.status));
    writeKV(11, 'Funding Source', renderFilterValue(query.fundingSource));
    writeKV(12, 'Program IDs', renderFilterValue(query.programIds));
    writeKV(13, 'Needs Assistance', renderFilterValue(query.needsAssistance));
    writeKV(14, 'In Negotiation', renderFilterValue(query.inNegotiation));
    writeKV(15, 'Mapped', renderFilterValue(query.mapped));
    writeKV(16, 'Budget Year', renderFilterValue(query.budgetYear));
    writeKV(17, 'Start Date From', renderFilterValue(query.startDateFrom));
    writeKV(18, 'Start Date To', renderFilterValue(query.startDateTo));
    writeKV(19, 'End Date From', renderFilterValue(query.endDateFrom));
    writeKV(20, 'End Date To', renderFilterValue(query.endDateTo));

    /* Fix column widths. */
    sheet.getColumn(1).width = 24;
    sheet.getColumn(2).width = 50;
    sheet.getColumn(3).width = 12;
    sheet.getColumn(4).width = 12;
    sheet.getColumn(5).width = 12;

    await sheet.commit();
  }

  /**
   * Writes the Projects sheet for a list export — 42 columns matching the
   * canonical PRMS export template.
   *
   * Program slots (R–AC) are filled from the per-project active mapping
   * list sorted by `project_mappings.id ASC` (the mappings repo query in
   * `streamListExport` enforces this order). Slot N is empty when fewer
   * than N non-removed mappings exist.
   *
   * The `% check` column (AD) is an arithmetic sum computed in code — NOT
   * an Excel formula — so consumers can rely on the numeric value without
   * Excel needing to recompute on open.
   */
  /**
   * Batch-loads TOC contribution data for the given mapping ids and returns
   * a `mappingId → { aows, outputs, outcomes }` map, each value a
   * semicolon-joined display string ready to drop into an Excel cell.
   *
   * Polymorphic junction (`mapping_toc_links.toc_id` points at one of three
   * `toc_*` tables per `link_type`), so we group the ids by type first, then
   * issue at most one query per TOC table — no per-mapping fan-out.
   */
  private async hydrateTocByMapping(
    mappingIds: number[],
  ): Promise<Map<number, MappingTocSummary>> {
    const result = new Map<number, MappingTocSummary>();
    if (!mappingIds.length) return result;

    const links = await this.tocLinkRepository.find({
      where: { projectMappingId: In(mappingIds.map(String)) },
      select: ['projectMappingId', 'linkType', 'tocId'],
    });
    if (!links.length) return result;

    /* Collect the distinct toc ids we need per table. */
    const aowIds = new Set<number>();
    const outputIds = new Set<number>();
    const outcomeIds = new Set<number>();
    for (const l of links) {
      const tocId = Number(l.tocId);
      if (l.linkType === MappingTocLinkType.AOW) aowIds.add(tocId);
      else if (l.linkType === MappingTocLinkType.OUTPUT) outputIds.add(tocId);
      else if (l.linkType === MappingTocLinkType.OUTCOME) outcomeIds.add(tocId);
    }

    /* One batch fetch per TOC table, then build id → label lookups. */
    const [aows, outputs, outcomes] = await Promise.all([
      aowIds.size
        ? this.tocAowRepository.find({ where: { id: In([...aowIds]) } })
        : Promise.resolve([]),
      outputIds.size
        ? this.tocOutputRepository.find({ where: { id: In([...outputIds]) } })
        : Promise.resolve([]),
      outcomeIds.size
        ? this.tocOutcomeRepository.find({ where: { id: In([...outcomeIds]) } })
        : Promise.resolve([]),
    ]);

    /* AOW label: prefer the official WP code, fall back to acronym, then
     * append the display name when present ("SP01-AOW03 — Inclusive Delivery"). */
    const aowLabels = new Map<number, string>();
    for (const a of aows) {
      const code = a.wpOfficialCode ?? a.acronym ?? '';
      const label = code
        ? a.name
          ? `${code} — ${a.name}`
          : code
        : (a.name ?? '');
      aowLabels.set(a.id, label);
    }
    const outputLabels = new Map<number, string>();
    for (const o of outputs) outputLabels.set(o.id, o.title ?? '');
    const outcomeLabels = new Map<number, string>();
    for (const o of outcomes) outcomeLabels.set(o.id, o.title ?? '');

    /* Accumulate per-mapping label lists, then join. Sorting keeps the cell
     * order stable across exports regardless of link insertion order. */
    const acc = new Map<
      number,
      { aows: string[]; outputs: string[]; outcomes: string[] }
    >();
    for (const l of links) {
      const mid = Number(l.projectMappingId);
      const tocId = Number(l.tocId);
      let bucket = acc.get(mid);
      if (!bucket) {
        bucket = { aows: [], outputs: [], outcomes: [] };
        acc.set(mid, bucket);
      }
      if (l.linkType === MappingTocLinkType.AOW) {
        const label = aowLabels.get(tocId);
        if (label) bucket.aows.push(label);
      } else if (l.linkType === MappingTocLinkType.OUTPUT) {
        const label = outputLabels.get(tocId);
        if (label) bucket.outputs.push(label);
      } else if (l.linkType === MappingTocLinkType.OUTCOME) {
        const label = outcomeLabels.get(tocId);
        if (label) bucket.outcomes.push(label);
      }
    }
    for (const [mid, bucket] of acc) {
      result.set(mid, {
        aows: bucket.aows.sort().join('; '),
        outputs: bucket.outputs.sort().join('; '),
        outcomes: bucket.outcomes.sort().join('; '),
      });
    }
    return result;
  }

  private async writeProjectsSheet(
    workbook: ExcelJS.stream.xlsx.WorkbookWriter,
    projects: ProjectListItem[],
    activeMappingsByProject: Map<number, ProjectMapping[]>,
    countriesByProject: Map<number, string>,
    implementationCountriesByProject: Map<number, string>,
    latestJustificationByMapping: Map<number, string>,
    needsAssistanceProjects: Set<number>,
    tocByMapping: Map<number, MappingTocSummary>,
  ): Promise<void> {
    const sheet = workbook.addWorksheet('Projects', {
      views: [{ state: 'frozen', ySplit: 1 }],
      properties: { tabColor: { argb: TAB_COLORS.green } },
    });

    /* 42 columns in verbatim template order. Column keys are stable
     * identifiers used to look up the column index for per-cell number
     * formats and conditional fills below. */
    sheet.columns = [
      { header: 'ID', key: 'id', width: 8 },
      { header: 'Code', key: 'code', width: 16 },
      { header: 'Name', key: 'name', width: 40 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Center Acronym', key: 'centerAcronym', width: 16 },
      { header: 'Center Name', key: 'centerName', width: 30 },
      { header: 'Location of Benefit', key: 'countries', width: 30 },
      {
        header: 'Country of Implementation',
        key: 'implementationCountries',
        width: 30,
      },
      { header: 'Start Date', key: 'startDate', width: 14 },
      { header: 'End Date', key: 'endDate', width: 14 },
      { header: 'Funding Source', key: 'fundingSource', width: 16 },
      { header: 'Funder', key: 'funder', width: 30 },
      { header: 'Total Budget', key: 'totalBudget', width: 16 },
      { header: 'Remaining Budget', key: 'remainingBudget', width: 18 },
      { header: 'Total Pledge', key: 'totalPledge', width: 16 },
      { header: 'FY Budget', key: 'fyBudget', width: 14 },
      { header: 'Mapped Programs', key: 'mappedPrograms', width: 18 },
      /* Program slot 1 — every column carries the "Program 1" prefix so
       * the slot grouping is unambiguous when sorted/filtered. */
      { header: 'Program 1', key: 'program1', width: 16 },
      { header: 'Program 1 Allc %', key: 'program1Pct', width: 14 },
      {
        header: 'Program 1 Complementarity (HML)',
        key: 'program1Comp',
        width: 26,
      },
      { header: 'Program 1 Efficiency (HML)', key: 'program1Eff', width: 24 },
      { header: 'Program 1 Justification', key: 'program1Just', width: 50 },
      /* Program slot 2 */
      { header: 'Program 2', key: 'program2', width: 16 },
      { header: 'Program 2 Allc %', key: 'program2Pct', width: 14 },
      {
        header: 'Program 2 Complementarity (HML)',
        key: 'program2Comp',
        width: 26,
      },
      { header: 'Program 2 Efficiency (HML)', key: 'program2Eff', width: 24 },
      { header: 'Program 2 Justification', key: 'program2Just', width: 50 },
      /* Program slot 3 */
      { header: 'Program 3', key: 'program3', width: 16 },
      { header: 'Program 3 Allc %', key: 'program3Pct', width: 14 },
      {
        header: 'Program 3 Complementarity (HML)',
        key: 'program3Comp',
        width: 26,
      },
      { header: 'Program 3 Efficiency (HML)', key: 'program3Eff', width: 24 },
      { header: 'Program 3 Justification', key: 'program3Just', width: 50 },
      /* Tail */
      { header: '% check', key: 'percentCheck', width: 12 },
      {
        header: 'In Active Negotiation',
        key: 'inActiveNegotiation',
        width: 22,
      },
      { header: 'Negotiation Locked', key: 'negotiationLocked', width: 20 },
      {
        header: 'Needs Assistance Count',
        key: 'needsAssistanceCount',
        width: 24,
      },
      {
        header: 'Principal Investigator',
        key: 'principalInvestigator',
        width: 28,
      },
      {
        header: 'Signed Contract Title',
        key: 'signedContractTitle',
        width: 40,
      },
      {
        header: 'Funder Primary Center',
        key: 'funderPrimaryCenter',
        width: 28,
      },
      { header: 'Nature of Funder', key: 'natureOfFunder', width: 20 },
      {
        header: 'Project Description (max. 5000 words)',
        key: 'description',
        width: 50,
      },
      { header: 'Summary (max. 150 words)', key: 'summary', width: 50 },
      { header: 'Created At', key: 'createdAt', width: 20 },
      { header: 'Updated At', key: 'updatedAt', width: 20 },
      // Appended at the very end so existing fixed column indexes (used by the
      // center-rep import reader) are never shifted. The legacy 'Principal
      // Investigator' column above is kept in place and will be repurposed later.
      {
        header: 'Principal Investigator Name',
        key: 'principalInvestigatorName',
        width: 28,
      },
      {
        header: 'Principal Investigator Email',
        key: 'principalInvestigatorEmail',
        width: 32,
      },
      /* Boolean flag mirroring the list UI's flagged-mappings badge and the
       * `needsAssistance` filter (NEEDS_ASSISTANCE_SQL): Yes when ≥1 mapping
       * of ANY status has needs_assistance = 1. Kept as the LAST column so
       * the center-rep import reader's fixed indexes never shift. */
      { header: 'Needs Assistance', key: 'needsAssistance', width: 18 },
      /* TOC (Theory of Change) contribution per program slot. Appended at the
       * very end — after `needsAssistance` — so the center-rep import reader's
       * fixed column indexes are never shifted. Each mapping's AOWs / Outputs /
       * Intermediate Outcomes render as semicolon-joined lists. */
      { header: 'Program 1 AOWs', key: 'program1Aows', width: 40 },
      { header: 'Program 1 Outputs', key: 'program1Outputs', width: 40 },
      { header: 'Program 1 Outcomes', key: 'program1Outcomes', width: 40 },
      { header: 'Program 2 AOWs', key: 'program2Aows', width: 40 },
      { header: 'Program 2 Outputs', key: 'program2Outputs', width: 40 },
      { header: 'Program 2 Outcomes', key: 'program2Outcomes', width: 40 },
      { header: 'Program 3 AOWs', key: 'program3Aows', width: 40 },
      { header: 'Program 3 Outputs', key: 'program3Outputs', width: 40 },
      { header: 'Program 3 Outcomes', key: 'program3Outcomes', width: 40 },
    ];

    /* Style the header row. */
    applyHeaderStyle(sheet.getRow(1));

    /* AutoFilter on all columns. */
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: sheet.columns.length },
    };

    /* Cached column indexes for per-cell formatting passes below. Looked
     * up once per sheet to avoid O(rows × cols) findIndex scans. */
    const colIdx = (key: string): number =>
      sheet.columns.findIndex((c) => c.key === key) + 1;

    const currencyCols = [
      colIdx('totalBudget'),
      colIdx('remainingBudget'),
      colIdx('totalPledge'),
      colIdx('fyBudget'),
    ];
    const percentCols = [
      colIdx('program1Pct'),
      colIdx('program2Pct'),
      colIdx('program3Pct'),
      colIdx('percentCheck'),
    ];
    const dateCols = [
      colIdx('startDate'),
      colIdx('endDate'),
      colIdx('createdAt'),
      colIdx('updatedAt'),
    ];

    /* Column references used to build the live "% check" formula. */
    const program1PctCol = colIdx('program1Pct');
    const program2PctCol = colIdx('program2Pct');
    const program3PctCol = colIdx('program3Pct');
    const percentCheckCol = colIdx('percentCheck');
    const colLetter = (n: number): string => {
      let s = '';
      let v = n;
      while (v > 0) {
        const r = (v - 1) % 26;
        s = String.fromCharCode(65 + r) + s;
        v = Math.floor((v - 1) / 26);
      }
      return s;
    };
    const p1Letter = colLetter(program1PctCol);
    const p2Letter = colLetter(program2PctCol);
    const p3Letter = colLetter(program3PctCol);

    for (const project of projects) {
      /* Active mappings for this project, sorted by id ASC (the upstream
       * .find() order). Slots beyond what exists stay blank. */
      const slots = activeMappingsByProject.get(project.id) ?? [];
      const slot1 = slots[0];
      const slot2 = slots[1];
      const slot3 = slots[2];

      /* Pre-rendered TOC contribution strings per slot (blank when absent). */
      const slot1Toc = slot1
        ? (tocByMapping.get(slot1.id) ?? EMPTY_TOC_SUMMARY)
        : EMPTY_TOC_SUMMARY;
      const slot2Toc = slot2
        ? (tocByMapping.get(slot2.id) ?? EMPTY_TOC_SUMMARY)
        : EMPTY_TOC_SUMMARY;
      const slot3Toc = slot3
        ? (tocByMapping.get(slot3.id) ?? EMPTY_TOC_SUMMARY)
        : EMPTY_TOC_SUMMARY;

      /* Computed values that don't map cleanly to a one-liner. */
      const mappedProgramsCodes = slots
        .map((m) => m.program?.officialCode)
        .filter((code): code is string => !!code)
        .join(', ');

      /* Mirrors the per-row `mappingStatus = in_negotiation` bucket so the
       * export flag agrees with the list's Mapping Status badge. A project
       * with only `removed` mappings (e.g. force-unlocked by a signalling
       * import where every row was Removed) is still "in negotiation"
       * because the center needs to resolve / rebalance — relying on
       * `slots` alone would miss those projects since `slots` excludes
       * removed mappings. */
      const inActiveNegotiation =
        project.mappingStatus === MappingStatusFilter.IN_NEGOTIATION;

      /* "Negotiation Locked" cell: when a round is locked, spell out HOW it
       * was resolved so the export answers "negotiation vs admin decision"
       * at a glance, mirroring the list's resolution-path labels. A locked
       * project shows `admin_decision` in its derived mappingStatus only when
       * a workflow admin issued a Final Decision; otherwise the lock came
       * from mutual agreement. Unlocked rounds stay "No". */
      const negotiationLockedLabel = !project.negotiationLocked
        ? 'No'
        : project.mappingStatus === MappingStatusFilter.ADMIN_DECISION
          ? 'Yes - admin decision'
          : 'Yes - negotiation';

      const needsAssistanceCount = slots.reduce(
        (count, m) => count + (m.needsAssistance ? 1 : 0),
        0,
      );

      const slot1Pct =
        slot1?.allocationPercentage != null
          ? Number(slot1.allocationPercentage)
          : null;
      const slot2Pct =
        slot2?.allocationPercentage != null
          ? Number(slot2.allocationPercentage)
          : null;
      const slot3Pct =
        slot3?.allocationPercentage != null
          ? Number(slot3.allocationPercentage)
          : null;

      const row = sheet.addRow({
        id: project.id,
        code: project.code,
        name: project.name,
        status: project.status,
        centerAcronym: project.center?.acronym ?? '',
        centerName: project.center?.name ?? '',
        countries: countriesByProject.get(project.id) ?? '',
        implementationCountries:
          implementationCountriesByProject.get(project.id) ?? '',
        startDate: project.startDate
          ? this.toExcelDate(project.startDate)
          : null,
        endDate: project.endDate ? this.toExcelDate(project.endDate) : null,
        fundingSource: project.fundingSource ?? '',
        funder: project.funder ?? '',
        totalBudget:
          project.totalBudget != null ? Number(project.totalBudget) : null,
        remainingBudget:
          project.remainingBudget != null
            ? Number(project.remainingBudget)
            : null,
        totalPledge:
          project.totalPledge != null ? Number(project.totalPledge) : null,
        fyBudget:
          project.budget2026 != null ? Number(project.budget2026) : null,
        mappedPrograms: mappedProgramsCodes,
        /* Program slot 1 — empty cells when slot is unused. */
        program1: slot1?.program?.officialCode ?? '',
        program1Pct: slot1Pct,
        program1Comp: ratingToLetter(slot1?.complementarityRating),
        program1Eff: ratingToLetter(slot1?.efficiencyRating),
        program1Just: slot1
          ? (latestJustificationByMapping.get(slot1.id) ?? '')
          : '',
        /* Program slot 2 */
        program2: slot2?.program?.officialCode ?? '',
        program2Pct: slot2Pct,
        program2Comp: ratingToLetter(slot2?.complementarityRating),
        program2Eff: ratingToLetter(slot2?.efficiencyRating),
        program2Just: slot2
          ? (latestJustificationByMapping.get(slot2.id) ?? '')
          : '',
        /* Program slot 3 */
        program3: slot3?.program?.officialCode ?? '',
        program3Pct: slot3Pct,
        program3Comp: ratingToLetter(slot3?.complementarityRating),
        program3Eff: ratingToLetter(slot3?.efficiencyRating),
        program3Just: slot3
          ? (latestJustificationByMapping.get(slot3.id) ?? '')
          : '',
        /* Tail */
        inActiveNegotiation: inActiveNegotiation ? 'Yes' : 'No',
        negotiationLocked: negotiationLockedLabel,
        needsAssistanceCount: needsAssistanceCount,
        principalInvestigator: project.principalInvestigator ?? '',
        signedContractTitle: project.signedContractTitle ?? '',
        funderPrimaryCenter: project.funderPrimaryCenter ?? '',
        natureOfFunder: project.natureOfFunder ?? '',
        description: project.description ?? '',
        summary: project.summary ?? '',
        createdAt: project.createdAt
          ? this.toExcelDate(project.createdAt)
          : null,
        updatedAt: project.updatedAt
          ? this.toExcelDate(project.updatedAt)
          : null,
        /* Appended PI columns (do not reorder — kept at the very end). */
        principalInvestigatorName: project.principalInvestigator ?? '',
        principalInvestigatorEmail: project.email ?? '',
        needsAssistance: needsAssistanceProjects.has(project.id) ? 'Yes' : 'No',
        /* TOC contribution per slot (empty when the slot is unused or has no
         * links). Tied to the same slot ordering as the Program N columns. */
        program1Aows: slot1Toc.aows,
        program1Outputs: slot1Toc.outputs,
        program1Outcomes: slot1Toc.outcomes,
        program2Aows: slot2Toc.aows,
        program2Outputs: slot2Toc.outputs,
        program2Outcomes: slot2Toc.outcomes,
        program3Aows: slot3Toc.aows,
        program3Outputs: slot3Toc.outputs,
        program3Outcomes: slot3Toc.outcomes,
      });

      /* "% check" is a live Excel formula so the cell updates when a
       * reviewer tweaks any Program % in place. Empty Program % cells
       * count as 0 inside SUM(), matching prior arithmetic behaviour. */
      if (percentCheckCol > 0) {
        const rn = row.number;
        row.getCell(percentCheckCol).value = {
          formula: `SUM(${p1Letter}${rn},${p2Letter}${rn},${p3Letter}${rn})`,
        } as ExcelJS.CellFormulaValue;
      }

      /* Per-cell number formats. */
      for (const idx of currencyCols) {
        if (idx > 0) row.getCell(idx).numFmt = FMT_CURRENCY;
      }
      for (const idx of percentCols) {
        if (idx > 0) row.getCell(idx).numFmt = FMT_PERCENT;
      }
      for (const idx of dateCols) {
        if (idx > 0) row.getCell(idx).numFmt = FMT_DATE;
      }

      /* Status cell — coloured background. */
      const statusColIdx = colIdx('status');
      if (statusColIdx > 0) {
        const statusCell = row.getCell(statusColIdx);
        statusCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: projectStatusFill(project.status) },
        };
      }

      /* Highlight `Negotiation Locked = Yes` in bold red so a quick eye
       * scan picks out frozen rounds. */
      if (project.negotiationLocked) {
        const lockColIdx = colIdx('negotiationLocked');
        if (lockColIdx > 0) {
          row.getCell(lockColIdx).font = {
            bold: true,
            color: { argb: 'FFCC0000' },
          };
        }
      }

      row.commit();
    }

    await sheet.commit();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private sheet writers — Detail export
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Writes the Project sheet for a detail export.
   *
   * Two-column key/value layout covering every scalar project field.
   * No frozen row or autofilter (key/value pages are read, not filtered).
   */
  private async writeDetailProjectSheet(
    workbook: ExcelJS.stream.xlsx.WorkbookWriter,
    project: Project,
    resolvedByAdminDecision = false,
  ): Promise<void> {
    const sheet = workbook.addWorksheet('Project', {
      properties: { tabColor: { argb: TAB_COLORS.navy } },
    });

    sheet.getColumn(1).width = 28;
    sheet.getColumn(2).width = 60;

    /** Helper to write a label/value row, optionally with custom cell styling. */
    const kv = (
      label: string,
      value: string | number | Date | boolean | null | undefined,
      opts?: { numFmt?: string; bold?: boolean; color?: string },
    ): void => {
      const row = sheet.addRow([label, value ?? '']);
      const labelCell = row.getCell(1);
      labelCell.font = { bold: true };
      if (opts?.numFmt) row.getCell(2).numFmt = opts.numFmt;
      if (opts?.bold || opts?.color) {
        row.getCell(2).font = {
          bold: opts.bold ?? false,
          color: opts.color ? { argb: opts.color } : undefined,
        };
      }
      row.commit();
    };

    kv('ID', project.id);
    kv('Code', project.code);
    kv('Name', project.name);
    kv('Status', project.status);
    kv(
      'Center',
      `${project.center?.acronym ?? ''} ${EM_DASH} ${project.center?.name ?? ''}`,
    );
    kv(
      'Location of Benefit',
      project.isBenefitGlobal
        ? 'Global'
        : (project.benefitCountries
            ?.map(
              (r) => `${r.country?.name} (${Number(r.allocationPercentage)}%)`,
            )
            .join('; ') ?? ''),
    );
    kv(
      'Country of Implementation',
      project.isImplementationGlobal
        ? 'Global'
        : (project.implementationCountries
            ?.map(
              (r) => `${r.country?.name} (${Number(r.allocationPercentage)}%)`,
            )
            .join('; ') ?? ''),
    );
    kv(
      'Start Date',
      project.startDate ? this.toExcelDate(project.startDate) : null,
      { numFmt: FMT_DATE },
    );
    kv('End Date', project.endDate ? this.toExcelDate(project.endDate) : null, {
      numFmt: FMT_DATE,
    });
    kv('Funding Source', project.fundingSource ?? '');
    kv('Funder', project.funder ?? '');
    kv(
      'Total Budget',
      project.totalBudget != null ? Number(project.totalBudget) : 0,
      { numFmt: FMT_CURRENCY },
    );
    kv(
      'Remaining Budget',
      project.remainingBudget != null ? Number(project.remainingBudget) : 0,
      { numFmt: FMT_CURRENCY },
    );
    kv(
      'Total Pledge',
      project.totalPledge != null ? Number(project.totalPledge) : null,
      { numFmt: FMT_CURRENCY },
    );
    kv('Principal Investigator', project.principalInvestigator ?? '');
    kv('Principal Investigator Email', project.email ?? '');
    kv('Signed Contract Title', project.signedContractTitle ?? '');
    kv('Funder Primary Center', project.funderPrimaryCenter ?? '');
    kv('Nature of Funder', project.natureOfFunder ?? '');
    kv('Description', project.description ?? '');
    kv('Summary (150 word max)', project.summary ?? '');

    /* negotiationLocked — bold red when locked; spell out the resolution
     * path (negotiation vs admin decision) so the detail sheet matches the
     * list export and the projects-list resolution labels. */
    kv(
      'Negotiation Locked',
      project.negotiationLocked
        ? resolvedByAdminDecision
          ? 'Yes - admin decision'
          : 'Yes - negotiation'
        : 'No',
      project.negotiationLocked ? { bold: true, color: 'FFCC0000' } : undefined,
    );

    kv(
      'Created At',
      project.createdAt ? this.toExcelDate(project.createdAt) : null,
      { numFmt: FMT_DATE },
    );
    kv(
      'Updated At',
      project.updatedAt ? this.toExcelDate(project.updatedAt) : null,
      { numFmt: FMT_DATE },
    );

    await sheet.commit();
  }

  /**
   * Writes the Budgets sheet for a detail export (single project).
   */
  private async writeDetailBudgetsSheet(
    workbook: ExcelJS.stream.xlsx.WorkbookWriter,
    budgets: ProjectBudget[],
  ): Promise<void> {
    const sheet = workbook.addWorksheet('Budgets', {
      views: [{ state: 'frozen', ySplit: 1 }],
      properties: { tabColor: { argb: TAB_COLORS.orange } },
    });

    sheet.columns = [
      { header: 'Year', key: 'year', width: 10 },
      { header: 'Version', key: 'version', width: 14 },
      { header: 'Account', key: 'account', width: 50 },
      { header: 'External Code', key: 'externalCode', width: 20 },
      { header: 'Amount', key: 'amount', width: 16 },
    ];

    applyHeaderStyle(sheet.getRow(1));
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: sheet.columns.length },
    };

    for (const budget of budgets) {
      const row = sheet.addRow({
        year: budget.year,
        version: budget.version,
        account: budget.account,
        externalCode: budget.externalCode ?? '',
        amount: budget.amount != null ? Number(budget.amount) : 0,
      });

      const amtColIdx = sheet.columns.findIndex((c) => c.key === 'amount') + 1;
      if (amtColIdx > 0) row.getCell(amtColIdx).numFmt = FMT_CURRENCY;

      row.commit();
    }

    await sheet.commit();
  }

  /**
   * Writes the Mappings sheet for a detail export.
   *
   * All mappings, including removed ones, with full negotiation-state columns.
   */
  private async writeDetailMappingsSheet(
    workbook: ExcelJS.stream.xlsx.WorkbookWriter,
    mappings: ProjectMapping[],
  ): Promise<void> {
    const sheet = workbook.addWorksheet('Mappings', {
      views: [{ state: 'frozen', ySplit: 1 }],
      properties: { tabColor: { argb: TAB_COLORS.blue } },
    });

    sheet.columns = [
      { header: 'Program Code', key: 'programCode', width: 16 },
      { header: 'Program Name', key: 'programName', width: 40 },
      { header: 'Allocation %', key: 'allocationPercentage', width: 14 },
      { header: 'Status', key: 'status', width: 14 },
      { header: 'Center Agreed', key: 'centerAgreed', width: 14 },
      { header: 'Program Agreed', key: 'programAgreed', width: 16 },
      { header: 'Needs Assistance', key: 'needsAssistance', width: 18 },
      { header: 'Initiated By', key: 'initiatedBy', width: 28 },
      { header: 'Initiated At', key: 'initiatedAt', width: 20 },
      { header: 'Flagged At', key: 'flaggedAt', width: 20 },
      { header: 'Updated At', key: 'updatedAt', width: 20 },
    ];

    applyHeaderStyle(sheet.getRow(1));
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: sheet.columns.length },
    };

    for (const mapping of mappings) {
      const row = sheet.addRow({
        programCode: mapping.program?.officialCode ?? '',
        programName: mapping.program?.name ?? '',
        allocationPercentage:
          mapping.allocationPercentage != null
            ? Number(mapping.allocationPercentage)
            : null,
        status: mapping.status,
        centerAgreed: mapping.centerAgreed ? 'Yes' : 'No',
        programAgreed: mapping.programAgreed ? 'Yes' : 'No',
        needsAssistance: mapping.needsAssistance ? 'Yes' : 'No',
        initiatedBy: mapping.initiatedBy?.email ?? '',
        initiatedAt: mapping.initiatedAt
          ? this.toExcelDate(mapping.initiatedAt)
          : null,
        flaggedAt: mapping.flaggedAt
          ? this.toExcelDate(mapping.flaggedAt)
          : null,
        updatedAt: mapping.updatedAt
          ? this.toExcelDate(mapping.updatedAt)
          : null,
      });

      const allocColIdx =
        sheet.columns.findIndex((c) => c.key === 'allocationPercentage') + 1;
      if (allocColIdx > 0) row.getCell(allocColIdx).numFmt = FMT_PERCENT;

      (['initiatedAt', 'flaggedAt', 'updatedAt'] as const).forEach((key) => {
        const colIdx = sheet.columns.findIndex((c) => c.key === key) + 1;
        if (colIdx > 0) row.getCell(colIdx).numFmt = FMT_DATE;
      });

      const statusColIdx =
        sheet.columns.findIndex((c) => c.key === 'status') + 1;
      if (statusColIdx > 0) {
        row.getCell(statusColIdx).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: mappingStatusFill(mapping.status) },
        };
      }

      row.commit();
    }

    await sheet.commit();
  }

  /**
   * Writes the Negotiation Events sheet for a detail export.
   *
   * One row per `mapping_negotiations` event ordered chronologically.
   */
  private async writeNegotiationEventsSheet(
    workbook: ExcelJS.stream.xlsx.WorkbookWriter,
    events: MappingNegotiation[],
  ): Promise<void> {
    const sheet = workbook.addWorksheet('Negotiation Events', {
      views: [{ state: 'frozen', ySplit: 1 }],
      properties: { tabColor: { argb: TAB_COLORS.purple } },
    });

    sheet.columns = [
      { header: 'Program Code', key: 'programCode', width: 16 },
      { header: 'Event Type', key: 'eventType', width: 20 },
      { header: 'Actor Email', key: 'actorEmail', width: 30 },
      { header: 'Actor Role', key: 'actorRole', width: 16 },
      { header: 'Proposed Allocation %', key: 'proposedAllocation', width: 22 },
      { header: 'Justification', key: 'justification', width: 50 },
      { header: 'Created At', key: 'createdAt', width: 20 },
    ];

    applyHeaderStyle(sheet.getRow(1));
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: sheet.columns.length },
    };

    for (const event of events) {
      const row = sheet.addRow({
        programCode: event.mapping?.program?.officialCode ?? '',
        eventType: event.eventType,
        actorEmail: event.actor?.email ?? '',
        actorRole: event.actorRole,
        proposedAllocation:
          event.proposedAllocation != null
            ? Number(event.proposedAllocation)
            : null,
        justification: event.justification ?? '',
        createdAt: event.createdAt ? this.toExcelDate(event.createdAt) : null,
      });

      const allocColIdx =
        sheet.columns.findIndex((c) => c.key === 'proposedAllocation') + 1;
      if (allocColIdx > 0 && event.proposedAllocation != null) {
        row.getCell(allocColIdx).numFmt = FMT_PERCENT;
      }

      const dateColIdx =
        sheet.columns.findIndex((c) => c.key === 'createdAt') + 1;
      if (dateColIdx > 0) row.getCell(dateColIdx).numFmt = FMT_DATE;

      row.commit();
    }

    await sheet.commit();
  }

  /**
   * Writes the Chat sheet for a detail export.
   *
   * One row per `project_negotiation_messages` message.
   */
  private async writeChatSheet(
    workbook: ExcelJS.stream.xlsx.WorkbookWriter,
    messages: ProjectNegotiationMessage[],
  ): Promise<void> {
    const sheet = workbook.addWorksheet('Chat', {
      views: [{ state: 'frozen', ySplit: 1 }],
      properties: { tabColor: { argb: TAB_COLORS.teal } },
    });

    sheet.columns = [
      { header: 'Author Email', key: 'authorEmail', width: 30 },
      { header: 'Message', key: 'message', width: 80 },
      { header: 'Created At', key: 'createdAt', width: 20 },
    ];

    applyHeaderStyle(sheet.getRow(1));
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: sheet.columns.length },
    };

    for (const msg of messages) {
      const row = sheet.addRow({
        authorEmail: msg.actor?.email ?? '',
        message: msg.message,
        createdAt: msg.createdAt ? this.toExcelDate(msg.createdAt) : null,
      });

      const dateColIdx =
        sheet.columns.findIndex((c) => c.key === 'createdAt') + 1;
      if (dateColIdx > 0) row.getCell(dateColIdx).numFmt = FMT_DATE;

      row.commit();
    }

    await sheet.commit();
  }

  /**
   * Writes the Audit sheet for a detail export.
   *
   * One row per audit event from the unified `audit_events` table,
   * most-recent first. Field-level diffs are flattened: events with
   * multiple changed fields produce one row per (event, field) pair so
   * each cell's before/after is readable inline. Events without a
   * `changes` payload (e.g. project.archive without diff, snapshot.create)
   * collapse to a single row with empty Field/Before/After cells.
   */
  private async writeAuditSheet(
    workbook: ExcelJS.stream.xlsx.WorkbookWriter,
    events: AuditEvent[],
  ): Promise<void> {
    const sheet = workbook.addWorksheet('Audit', {
      views: [{ state: 'frozen', ySplit: 1 }],
      properties: { tabColor: { argb: TAB_COLORS.red } },
    });

    sheet.columns = [
      { header: 'Actor Email', key: 'actorEmail', width: 30 },
      { header: 'Actor Role', key: 'actorRole', width: 16 },
      { header: 'Action', key: 'action', width: 28 },
      { header: 'Field Name', key: 'fieldName', width: 24 },
      { header: 'Value Before', key: 'valueBefore', width: 30 },
      { header: 'Value After', key: 'valueAfter', width: 30 },
      { header: 'Summary', key: 'summary', width: 40 },
      { header: 'Justification', key: 'justification', width: 50 },
      { header: 'Created At', key: 'createdAt', width: 20 },
    ];

    applyHeaderStyle(sheet.getRow(1));
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: sheet.columns.length },
    };

    /* Helper: serialise a JSON-encoded value to a printable cell string.
     * Strings are written as-is; everything else is JSON-stringified so
     * the cell shows the same shape we stored. */
    const formatValue = (value: unknown): string => {
      if (value === null || value === undefined) return '';
      if (typeof value === 'string') return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };

    for (const event of events) {
      const fields = event.changes ? Object.keys(event.changes) : [];

      if (fields.length === 0) {
        /* Single row for events without a changes payload. */
        const row = sheet.addRow({
          actorEmail: event.actorEmail ?? '',
          actorRole: event.actorRole,
          action: event.action,
          fieldName: '',
          valueBefore: '',
          valueAfter: '',
          summary: event.summary ?? '',
          justification: event.justification ?? '',
          createdAt: event.createdAt ? this.toExcelDate(event.createdAt) : null,
        });
        const dateColIdx =
          sheet.columns.findIndex((c) => c.key === 'createdAt') + 1;
        if (dateColIdx > 0) row.getCell(dateColIdx).numFmt = FMT_DATE;
        row.commit();
        continue;
      }

      /* One row per (event, changed field) pair. */
      for (const field of fields) {
        const change = event.changes![field];
        const row = sheet.addRow({
          actorEmail: event.actorEmail ?? '',
          actorRole: event.actorRole,
          action: event.action,
          fieldName: field,
          valueBefore: formatValue(change.before),
          valueAfter: formatValue(change.after),
          summary: event.summary ?? '',
          justification: event.justification ?? '',
          createdAt: event.createdAt ? this.toExcelDate(event.createdAt) : null,
        });

        const dateColIdx =
          sheet.columns.findIndex((c) => c.key === 'createdAt') + 1;
        if (dateColIdx > 0) row.getCell(dateColIdx).numFmt = FMT_DATE;

        row.commit();
      }
    }

    await sheet.commit();
  }

  /**
   * Loads all audit events for a project from the unified audit log.
   *
   * Walks pages through AuditService.query() until the project's audit
   * tail is exhausted or the safety cap is hit. Visibility scope is
   * derived from the caller's role.
   *
   * The detail export endpoint is open to every authenticated role
   * (admin, unit_admin, workflow_admin, center_rep, program_rep), but
   * AuditService.applyVisibilityScope() only recognises the first three
   * and throws ForbiddenException for the rest. Rather than letting that
   * 403 tank the whole export (which was the symptom reported in QA
   * Round 1, bug #4 — request hangs because the throw happens BEFORE
   * headers are flushed but is then re-thrown post-headers if any other
   * concurrent loader was already piping), we degrade gracefully: roles
   * without audit visibility get an empty Audit sheet, every other sheet
   * still produced. The export endpoint is a read-only convenience and
   * leaking audit rows to those roles would be the bigger problem.
   */
  private async loadProjectAuditEvents(
    projectId: number,
    user: User,
  ): Promise<AuditEvent[]> {
    const role = user.role ?? UserRole.ADMIN;
    const all: AuditEvent[] = [];

    try {
      for (let page = 1; page <= AUDIT_EXPORT_MAX_PAGES; page++) {
        const { items, total } = await this.auditService.query(
          {
            entityType: AuditEntityType.PROJECT,
            entityId: projectId,
            page,
            limit: AUDIT_EXPORT_PAGE_SIZE,
            sort: 'created_at',
            direction: 'desc',
          },
          role,
          user.id,
        );

        all.push(...items);
        if (all.length >= total || items.length < AUDIT_EXPORT_PAGE_SIZE) {
          break;
        }
      }
    } catch (err) {
      /* Roles outside the audit-visibility allowlist trigger a
       * ForbiddenException — swallow it and return an empty audit
       * tail. Re-throw anything else (e.g. DB connectivity, query
       * planner errors) so the outer try/catch in streamDetailExport
       * can destroy the response stream cleanly. */
      if (err instanceof ForbiddenException) {
        this.logger.debug(
          `Skipping Audit sheet for role=${role} on projectId=${projectId} (no audit visibility)`,
        );
        return [];
      }
      throw err;
    }

    return all;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Utility
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Converts a JS Date to an Excel serial date number.
   *
   * ExcelJS expects a JS Date object for date cells — passing one directly
   * is cleaner than converting to a string and letting the library re-parse.
   * We return the original Date cast so TypeScript is happy while keeping
   * the cell value as a real Excel date (formatted by numFmt).
   */
  private toExcelDate(value: Date | string): Date {
    return value instanceof Date ? value : new Date(value);
  }
}
