import {
  Injectable,
  BadRequestException,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In, Not } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as ExcelJS from 'exceljs';
import * as crypto from 'crypto';

import { Project } from '../projects/entities/project.entity';
import { ProjectMapping } from '../mappings/entities/project-mapping.entity';
import { MappingNegotiation } from '../mappings/entities/mapping-negotiation.entity';
import { Program } from '../reference-data/entities/program.entity';
import { User } from '../users/entities/user.entity';

import { MappingStatus } from '../mappings/enums/mapping-status.enum';
import { NegotiationEventType } from '../mappings/enums/negotiation-event-type.enum';
import { ActorRole } from '../mappings/enums/actor-role.enum';
import { UserRole } from '../users/enums/user-role.enum';
import { Rating } from '../mappings/enums/rating.enum';
import { ProjectStatus } from '../projects/enums/project-status.enum';

import {
  ParsedImportRow,
  ImportRowError,
  ImportRowWarning,
  ImportSkippedProject,
  ValidateImportResponse,
  PreviewCreate,
  PreviewUpdate,
  PreviewRemove,
  PreviewDetailUpdate,
} from './dto/validate-import.dto';

/** Batch session stored in-memory between validate and commit calls. */
interface BatchSession {
  rows: ParsedImportRow[];
  actorId: number;
  centerId: number;
  expiresAt: number;
  evictionTimer: ReturnType<typeof setTimeout>;
}

/** JWT payload embedded in the batchId token. */
interface BatchJwtPayload {
  actorId: number;
  centerId: number;
  batchHash: string;
}

/** Result returned by POST /center-imports/mappings/commit */
export interface CommitResult {
  imported: number;
  removed: number;
  projectsAffected: number;
}

/** Session TTL: 30 minutes (same as batchId JWT expiry). */
const SESSION_TTL_MS = 30 * 60 * 1000;
/** Eviction fires 5 minutes after JWT expiry to cover clock skew. */
const EVICTION_TTL_MS = SESSION_TTL_MS + 5 * 60 * 1000;

/** Valid rating strings accepted from the Excel file (case-insensitive normalized). */
const VALID_RATINGS = new Set<string>(['high', 'medium', 'low']);

/** Maximum active mappings per project (same cap as the manual negotiation flow). */
const MAX_ACTIVE_MAPPINGS = 3;

/**
 * Read a single cell as a trimmed string, flattening rich-text fragments.
 * Handles null, undefined, numeric, and rich-text cell values uniformly.
 */
function readCellString(row: ExcelJS.Row, col: number): string {
  const val = row.getCell(col).value;
  if (val === null || val === undefined) return '';
  if (typeof val === 'object') {
    // Rich-text cell — flatten the fragments.
    if ('richText' in val) {
      return (val as ExcelJS.CellRichTextValue).richText
        .map((r) => r.text)
        .join('')
        .trim();
    }
    // Hyperlink cell (e.g. the PI email mailto link). ExcelJS surfaces these
    // as { text, hyperlink }; use the display text, NOT String(obj) which
    // would yield "[object Object]".
    if ('text' in val) {
      return String((val as ExcelJS.CellHyperlinkValue).text ?? '').trim();
    }
    // Formula cell — use its computed result.
    if ('result' in val) {
      const result = (val as ExcelJS.CellFormulaValue).result;
      return result === null || result === undefined
        ? ''
        : String(result).trim();
    }
  }
  return String(val).trim();
}

/**
 * Read an allocation-percentage cell, tolerating every way the value can
 * arrive across Excel files and export versions.
 *
 * A percent-formatted cell can hold the value in two different forms:
 *  - Excel's native form: a cell shown as "25%" stores the fraction 0.25.
 *  - Our projects export applies a percent format to a cell that already
 *    holds the WHOLE-NUMBER percent (25) — Excel renders that as "2500%"
 *    but stores 25.
 * ExcelJS surfaces the stored number, not the displayed text, so we must
 * tell these apart. Valid allocations are 1–100, so a fractional form is
 * always ≤ 1 while a whole-number form is > 1. We therefore scale by 100
 * ONLY when a percent-formatted cell holds a value ≤ 1; values > 1 (and any
 * non-percent-formatted cell — plain numbers, or text like "25") are
 * returned verbatim. The sole ambiguous value, exactly 1, is read as 100%.
 *
 * Returns a string so the existing parseFloat/NaN pipeline is unchanged.
 */
function readAllocationString(row: ExcelJS.Row, col: number): string {
  const cell = row.getCell(col);
  const val = cell.value;
  if (val === null || val === undefined) return '';

  // Only numeric values can carry a percentage format. Text/richText cells
  // (e.g. a literal "25" typed as text) fall through to readCellString.
  if (typeof val === 'number') {
    const numFmt = cell.numFmt ?? '';
    // Percent-formatted AND stored as a fraction (≤ 1) → scale to a whole
    // percent. A percent-formatted whole number (> 1) is already a percent
    // and must NOT be scaled — our export mis-applies a percent format to
    // whole-number allocations (e.g. 70, which Excel renders as "7000%").
    if (numFmt.includes('%') && val <= 1) {
      // Round to 4dp to shed binary-float noise (0.25 * 100 = 25.0000004).
      return String(Math.round(val * 100 * 1e4) / 1e4);
    }
  }

  return readCellString(row, col);
}

/**
 * Normalize a rating cell value. Accepts full words ("high"/"medium"/"low")
 * from the legacy template AND single letters ("H"/"M"/"L") from the
 * projects export. Returns the lowercase full-word form (or '' if empty).
 */
function normalizeRating(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (!v) return '';
  if (v === 'h') return 'high';
  if (v === 'm') return 'medium';
  if (v === 'l') return 'low';
  return v;
}

/**
 * Service powering the center-rep bulk mappings importer.
 *
 * Two-phase flow:
 *  1. validate() — parse, validate, build preview, issue batchId JWT
 *  2. commit()   — verify JWT, replay rows against the negotiation workflow
 *
 * All negotiation events are attributed to the uploading user (never a
 * synthetic system user), preserving full audit integrity.
 */
@Injectable()
export class CenterImportsService {
  private readonly logger = new Logger(CenterImportsService.name);

  /** In-memory batch session store: batchId JWT string → session data. */
  private readonly sessions = new Map<string, BatchSession>();

  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(ProjectMapping)
    private readonly mappingRepo: Repository<ProjectMapping>,
    @InjectRepository(Program)
    private readonly programRepo: Repository<Program>,
    @InjectRepository(MappingNegotiation)
    private readonly negotiationRepo: Repository<MappingNegotiation>,
    private readonly dataSource: DataSource,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // TEMPLATE DOWNLOAD
  // ---------------------------------------------------------------------------

