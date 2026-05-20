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
   * Streams a filtered project list as a 4-sheet Excel workbook matching
   * the canonical PRMS export template:
   *   Sheet 1 — Summary  (export metadata + applied filters)
   *   Sheet 2 — Projects (44 verbatim columns including 3 program slots)
   *   Sheet 3 — Mappings (13 verbatim columns, includes removed rows)
   *   Sheet 4 — Budgets  (6 verbatim columns from project_budgets)
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

    /* Load mappings + budgets + countries in parallel. Mappings include the
     * program + initiatedBy relations so both the Projects sheet (program
     * slots) and the Mappings sheet can render names/emails without
     * re-querying. Countries are loaded separately because ProjectsService.findAll
     * intentionally omits the countries join for list performance. */
    const [mappings, budgets, projectsWithCountries] = await Promise.all([
      projectIds.length
        ? this.mappingRepository.find({
            where: { projectId: In(projectIds) },
            relations: ['program', 'initiatedBy'],
            order: { id: 'ASC' },
          })
        : Promise.resolve([]),
      projectIds.length
        ? this.budgetRepository.find({
            where: { projectId: In(projectIds) },
          })
        : Promise.resolve([]),
      projectIds.length
        ? this.projectRepository.find({
            where: { id: In(projectIds) },
            relations: ['countries'],
            select: { id: true },
          })
        : Promise.resolve([]),
    ]);

    /* Build id → comma-joined country names map for the Countries column. */
    const countriesByProject = new Map<number, string>();
    for (const p of projectsWithCountries) {
      const names = (p.countries ?? []).map((c) => c.name).join(', ');
      countriesByProject.set(p.id, names);
    }

    /* Group active (non-removed) mappings per project, preserving id ASC
     * order. This is the slot ordering used by the Projects sheet columns
     * R–AC (Program 1/2/3 + their %/ratings). */
    const activeMappingsByProject = new Map<number, ProjectMapping[]>();
    for (const m of mappings) {
      if (m.status === MappingStatus.REMOVED) continue;
      const slot = activeMappingsByProject.get(m.projectId) ?? [];
      slot.push(m);
      activeMappingsByProject.set(m.projectId, slot);
    }

    /* Denormalisation maps for the Mappings sheet (project code / name lookup). */
    const idToCode = new Map<number, string>(
      projects.map((p) => [p.id, p.code]),
    );
    const idToName = new Map<number, string>(
      projects.map((p) => [p.id, p.name]),
    );

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

      /* ── Sheet 2: Projects (44 cols) ────────────────────────────────── */
      await this.writeProjectsSheet(
        workbook,
        projects,
        activeMappingsByProject,
        countriesByProject,
      );

      /* ── Sheet 3: Mappings (13 cols, includes removed) ──────────────── */
      await this.writeMappingsSheet(workbook, mappings, idToCode, idToName);

      /* ── Sheet 4: Budgets (6 cols) ──────────────────────────────────── */
      await this.writeBudgetsSheet(workbook, budgets, idToCode);

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
      await this.writeDetailProjectSheet(workbook, project);

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
   * Writes the Projects sheet for a list export — 44 columns matching the
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
  private async writeProjectsSheet(
    workbook: ExcelJS.stream.xlsx.WorkbookWriter,
    projects: ProjectListItem[],
    activeMappingsByProject: Map<number, ProjectMapping[]>,
    countriesByProject: Map<number, string>,
  ): Promise<void> {
    const sheet = workbook.addWorksheet('Projects', {
      views: [{ state: 'frozen', ySplit: 1 }],
      properties: { tabColor: { argb: TAB_COLORS.green } },
    });

    /* 44 columns in verbatim template order. Column keys are stable
     * identifiers used to look up the column index for per-cell number
     * formats and conditional fills below. */
    sheet.columns = [
      { header: 'ID', key: 'id', width: 8 },
      { header: 'Code', key: 'code', width: 16 },
      { header: 'Name', key: 'name', width: 40 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Center Acronym', key: 'centerAcronym', width: 16 },
      { header: 'Center Name', key: 'centerName', width: 30 },
      { header: 'Countries', key: 'countries', width: 30 },
      { header: 'Start Date', key: 'startDate', width: 14 },
      { header: 'End Date', key: 'endDate', width: 14 },
      { header: 'Funding Source', key: 'fundingSource', width: 16 },
      { header: 'Funder', key: 'funder', width: 30 },
      { header: 'Total Budget', key: 'totalBudget', width: 16 },
      { header: 'Remaining Budget', key: 'remainingBudget', width: 18 },
      { header: 'Total Pledge', key: 'totalPledge', width: 16 },
      { header: 'FY Budget', key: 'fyBudget', width: 14 },
      { header: 'Agreed Alloc %', key: 'agreedAllocPct', width: 16 },
      { header: 'Mapped Programs', key: 'mappedPrograms', width: 18 },
      /* Program slot 1 (R–U) */
      { header: 'Program 1', key: 'program1', width: 16 },
      { header: 'Program %', key: 'program1Pct', width: 12 },
      { header: 'Complementarity (HML)', key: 'program1Comp', width: 20 },
      { header: 'Efficiency (HML)', key: 'program1Eff', width: 18 },
      /* Program slot 2 (V–Y) */
      { header: 'Program 2', key: 'program2', width: 16 },
      { header: 'Program %', key: 'program2Pct', width: 12 },
      { header: 'Complementarity (HML)', key: 'program2Comp', width: 20 },
      { header: 'Efficiency (HML)', key: 'program2Eff', width: 18 },
      /* Program slot 3 (Z–AC) */
      { header: 'Program 3', key: 'program3', width: 16 },
      { header: 'Program %', key: 'program3Pct', width: 12 },
      { header: 'Complementarity (HML)', key: 'program3Comp', width: 20 },
      { header: 'Efficiency (HML)', key: 'program3Eff', width: 18 },
      /* Tail (AD–AR) */
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
      { header: 'Description', key: 'description', width: 50 },
      { header: 'Summary', key: 'summary', width: 50 },
      { header: 'Created At', key: 'createdAt', width: 20 },
      { header: 'Updated At', key: 'updatedAt', width: 20 },
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
      colIdx('agreedAllocPct'),
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

    for (const project of projects) {
      /* Active mappings for this project, sorted by id ASC (the upstream
       * .find() order). Slots beyond what exists stay blank. */
      const slots = activeMappingsByProject.get(project.id) ?? [];
      const slot1 = slots[0];
      const slot2 = slots[1];
      const slot3 = slots[2];

      /* Computed values that don't map cleanly to a one-liner. */
      const agreedAllocPct = slots
        .filter((m) => m.status === MappingStatus.AGREED)
        .reduce((sum, m) => sum + Number(m.allocationPercentage ?? 0), 0);

      const mappedProgramsCodes = slots
        .map((m) => m.program?.officialCode)
        .filter((code): code is string => !!code)
        .join(', ');

      const inActiveNegotiation = slots.some(
        (m) => m.status === MappingStatus.NEGOTIATING,
      );

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

      /* Arithmetic sum of populated slot %s — NOT an Excel formula. Falls
       * back to 0 when no slots are populated so the column type stays
       * numeric (Excel sums won't choke on a string). */
      const percentCheck = (slot1Pct ?? 0) + (slot2Pct ?? 0) + (slot3Pct ?? 0);

      const row = sheet.addRow({
        id: project.id,
        code: project.code,
        name: project.name,
        status: project.status,
        centerAcronym: project.center?.acronym ?? '',
        centerName: project.center?.name ?? '',
        countries: countriesByProject.get(project.id) ?? '',
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
        fyBudget: project.budget2026 != null ? Number(project.budget2026) : null,
        agreedAllocPct: agreedAllocPct,
        mappedPrograms: mappedProgramsCodes,
        /* Program slot 1 — empty cells when slot is unused. */
        program1: slot1?.program?.officialCode ?? '',
        program1Pct: slot1Pct,
        program1Comp: ratingToLetter(slot1?.complementarityRating),
        program1Eff: ratingToLetter(slot1?.efficiencyRating),
        /* Program slot 2 */
        program2: slot2?.program?.officialCode ?? '',
        program2Pct: slot2Pct,
        program2Comp: ratingToLetter(slot2?.complementarityRating),
        program2Eff: ratingToLetter(slot2?.efficiencyRating),
        /* Program slot 3 */
        program3: slot3?.program?.officialCode ?? '',
        program3Pct: slot3Pct,
        program3Comp: ratingToLetter(slot3?.complementarityRating),
        program3Eff: ratingToLetter(slot3?.efficiencyRating),
        /* Tail */
        percentCheck: percentCheck,
        inActiveNegotiation: inActiveNegotiation ? 'Yes' : 'No',
        negotiationLocked: project.negotiationLocked ? 'Yes' : 'No',
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
      });

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

  /**
   * Writes the Mappings sheet for a list export — 13 verbatim columns.
   *
   * Includes `removed` rows: the export preserves the full negotiation
   * audit trail so a reviewer can see programs that were dropped from
   * the round. Sorted by mapping id ASC (the upstream .find() order).
   */
  private async writeMappingsSheet(
    workbook: ExcelJS.stream.xlsx.WorkbookWriter,
    mappings: ProjectMapping[],
    idToCode: Map<number, string>,
    idToName: Map<number, string>,
  ): Promise<void> {
    const sheet = workbook.addWorksheet('Mappings', {
      views: [{ state: 'frozen', ySplit: 1 }],
      properties: { tabColor: { argb: TAB_COLORS.blue } },
    });

    sheet.columns = [
      { header: 'Project Code', key: 'projectCode', width: 16 },
      { header: 'Project Name', key: 'projectName', width: 40 },
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

    /* Cache column indexes. */
    const colIdx = (key: string): number =>
      sheet.columns.findIndex((c) => c.key === key) + 1;
    const allocColIdx = colIdx('allocationPercentage');
    const statusColIdx = colIdx('status');
    const dateColIdxes = [
      colIdx('initiatedAt'),
      colIdx('flaggedAt'),
      colIdx('updatedAt'),
    ];

    /* Include ALL mappings including removed — the template preserves the
     * full audit trail per spec. */
    for (const mapping of mappings) {
      const row = sheet.addRow({
        projectCode: idToCode.get(mapping.projectId) ?? '',
        projectName: idToName.get(mapping.projectId) ?? '',
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

      if (allocColIdx > 0) row.getCell(allocColIdx).numFmt = FMT_PERCENT;
      for (const idx of dateColIdxes) {
        if (idx > 0) row.getCell(idx).numFmt = FMT_DATE;
      }

      /* Status fill. */
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
   * Writes the Budgets sheet for a list export — 6 verbatim columns.
   *
   * Renders the header row even when `budgets` is empty so the sheet's
   * structure is always present in the workbook (matches template spec).
   */
  private async writeBudgetsSheet(
    workbook: ExcelJS.stream.xlsx.WorkbookWriter,
    budgets: ProjectBudget[],
    idToCode: Map<number, string>,
  ): Promise<void> {
    const sheet = workbook.addWorksheet('Budgets', {
      views: [{ state: 'frozen', ySplit: 1 }],
      properties: { tabColor: { argb: TAB_COLORS.orange } },
    });

    sheet.columns = [
      { header: 'Project Code', key: 'projectCode', width: 16 },
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

    const amtColIdx = sheet.columns.findIndex((c) => c.key === 'amount') + 1;

    for (const budget of budgets) {
      const row = sheet.addRow({
        projectCode: idToCode.get(budget.projectId) ?? '',
        year: budget.year,
        version: budget.version,
        account: budget.account,
        externalCode: budget.externalCode ?? '',
        amount: budget.amount != null ? Number(budget.amount) : null,
      });

      if (amtColIdx > 0) row.getCell(amtColIdx).numFmt = FMT_CURRENCY;
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
    kv('Countries', project.countries?.map((c) => c.name).join('; ') ?? '');
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
    kv('Signed Contract Title', project.signedContractTitle ?? '');
    kv('Funder Primary Center', project.funderPrimaryCenter ?? '');
    kv('Nature of Funder', project.natureOfFunder ?? '');
    kv('Description', project.description ?? '');
    kv('Summary', project.summary ?? '');

    /* negotiationLocked — bold red when true. */
    kv(
      'Negotiation Locked',
      project.negotiationLocked ? 'Yes' : 'No',
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