  /**
   * Build and return an Excel workbook pre-filled with the actor's center's
   * current active projects and their active mappings.
   *
   * One row per active mapping. Projects with no mappings get a single blank
   * row with the project code pre-filled so the user can add programs.
   */
  async buildTemplate(user: User): Promise<Buffer> {
    // RBAC guard ensures center_rep/workflow_admin always have a centerId.
    const centerId = user.centerId as number;

    // Load all non-archived projects for this center.
    const projects = await this.projectRepo.find({
      where: { centerId, status: Not(ProjectStatus.ARCHIVED) },
      order: { code: 'ASC' },
    });

    // Load all active (non-removed) mappings for those projects, with program join.
    const projectIds = projects.map((p) => p.id);
    const mappings =
      projectIds.length > 0
        ? await this.mappingRepo.find({
            where: {
              projectId: In(projectIds),
              status: Not(MappingStatus.REMOVED),
            },
            relations: ['program'],
          })
        : [];

    // Group mappings by projectId for quick lookup.
    const mappingsByProject = new Map<number, ProjectMapping[]>();
    for (const m of mappings) {
      const list = mappingsByProject.get(m.projectId) ?? [];
      list.push(m);
      mappingsByProject.set(m.projectId, list);
    }

    // Build workbook.
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Mappings');

    // Header row — bold.
    sheet.columns = [
      { header: 'Project Code', key: 'projectCode', width: 20 },
      { header: 'Project Name', key: 'projectName', width: 45 },
      { header: 'Program Code', key: 'programCode', width: 20 },
      { header: 'Allocation %', key: 'allocation', width: 15 },
      { header: 'Complementarity Rating', key: 'complementarity', width: 25 },
      { header: 'Efficiency Rating', key: 'efficiency', width: 20 },
      { header: 'Justification', key: 'justification', width: 50 },
    ];
    sheet.getRow(1).font = { bold: true };

    // Data rows.
    for (const project of projects) {
      const projectMappings = mappingsByProject.get(project.id) ?? [];

      if (projectMappings.length === 0) {
        // Blank row for projects with no mappings — just project code + name.
        sheet.addRow({
          projectCode: project.code,
          projectName: project.name,
          programCode: '',
          allocation: '',
          complementarity: '',
          efficiency: '',
          justification: '',
        });
      } else {
        for (const m of projectMappings) {
          sheet.addRow({
            projectCode: project.code,
            projectName: project.name,
            programCode: m.program?.officialCode ?? '',
            allocation: m.allocationPercentage,
            complementarity: m.complementarityRating ?? '',
            efficiency: m.efficiencyRating ?? '',
            justification: '',
          });
        }
      }
    }

    const buffer = await workbook.xlsx.writeBuffer();
    this.logger.log(
      `Template built for centerId=${centerId}: ${projects.length} projects, ${mappings.length} mapping rows`,
    );
    // writeBuffer() returns Buffer<ArrayBufferLike> in newer Node types;
    // cast via unknown to plain Buffer to satisfy the return type.
    return buffer as unknown as Buffer;
  }

  // ---------------------------------------------------------------------------
  // VALIDATE
  // ---------------------------------------------------------------------------

  /**
   * Parse and validate an uploaded Excel file.
   *
   * Returns a full preview with create/update/remove classification and
   * a batchId JWT when there are no errors. The JWT payload binds the
   * batch to the uploading user so commit() can verify actor identity.
   */
  async validate(
    fileBuffer: Buffer | ArrayBuffer,
    user: User,
  ): Promise<ValidateImportResponse> {
    // RBAC guard ensures center_rep/workflow_admin always have a centerId.
    const centerId = user.centerId as number;

    // --- Parse Excel ---
    const rows = await this.parseExcel(fileBuffer);

    if (rows.length === 0) {
      return this.emptyErrorResponse(
        'The uploaded file contains no data rows.',
      );
    }

    // --- Load reference data (projects + programs for this center) ---
    const projectCodeMap = await this.loadProjectsByCenter(centerId);
    const programCodeMap = await this.loadAllPrograms();

    // --- Per-row validation ---
    const errors: ImportRowError[] = [];
    const warnings: ImportRowWarning[] = [];
    const skipped: ImportSkippedProject[] = [];
    const validRows: ParsedImportRow[] = [];

    // Duplicate (projectCode, programCode) detection — must run BEFORE per-row
    // validation so the second occurrence is flagged regardless of whether
    // the row would have otherwise been valid.
    const seenPairs = new Set<string>();
    const duplicateRowNumbers = new Set<number>();
    for (const row of rows) {
      // Only consider rows that actually have both codes; empty rows are
      // caught by the per-row validator with a more specific message.
      if (!row.projectCode || !row.programCode) continue;
      const key = `${row.projectCode.toUpperCase()}|${row.programCode.toUpperCase()}`;
      if (seenPairs.has(key)) {
        // The first occurrence keeps its error-free row number; flag this
        // (the second) one as the duplicate.
        errors.push({
          row: row.rowNumber,
          projectCode: row.projectCode,
          programCode: row.programCode,
          message: `Duplicate mapping — row ${row.rowNumber} already imports ${row.projectCode}/${row.programCode}`,
        });
        duplicateRowNumbers.add(row.rowNumber);
      } else {
        seenPairs.add(key);
      }
    }

    for (const row of rows) {
      // Skip duplicate rows for per-row validation so the file doesn't get
      // cluttered with secondary errors against an already-flagged dup.
      if (duplicateRowNumbers.has(row.rowNumber)) continue;

      // Detail-only row (project with no program slots): validate ONLY that
      // the project exists and belongs to the center, then carry it through
      // for the Description/Summary/PI overlay. No mapping/program checks.
      if (row.detailOnly) {
        const project = projectCodeMap.get(row.projectCode);
        if (!project || project.centerId !== centerId) {
          errors.push({
            row: row.rowNumber,
            projectCode: row.projectCode,
            programCode: '',
            message: `Project ${row.projectCode} not found or does not belong to your center`,
          });
        } else {
          row.projectId = project.id;
          validRows.push(row);
        }
        continue;
      }

      const rowErrors = this.validateRow(
        row,
        projectCodeMap,
        programCodeMap,
        centerId,
      );
      if (rowErrors.length > 0) {
        errors.push(...rowErrors);
      } else {
        // Resolve DB ids now that we know the codes are valid.
        row.projectId = projectCodeMap.get(row.projectCode)!.id;
        row.programId = programCodeMap.get(row.programCode)!.id;
        validRows.push(row);
      }
    }

    // --- Per-project validation (cap + sum) ---
    // Run even if per-row errors exist (we want to surface all problems).
    // Projects that don't total exactly 100% are SKIPPED (excluded from the
    // import) rather than committed — a center mapping must be fully
    // allocated, mirroring the negotiation-start gate. The rest of the
    // batch still proceeds.
    const skippedProjectCodes = new Set<string>();
    const projectGroups = this.groupByProject(validRows);
    for (const [projectCode, projectRows] of projectGroups) {
      // Mapping rows only — a detail-only row carries no allocation and must
      // not count toward the cap or the 100% sum. A project whose file entry
      // is purely detail-only (no program slots) is not a mapping import at
      // all, so the gate does not apply: its overlay flows through untouched.
      const mappingRows = projectRows.filter((r) => !r.detailOnly);
      if (mappingRows.length === 0) continue;

      if (mappingRows.length > MAX_ACTIVE_MAPPINGS) {
        errors.push({
          row: mappingRows[0].rowNumber,
          projectCode,
          programCode: '',
          message: `Project ${projectCode} has ${mappingRows.length} rows in the file; maximum is ${MAX_ACTIVE_MAPPINGS}`,
        });
        continue;
      }

      const sum = mappingRows.reduce(
        (acc, r) => acc + r.allocationPercentage,
        0,
      );
      // Use Math.round to avoid floating-point rounding errors (e.g. 33.33+33.33+33.34).
      const roundedSum = Math.round(sum);

      if (roundedSum !== 100) {
        // Not fully allocated → skip the whole project. Over- and
        // under-allocation are both rejected: the mapping must reach
        // exactly 100% before it can be imported. The project's rows are
        // excluded below so the remaining projects still commit.
        skippedProjectCodes.add(projectCode.toUpperCase());
        skipped.push({
          row: mappingRows[0].rowNumber,
          projectCode,
          message: `Project ${projectCode}: allocations sum to ${sum}% (must equal 100%). This mapping does not reach 100% and was skipped — it will not be imported.`,
        });
      }
      // roundedSum === 100 → import normally.
    }

    // Drop skipped projects' rows so they never reach create/update/remove.
    const committableRows = validRows.filter(
      (r) => !skippedProjectCodes.has(r.projectCode.toUpperCase()),
    );

    // --- If errors: return without batchId (warnings/skips DO NOT block) ---
    if (errors.length > 0) {
      return {
        summary: {
          toCreate: 0,
          toUpdate: 0,
          toRemove: 0,
          unchanged: 0,
          detailsToUpdate: 0,
          errors: errors.length,
          warnings: warnings.length,
          skipped: skipped.length,
        },
        errors,
        warnings,
        skipped,
        preview: {
          toCreate: [],
          toUpdate: [],
          toRemove: [],
          detailsToUpdate: [],
        },
      };
    }

    // --- Classify rows (create vs update) and detect removals ---
    // Skipped projects are excluded — committableRows drives everything
    // below so their existing mappings are also left untouched (never
    // flagged for removal).
    //
    // Detail-only rows are excluded from ALL mapping classification: a
    // project that appears in the file with no program slots must not have
    // its existing mappings flagged for removal. Its detail overlay is still
    // detected (detectDetailUpdates runs over the full committableRows) and
    // applied on commit.
    const mappingRows = committableRows.filter((r) => !r.detailOnly);
    const touchedProjectIds = [
      ...new Set(mappingRows.map((r) => r.projectId!)),
    ];
    const existingMappings = await this.loadActiveMappings(touchedProjectIds);

    const toCreate: PreviewCreate[] = [];
    const toUpdate: PreviewUpdate[] = [];
    const toRemove: PreviewRemove[] = [];
    // Mappings already matching the file — left untouched on commit, so they
    // are counted but excluded from toUpdate (which previously listed every
    // existing mapping, making a plain re-import look like an all-update run).
    let unchanged = 0;

    // Track which (projectId, programId) pairs are in the file.
    const fileSet = new Set(
      mappingRows.map((r) => `${r.projectId}-${r.programId}`),
    );

    for (const row of mappingRows) {
      const key = `${row.projectId}-${row.programId}`;
      const existing = existingMappings.get(key);
      if (!existing) {
        toCreate.push({
          projectCode: row.projectCode,
          programCode: row.programCode,
          allocationPercentage: row.allocationPercentage,
          complementarityRating: row.complementarityRating,
          efficiencyRating: row.efficiencyRating,
          justification: row.justification,
        });
      } else if (this.mappingMatchesRow(existing, row)) {
        // Identical allocation + ratings → commit will skip it.
        unchanged++;
      } else {
        toUpdate.push({
          projectCode: row.projectCode,
          programCode: row.programCode,
          currentAllocation: existing.allocationPercentage,
          newAllocation: row.allocationPercentage,
          complementarityRating: row.complementarityRating,
          efficiencyRating: row.efficiencyRating,
          justification: row.justification,
        });
      }
    }

    // Removal detection: active mappings on touched projects not in file.
    for (const [key, mapping] of existingMappings) {
      if (!fileSet.has(key)) {
        const project = await this.projectRepo.findOne({
          where: { id: mapping.projectId },
        });
        const program = await this.programRepo.findOne({
          where: { id: mapping.programId },
        });
        toRemove.push({
          projectCode: project?.code ?? String(mapping.projectId),
          programCode: program?.officialCode ?? String(mapping.programId),
          currentAllocation: mapping.allocationPercentage,
        });
      }
    }

    // --- Project-detail (summary / description / PI) change detection ---
    // Independent of mappings: a project whose mappings are all unchanged can
    // still have its summary/description/PI overwritten. Mirrors the
    // projectDirty comparison in commit() so the preview matches what commit
    // will actually persist.
    const detailsToUpdate = this.detectDetailUpdates(
      committableRows,
      projectCodeMap,
    );

    // --- Issue batchId JWT and cache the rows ---
    // Only committable (fully-allocated) rows are cached so commit() never
    // imports a skipped project, even though re-validation runs there too.
    const batchId = await this.createBatchSession(committableRows, user);

    this.logger.log(
      `Validate OK for userId=${user.id}: toCreate=${toCreate.length}, toUpdate=${toUpdate.length}, toRemove=${toRemove.length}, unchanged=${unchanged}, detailsToUpdate=${detailsToUpdate.length}, skipped=${skipped.length}`,
    );

    return {
      batchId,
      summary: {
        toCreate: toCreate.length,
        toUpdate: toUpdate.length,
        toRemove: toRemove.length,
        unchanged,
        detailsToUpdate: detailsToUpdate.length,
        errors: 0,
        warnings: warnings.length,
        skipped: skipped.length,
      },
      errors: [],
      warnings,
      skipped,
      preview: { toCreate, toUpdate, toRemove, detailsToUpdate },
    };
  }

  /**
   * Determine, per project, which detail fields (summary / description /
   * principal investigator + email) the file would overwrite. Compares the
   * file's per-project overlay (carried on the first row of each project)
   * against the current project values using the SAME rules as commit():
   * null/undefined means "blank cell → leave alone", any other value that
   * differs from the stored value is a change.
   */
  private detectDetailUpdates(
    committableRows: ParsedImportRow[],
    projectCodeMap: Map<string, Project>,
  ): PreviewDetailUpdate[] {
    const result: PreviewDetailUpdate[] = [];
    for (const [projectCode, projectRows] of this.groupByProject(
      committableRows,
    )) {
      const project = projectCodeMap.get(projectCode);
      if (!project) continue;
      const first = projectRows[0];
      const fields: string[] = [];
      if (
        first.projectDescription != null &&
        first.projectDescription !== project.description
      ) {
        fields.push('Description');
      }
      if (
        first.projectSummary != null &&
        first.projectSummary !== project.summary
      ) {
        fields.push('Summary');
      }
      if (
        first.projectPrincipalInvestigator != null &&
        first.projectPrincipalInvestigator !== project.principalInvestigator
      ) {
        fields.push('Principal Investigator');
      }
      if (
        first.projectPrincipalInvestigatorEmail != null &&
        first.projectPrincipalInvestigatorEmail !== project.email
      ) {
        fields.push('PI Email');
      }
      if (fields.length > 0) {
        result.push({ projectCode, fields });
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // COMMIT
  // ---------------------------------------------------------------------------

  /**
   * Execute the import for a previously validated batch.
   *
   * Verifies the batchId JWT, re-validates for defense in depth, then
   * executes the full import inside a single database transaction.
   *
   * All negotiation events are attributed to the uploading user — never
   * a synthetic system user.
   */
  async commit(batchId: string, user: User): Promise<CommitResult> {
    // RBAC guard ensures center_rep/workflow_admin always have centerId and role.
    const centerId = user.centerId as number;
    const userRole = user.role as UserRole;

    // --- Verify JWT ---
    let payload: BatchJwtPayload;
    try {
      payload = this.jwtService.verify<BatchJwtPayload>(batchId, {
        secret: this.configService.get<string>('auth.jwtSecret'),
      });
    } catch {
      throw new BadRequestException(
        'Batch session expired or invalid. Please re-upload.',
      );
    }

    // --- Actor binding check ---
    if (payload.actorId !== user.id) {
      throw new ForbiddenException(
        'Batch token does not belong to the current user.',
      );
    }

    // --- Retrieve cached rows ---
    const session = this.sessions.get(batchId);
    if (!session) {
      throw new BadRequestException(
        'Batch not found; please re-upload and validate again.',
      );
    }

    const rows = session.rows;

    // --- Defense in depth: re-run validation ---
    const projectCodeMap = await this.loadProjectsByCenter(centerId);
    const programCodeMap = await this.loadAllPrograms();
    const revalidationErrors: ImportRowError[] = [];

    for (const row of rows) {
      // Detail-only rows carry no program/allocation — validateRow would
      // wrongly reject them. They were validated for project ownership at
      // validate() time and only carry the overlay forward.
      if (row.detailOnly) continue;
      const errs = this.validateRow(
        row,
        projectCodeMap,
        programCodeMap,
        centerId,
      );
      revalidationErrors.push(...errs);
    }
    if (revalidationErrors.length > 0) {
      this.evictSession(batchId);
      throw new BadRequestException({
        message: 'Re-validation failed. Please re-upload.',
        errors: revalidationErrors,
      });
    }

    // --- Execute import ---
    const actorRole = this.resolveActorRole(userRole);
    const projectGroups = this.groupByProject(rows);
    let imported = 0;
    let removed = 0;
    const projectIds = [...new Set(rows.map((r) => r.projectId!))];

    await this.dataSource.transaction(async (manager) => {
      for (const [projectCode, projectRows] of projectGroups) {
        const projectId = projectRows[0].projectId!;

        // Pessimistic lock on the project row to prevent concurrent modifications.
        const project = await manager
          .createQueryBuilder(Project, 'project')
          .setLock('pessimistic_write')
          .where('project.id = :id', { id: projectId })
          .getOne();

        if (!project) {
          this.logger.warn(
            `Project not found during commit: code=${projectCode}`,
          );
          continue;
        }

        /* Apply per-project Description / Summary overlays from the file
         * (projects-export shape only — legacy Mappings sheet leaves both
         * undefined). All rows for the same project carry identical values,
         * so pick from the first row. Null = blank cell, leave existing
         * value alone. Save happens inline alongside the lock flow below
         * when the project gets persisted; otherwise the project is saved
         * here to commit the overlay. */
        const firstRow = projectRows[0];
        let projectDirty = false;
        if (
          firstRow.projectDescription !== null &&
          firstRow.projectDescription !== undefined &&
          firstRow.projectDescription !== project.description
        ) {
          project.description = firstRow.projectDescription;
          projectDirty = true;
        }
        if (
          firstRow.projectSummary !== null &&
          firstRow.projectSummary !== undefined &&
          firstRow.projectSummary !== project.summary
        ) {
          project.summary = firstRow.projectSummary;
          projectDirty = true;
        }
        if (
          firstRow.projectPrincipalInvestigator !== null &&
          firstRow.projectPrincipalInvestigator !== undefined &&
          firstRow.projectPrincipalInvestigator !==
            project.principalInvestigator
        ) {
          project.principalInvestigator = firstRow.projectPrincipalInvestigator;
          projectDirty = true;
        }
        if (
          firstRow.projectPrincipalInvestigatorEmail !== null &&
          firstRow.projectPrincipalInvestigatorEmail !== undefined &&
          firstRow.projectPrincipalInvestigatorEmail !== project.email
        ) {
          project.email = firstRow.projectPrincipalInvestigatorEmail;
          projectDirty = true;
        }

        /* Detail-only project (file carried Description/Summary/PI edits but
         * no program slots): persist the overlay and leave the mappings and
         * lock state completely alone. Mirrors the no-mapping-change branch
         * below; guards against the mapping-diff logic misreading the absent
         * slots as "remove everything". */
        const isDetailOnly = projectRows.every((r) => r.detailOnly);
        if (isDetailOnly) {
          if (projectDirty) {
            await manager.save(Project, project);
            this.logger.log(
              `Applied detail-only overlay for ${projectCode} (id=${projectId}); mappings untouched`,
            );
          }
          continue;
        }

        // Load current active mappings for this project.
        const activeMappings = await manager.find(ProjectMapping, {
          where: { projectId, status: Not(MappingStatus.REMOVED) },
          relations: ['program'],
        });

        /* Decide whether the file actually changes this project's mappings.
         * A change is any create (program not currently active), any update
         * (active mapping whose allocation/ratings differ from the file), or
         * any removal (active mapping absent from the file). When NOTHING
         * changes mapping-wise, we apply only the project overlay
         * (summary/description/PI) and leave the negotiation surface — lock
         * state, statuses, agreement flags, event log — completely alone.
         * This makes re-importing an export (e.g. a summary-only edit) safe:
         * it no longer reopens locked rounds or resets agreed mappings. */
        const fileProgramIdSet = new Set(projectRows.map((r) => r.programId!));
        const activeByProgramPre = new Map<number, ProjectMapping>(
          activeMappings.map((m) => [m.programId, m]),
        );
        let mappingChange = false;
        for (const row of projectRows) {
          const cur = activeByProgramPre.get(row.programId!);
          if (!cur || !this.mappingMatchesRow(cur, row)) {
            mappingChange = true;
            break;
          }
        }
        if (!mappingChange) {
          for (const m of activeMappings) {
            if (!fileProgramIdSet.has(m.programId)) {
              mappingChange = true;
              break;
            }
          }
        }

        if (!mappingChange) {
          // Summary/description/PI overlay only — never touch the mappings
          // or the lock state of a project whose allocations are unchanged.
          if (projectDirty) {
            await manager.save(Project, project);
          }
          this.logger.log(
            `No mapping changes for ${projectCode} (id=${projectId}); applied project overlay only`,
          );
          continue;
        }

        /* Mappings present in the file but unchanged are skipped below so
         * their negotiation state survives. Track which mappings this import
         * actually created/revived/updated so the promote step only launches
         * those (and not pre-existing untouched drafts). */
        const touchedMappingIds = new Set<number>();
        let didReopen = false;

        // If project is locked: inline reopen logic.
        if (project.negotiationLocked) {
          didReopen = true;
          project.negotiationLocked = false;
          await manager.save(Project, project);

          for (const m of activeMappings) {
            m.status = MappingStatus.DRAFT;
            m.centerAgreed = false;
            m.programAgreed = false;
            await manager.save(ProjectMapping, m);

            const reopenEvent = manager.create(MappingNegotiation, {
              mappingId: m.id,
              actorId: user.id,
              actorRole,
              eventType: NegotiationEventType.REOPENED,
              proposedAllocation: m.allocationPercentage,
              justification: 'Bulk import — round reopened',
            });
            await manager.save(MappingNegotiation, reopenEvent);
          }

          this.logger.log(
            `Reopened locked project ${projectCode} (id=${projectId}) for bulk import`,
          );
          /* Lock branch saved the project above, which also persisted any
           * description/summary overlay. Clear the dirty flag so we don't
           * save a second time below. */
          projectDirty = false;
        }

        /* Persist the description/summary overlay when the lock branch
         * didn't already save (i.e. project wasn't locked). */
        if (projectDirty) {
          await manager.save(Project, project);
        }

        // Refresh active mappings after potential reopen (status may have changed).
        const currentMappings = await manager.find(ProjectMapping, {
          where: { projectId, status: Not(MappingStatus.REMOVED) },
          relations: ['program'],
        });

        // Build lookup by programId.
        const currentByProgram = new Map<number, ProjectMapping>(
          currentMappings.map((m) => [m.programId, m]),
        );

        /* Removed mappings on this project, keyed by programId. The unique
         * constraint UQ_project_mappings_project_program spans ALL statuses
         * (including removed), so a brand-new INSERT for a program that was
         * previously removed collides with the leftover row. We reuse that
         * removed row instead — mirroring MappingsService.create(). */
        const removedMappings = await manager.find(ProjectMapping, {
          where: { projectId, status: MappingStatus.REMOVED },
        });
        const removedByProgram = new Map<number, ProjectMapping>(
          removedMappings.map((m) => [m.programId, m]),
        );

        // Set of programIds present in the file for this project.
        const fileProgramIds = new Set(projectRows.map((r) => r.programId!));

        // --- Create or update ---
        for (const row of projectRows) {
          const existing = currentByProgram.get(row.programId!);

          if (!existing) {
            // No active mapping. Reuse a removed row for this program if one
            // exists (the unique constraint forbids a second row), otherwise
            // create a fresh draft mapping.
            const revived = removedByProgram.get(row.programId!);
            if (revived) {
              revived.allocationPercentage = row.allocationPercentage;
              revived.complementarityRating =
                row.complementarityRating as Rating;
              revived.efficiencyRating = row.efficiencyRating as Rating;
              revived.status = MappingStatus.DRAFT;
              // The import IS the center's agreed position — mark the center
              // side agreed so the round reads as awaiting the program, not
              // the center. Program must still agree (programAgreed stays 0).
              revived.centerAgreed = true;
              revived.programAgreed = false;
              revived.initiatedById = user.id;
              const saved = await manager.save(ProjectMapping, revived);

              const initiatedEvent = manager.create(MappingNegotiation, {
                mappingId: saved.id,
                actorId: user.id,
                actorRole,
                eventType: NegotiationEventType.INITIATED,
                proposedAllocation: row.allocationPercentage,
                justification: row.justification,
              });
              await manager.save(MappingNegotiation, initiatedEvent);
              touchedMappingIds.add(saved.id);
              imported++;
              continue;
            }

            // Create new draft mapping.
            const newMapping = manager.create(ProjectMapping, {
              projectId,
              programId: row.programId,
              allocationPercentage: row.allocationPercentage,
              complementarityRating: row.complementarityRating as Rating,
              efficiencyRating: row.efficiencyRating as Rating,
              status: MappingStatus.DRAFT,
              // Import is the center's agreed position — see revive branch.
              centerAgreed: true,
              programAgreed: false,
              initiatedById: user.id,
            });
            const saved = await manager.save(ProjectMapping, newMapping);

            const initiatedEvent = manager.create(MappingNegotiation, {
              mappingId: saved.id,
              actorId: user.id,
              actorRole,
              eventType: NegotiationEventType.INITIATED,
              proposedAllocation: row.allocationPercentage,
              justification: row.justification,
            });
            await manager.save(MappingNegotiation, initiatedEvent);
            touchedMappingIds.add(saved.id);
            imported++;
          } else {
            // Unchanged mapping — leave its allocation, ratings, status and
            // agreement flags exactly as they are. Re-importing an export
            // must not reset an already-agreed or in-progress mapping.
            // Only when we did NOT reopen: a reopen already reset the whole
            // round, so there is no surviving state to preserve and every
            // mapping must be re-asserted (and re-promoted) below.
            if (!didReopen && this.mappingMatchesRow(existing, row)) {
              continue;
            }

            // Update existing mapping's allocation and ratings.
            existing.allocationPercentage = row.allocationPercentage;
            existing.complementarityRating =
              row.complementarityRating as Rating;
            existing.efficiencyRating = row.efficiencyRating as Rating;
            // Import is the center's agreed position — see create branch.
            // A counter-proposal resets the program side; the center side
            // is asserted as agreed by the act of importing.
            existing.centerAgreed = true;
            existing.programAgreed = false;
            await manager.save(ProjectMapping, existing);

            const counterEvent = manager.create(MappingNegotiation, {
              mappingId: existing.id,
              actorId: user.id,
              actorRole,
              eventType: NegotiationEventType.COUNTER_PROPOSED,
              proposedAllocation: row.allocationPercentage,
              justification: row.justification,
            });
            await manager.save(MappingNegotiation, counterEvent);
            touchedMappingIds.add(existing.id);
            imported++;
          }
        }

        // --- Remove mappings not in the file ---
        for (const [programId, mapping] of currentByProgram) {
          if (!fileProgramIds.has(programId)) {
            mapping.status = MappingStatus.REMOVED;
            await manager.save(ProjectMapping, mapping);

            const removedEvent = manager.create(MappingNegotiation, {
              mappingId: mapping.id,
              actorId: user.id,
              actorRole,
              eventType: NegotiationEventType.REMOVED,
              proposedAllocation: mapping.allocationPercentage,
              justification:
                'Removed via bulk import — not present in uploaded file',
            });
            await manager.save(MappingNegotiation, removedEvent);
            removed++;
          }
        }

        // --- Bulk-promote DRAFT mappings to NEGOTIATING ---
        // After a reopen the whole round was reset to draft, so every draft
        // re-launches. Otherwise promote only mappings this import touched
        // (created/revived/updated) — a pre-existing untouched draft stays
        // private to the center.
        const draftMappings = await manager.find(ProjectMapping, {
          where: { projectId, status: MappingStatus.DRAFT },
        });

        for (const draft of draftMappings) {
          if (!didReopen && !touchedMappingIds.has(draft.id)) {
            continue;
          }
          draft.status = MappingStatus.NEGOTIATING;
          await manager.save(ProjectMapping, draft);

          const startedEvent = manager.create(MappingNegotiation, {
            mappingId: draft.id,
            actorId: user.id,
            actorRole,
            eventType: NegotiationEventType.NEGOTIATION_STARTED,
            proposedAllocation: draft.allocationPercentage,
            justification: null,
          });
          await manager.save(MappingNegotiation, startedEvent);
        }
      }
    });

    // Evict the batch session after successful commit.
    this.evictSession(batchId);

    this.logger.log(
      `Commit complete for userId=${user.id}: imported=${imported}, removed=${removed}, projects=${projectGroups.size}`,
    );

    return {
      imported,
      removed,
      projectsAffected: projectGroups.size,
    };
  }

  // ---------------------------------------------------------------------------
  // PRIVATE HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Parse the Excel file buffer.
   *
   * Two supported shapes (auto-detected):
   *   1. "Mappings" sheet — legacy template format, one row per mapping.
   *   2. "Projects" sheet — the standard list export. One row per project
   *      with up to three Program slots; each non-empty slot is emitted as
   *      its own ParsedImportRow.
   */
  private async parseExcel(
    fileBuffer: Buffer | ArrayBuffer,
  ): Promise<ParsedImportRow[]> {
    const workbook = new ExcelJS.Workbook();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await workbook.xlsx.load(fileBuffer as any);
    } catch {
      throw new BadRequestException('Please upload a valid .xlsx file.');
    }

    const mappingsSheet = workbook.getWorksheet('Mappings');
    if (mappingsSheet) {
      return this.parseMappingsSheet(mappingsSheet);
    }

    const projectsSheet = workbook.getWorksheet('Projects');
    if (projectsSheet) {
      return this.parseProjectsSheet(projectsSheet);
    }

    throw new BadRequestException(
      "Uploaded file must contain either a 'Projects' sheet (from the projects export) or a 'Mappings' sheet.",
    );
  }

  /**
   * Parse the legacy template's "Mappings" sheet — one row per mapping with
   * a fixed 7-column layout. Column 2 (Project Name) is ignored on upload.
   */
  private parseMappingsSheet(sheet: ExcelJS.Worksheet): ParsedImportRow[] {
    const rows: ParsedImportRow[] = [];

    sheet.eachRow((row, rowNumber) => {
      // Skip header row.
      if (rowNumber === 1) return;

      const projectCode = readCellString(row, 1);
      // Column 2 is Project Name — display-only context for the rep, ignored on upload.
      const programCode = readCellString(row, 3);
      const allocationRaw = readAllocationString(row, 4);
      const complementarityRating = normalizeRating(readCellString(row, 5));
      const efficiencyRating = normalizeRating(readCellString(row, 6));
      const justification = readCellString(row, 7);

      // Skip completely blank rows.
      if (!projectCode && !programCode && !allocationRaw) return;

      const allocationPercentage = parseFloat(allocationRaw);

      rows.push({
        rowNumber,
        projectCode,
        programCode,
        allocationPercentage: isNaN(allocationPercentage)
          ? NaN
          : allocationPercentage,
        complementarityRating,
        efficiencyRating,
        justification,
      });
    });

    return rows;
  }

  /**
   * Confirms a worksheet really is the projects list export *before* we
   * read it by fixed column index — WITHOUT trusting the header titles.
   *
   * The export's column titles have been reworded across versions (word-
   * limit hints added to Description/Summary, etc.), so a file exported by
   * an older build carries different titles yet is still perfectly valid.
   * Matching on title text rejected those files. We validate the DATA shape
   * instead: the sheet must be wide enough for the export layout, and its
   * data rows must carry the export's signature — a project Code in column
   * 2, and a numeric allocation in column 19 wherever a Program 1 code
   * (column 18) is present. A foreign file that merely reuses the sheet
   * name "Projects" will not satisfy this. The columns themselves are read
   * positionally downstream, so titles never matter for parsing.
   *
   * Throws the same friendly BadRequestException on any mismatch.
   */
  private assertProjectsExportShape(sheet: ExcelJS.Worksheet): void {
    const reject = (): never => {
      throw new BadRequestException(
        "The uploaded 'Projects' sheet does not match the export format. Re-export the projects list and try again.",
      );
    };

    // Wide enough for the three 5-column program slots (Program 3 ends at
    // column 32). The real export has far more; a narrow foreign sheet does
    // not. Derived from the header row's defined-cell count.
    if (sheet.getRow(1).cellCount < 32) reject();

    let dataRows = 0;
    let codedRows = 0;
    let program1Codes = 0;
    let program1Numeric = 0;

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // header row
      const code = readCellString(row, 2);
      const program1 = readCellString(row, 18);
      const alloc1 = readAllocationString(row, 19);
      // Wholly blank spacer row — ignore.
      if (!code && !program1 && !alloc1) return;
      dataRows += 1;
      if (code) codedRows += 1;
      if (program1) {
        program1Codes += 1;
        if (!Number.isNaN(parseFloat(alloc1))) program1Numeric += 1;
      }
    });

    // Must have data; every projects-export data row carries a Code; and
    // any Program 1 codes present must pair with a numeric allocation
    // (Excel percentage cells are normalised by readAllocationString).
    if (dataRows === 0 || codedRows === 0) reject();
    if (program1Codes > 0 && program1Numeric === 0) reject();
  }

  /**
   * Parse the list export's "Projects" sheet — one row per project with up
   * to three program slots (5 columns each). Emits one ParsedImportRow
   * per non-empty slot so the rest of the pipeline can treat both shapes
   * identically. Justification is read from the per-slot column when
   * present; blanks are normalized downstream by validateRow().
   *
   * Verifies — by DATA shape, not header titles — that this really is the
   * projects export, so we don't silently misread a file from some other
   * tool that reuses the sheet name. Header titles are deliberately NOT
   * checked: they have been reworded across export versions, so a file
   * exported by an older build carries different titles yet is still valid.
   * See assertProjectsExportShape().
   */
  private parseProjectsSheet(sheet: ExcelJS.Worksheet): ParsedImportRow[] {
    // Guard that this is the projects export by DATA shape — NOT header
    // titles, which differ between export versions. Every column below is
    // then read by fixed index, so the titles never matter for parsing.
    this.assertProjectsExportShape(sheet);

    const headerRow = sheet.getRow(1);

    /* Appended PI columns (45 = name, 46 = email) are OPTIONAL: exports
     * generated before they existed have an empty header here and simply
     * carry no PI overlay. They are read by fixed index below; this column
     * detection only decides whether to harvest those overlays at all so a
     * column shift can't silently misread the wrong cell. */
    const piNameHeader = readCellString(headerRow, 45);
    const piEmailHeader = readCellString(headerRow, 46);
    const hasPiNameColumn =
      piNameHeader.toLowerCase() === 'principal investigator name';
    const hasPiEmailColumn =
      piEmailHeader.toLowerCase() === 'principal investigator email';

    const rows: ParsedImportRow[] = [];

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;

      const projectCode = readCellString(row, 2);
      if (!projectCode) return;

      /* Project-level overlays read once per Excel row and copied onto
       * every emitted slot row so commit() can apply them after grouping.
       * Blank cell → null = "leave the current project value alone". */
      const descriptionRaw = readCellString(row, 41);
      const summaryRaw = readCellString(row, 42);
      const projectDescription =
        descriptionRaw.trim() === '' ? null : descriptionRaw;
      const projectSummary = summaryRaw.trim() === '' ? null : summaryRaw;

      /* PI overlays only when the file actually has those columns; blank
       * cell → null = leave the existing project value alone. */
      const piNameRaw = hasPiNameColumn ? readCellString(row, 45) : '';
      const piEmailRaw = hasPiEmailColumn ? readCellString(row, 46) : '';
      const projectPrincipalInvestigator =
        piNameRaw.trim() === '' ? null : piNameRaw;
      const projectPrincipalInvestigatorEmail =
        piEmailRaw.trim() === '' ? null : piEmailRaw;

      /* Three slot quintuples — (programCol, pctCol, compCol, effCol, justCol).
       * Slots are 5 cols wide post justification-column addition. */
      const slots: Array<[number, number, number, number, number]> = [
        [18, 19, 20, 21, 22],
        [23, 24, 25, 26, 27],
        [28, 29, 30, 31, 32],
      ];

      let slotEmitted = false;
      for (const [progCol, pctCol, compCol, effCol, justCol] of slots) {
        const programCode = readCellString(row, progCol);
        const allocationRaw = readAllocationString(row, pctCol);
        const complementarityRating = normalizeRating(
          readCellString(row, compCol),
        );
        const efficiencyRating = normalizeRating(readCellString(row, effCol));
        const justification = readCellString(row, justCol);

        // Empty slot — skip silently. A slot with no program code is not a
        // mapping regardless of its Allc % cell: unused export slots ship a
        // literal "0" (not a blank) in that cell, and "0" is truthy, so the
        // old `!programCode && !allocationRaw` guard let those through and
        // emitted a phantom mapping row that failed every field validation.
        if (!programCode) continue;

        const allocationPercentage = parseFloat(allocationRaw);

        rows.push({
          rowNumber,
          projectCode,
          programCode,
          allocationPercentage: isNaN(allocationPercentage)
            ? NaN
            : allocationPercentage,
          complementarityRating,
          efficiencyRating,
          justification,
          projectDescription,
          projectSummary,
          projectPrincipalInvestigator,
          projectPrincipalInvestigatorEmail,
        });
        slotEmitted = true;
      }

      /* Project with NO program slots but with edited Description / Summary /
       * PI cells: emit a single detail-only row so the overlay still reaches
       * commit. Without this the project would produce zero rows and its
       * detail edits would be silently dropped (it would be invisible to the
       * whole import). detailOnly excludes it from every mapping concern. */
      if (
        !slotEmitted &&
        (projectDescription !== null ||
          projectSummary !== null ||
          projectPrincipalInvestigator !== null ||
          projectPrincipalInvestigatorEmail !== null)
      ) {
        rows.push({
          rowNumber,
          projectCode,
          programCode: '',
          allocationPercentage: NaN,
          complementarityRating: '',
          efficiencyRating: '',
          justification: null,
          projectDescription,
          projectSummary,
          projectPrincipalInvestigator,
          projectPrincipalInvestigatorEmail,
          detailOnly: true,
        });
      }
    });

    return rows;
  }

  /**
   * Load all non-archived projects for a given center, keyed by project code.
   */
  private async loadProjectsByCenter(
    centerId: number,
  ): Promise<Map<string, Project>> {
    const projects = await this.projectRepo.find({
      where: { centerId, status: Not(ProjectStatus.ARCHIVED) },
    });
    return new Map(projects.map((p) => [p.code, p]));
  }

  /** Load all programs, keyed by official code. */
  private async loadAllPrograms(): Promise<Map<string, Program>> {
    const programs = await this.programRepo.find();
    return new Map(programs.map((p) => [p.officialCode, p]));
  }

  /**
   * Load all active (non-removed) mappings for the given project ids,
   * keyed by "projectId-programId".
   */
  private async loadActiveMappings(
    projectIds: number[],
  ): Promise<Map<string, ProjectMapping>> {
    if (projectIds.length === 0) return new Map();
    const mappings = await this.mappingRepo.find({
      where: { projectId: In(projectIds), status: Not(MappingStatus.REMOVED) },
    });
    return new Map(mappings.map((m) => [`${m.projectId}-${m.programId}`, m]));
  }

  /**
   * Validate a single parsed row.
   * Returns zero or more error objects.
   */
  private validateRow(
    row: ParsedImportRow,
    projectMap: Map<string, Project>,
    programMap: Map<string, Program>,
    centerId: number,
  ): ImportRowError[] {
    const errors: ImportRowError[] = [];

    if (!row.projectCode) {
      errors.push({
        row: row.rowNumber,
        projectCode: '',
        programCode: row.programCode,
        message: 'Project Code is required',
      });
    } else {
      const project = projectMap.get(row.projectCode);
      if (!project) {
        errors.push({
          row: row.rowNumber,
          projectCode: row.projectCode,
          programCode: row.programCode,
          message: `Project ${row.projectCode} not found or does not belong to your center`,
        });
      } else if (project.centerId !== centerId) {
        errors.push({
          row: row.rowNumber,
          projectCode: row.projectCode,
          programCode: row.programCode,
          message: `Project ${row.projectCode} does not belong to your center`,
        });
      }
    }

    if (!row.programCode) {
      errors.push({
        row: row.rowNumber,
        projectCode: row.projectCode,
        programCode: '',
        message: 'Program Code is required',
      });
    } else if (!programMap.has(row.programCode)) {
      errors.push({
        row: row.rowNumber,
        projectCode: row.projectCode,
        programCode: row.programCode,
        message: `Program ${row.programCode} not found`,
      });
    }

    if (
      isNaN(row.allocationPercentage) ||
      row.allocationPercentage < 1 ||
      row.allocationPercentage > 100
    ) {
      errors.push({
        row: row.rowNumber,
        projectCode: row.projectCode,
        programCode: row.programCode,
        message: `Allocation % must be a number between 1 and 100 (got: ${row.allocationPercentage})`,
      });
    }

    if (!VALID_RATINGS.has(row.complementarityRating)) {
      errors.push({
        row: row.rowNumber,
        projectCode: row.projectCode,
        programCode: row.programCode,
        message: `Complementarity Rating must be high, medium, or low (got: ${row.complementarityRating})`,
      });
    }

    if (!VALID_RATINGS.has(row.efficiencyRating)) {
      errors.push({
        row: row.rowNumber,
        projectCode: row.projectCode,
        programCode: row.programCode,
        message: `Efficiency Rating must be high, medium, or low (got: ${row.efficiencyRating})`,
      });
    }

    // Justification is optional. Blank → null (persisted as NULL on the
    // negotiation event). If the user typed something, it must be a real
    // justification (≥10 chars), not a stub.
    if (!row.justification || row.justification.trim().length === 0) {
      row.justification = null;
    } else if (row.justification.trim().length < 10) {
      errors.push({
        row: row.rowNumber,
        projectCode: row.projectCode,
        programCode: row.programCode,
        message: `Justification must be at least 10 characters (or leave blank).`,
      });
    }

    /* Project Summary: blank OR ≤150 words. Description has no length cap.
     * Word count uses whitespace-separated tokens (RegExp /\s+/ split).
     * Only validate non-null values — null means "no change to project". */
    if (row.projectSummary !== null && row.projectSummary !== undefined) {
      const wordCount = row.projectSummary
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 0).length;
      if (wordCount > 150) {
        errors.push({
          row: row.rowNumber,
          projectCode: row.projectCode,
          programCode: row.programCode,
          message: `Summary must be 150 words or fewer (got ${wordCount}). Leave the cell blank to keep the existing summary.`,
        });
      }
    }

    return errors;
  }

  /**
   * True when an existing mapping already matches the file row's allocation
   * and both ratings — i.e. the import would be a no-op for this mapping.
   * `allocationPercentage` comes back from the DB as a decimal string, so we
   * compare numerically with a small tolerance; ratings compare as lowercase
   * strings (null treated as empty). Used so a plain re-import of an export
   * (e.g. a summary-only edit) leaves unchanged mappings — and their
   * negotiation state — completely untouched.
   */
  private mappingMatchesRow(
    mapping: ProjectMapping,
    row: ParsedImportRow,
  ): boolean {
    const sameAllocation =
      Math.abs(
        Number(mapping.allocationPercentage) - row.allocationPercentage,
      ) < 0.005;
    const sameComplementarity =
      (mapping.complementarityRating ?? '') ===
      (row.complementarityRating ?? '');
    const sameEfficiency =
      (mapping.efficiencyRating ?? '') === (row.efficiencyRating ?? '');
    return sameAllocation && sameComplementarity && sameEfficiency;
  }

  /** Group parsed rows by project code. */
  private groupByProject(
    rows: ParsedImportRow[],
  ): Map<string, ParsedImportRow[]> {
    const map = new Map<string, ParsedImportRow[]>();
    for (const row of rows) {
      const list = map.get(row.projectCode) ?? [];
      list.push(row);
      map.set(row.projectCode, list);
    }
    return map;
  }

  /**
   * Sign a batchId JWT and store the parsed rows in the in-memory session cache.
   * The cache entry is auto-evicted after EVICTION_TTL_MS.
   */
  private async createBatchSession(
    rows: ParsedImportRow[],
    user: User,
  ): Promise<string> {
    const batchHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(rows))
      .digest('hex');

    const payload: BatchJwtPayload = {
      actorId: user.id,
      centerId: user.centerId as number,
      batchHash,
    };

    const batchId = this.jwtService.sign(payload, {
      secret: this.configService.get<string>('auth.jwtSecret'),
      expiresIn: '30m',
    });

    const timer = setTimeout(() => {
      this.sessions.delete(batchId);
      this.logger.debug(
        `Batch session expired and evicted for userId=${user.id}`,
      );
    }, EVICTION_TTL_MS);

    this.sessions.set(batchId, {
      rows,
      actorId: user.id,
      centerId: user.centerId as number,
      expiresAt: Date.now() + SESSION_TTL_MS,
      evictionTimer: timer,
    });

    return batchId;
  }

  /** Remove a session from the cache and clear its eviction timer. */
  private evictSession(batchId: string): void {
    const session = this.sessions.get(batchId);
    if (session) {
      clearTimeout(session.evictionTimer);
      this.sessions.delete(batchId);
    }
  }

  /**
   * Map a UserRole to the corresponding ActorRole for negotiation event rows.
   * The DB actor_role enum is constrained to: center_rep, program_rep, admin, workflow_admin.
   */
  private resolveActorRole(userRole: UserRole): ActorRole {
    switch (userRole) {
      case UserRole.CENTER_REP:
        return ActorRole.CENTER_REP;
      case UserRole.WORKFLOW_ADMIN:
        return ActorRole.WORKFLOW_ADMIN;
      default:
        throw new BadRequestException(
          `Role ${userRole} is not permitted to perform bulk imports`,
        );
    }
  }

  /** Build a minimal error response for early-exit cases. */
  private emptyErrorResponse(message: string): ValidateImportResponse {
    return {
      summary: {
        toCreate: 0,
        toUpdate: 0,
        toRemove: 0,
        unchanged: 0,
        detailsToUpdate: 0,
        errors: 1,
        warnings: 0,
        skipped: 0,
      },
      errors: [{ row: 0, projectCode: '', programCode: '', message }],
      warnings: [],
      skipped: [],
      preview: {
        toCreate: [],
        toUpdate: [],
        toRemove: [],
        detailsToUpdate: [],
      },
    };
  }
}
