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
  ValidateImportResponse,
  PreviewCreate,
  PreviewUpdate,
  PreviewRemove,
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
  if (typeof val === 'object' && 'richText' in val) {
    return (val as ExcelJS.CellRichTextValue).richText
      .map((r) => r.text)
      .join('')
      .trim();
  }
  return String(val).trim();
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
    const projectGroups = this.groupByProject(validRows);
    for (const [projectCode, projectRows] of projectGroups) {
      if (projectRows.length > MAX_ACTIVE_MAPPINGS) {
        errors.push({
          row: projectRows[0].rowNumber,
          projectCode,
          programCode: '',
          message: `Project ${projectCode} has ${projectRows.length} rows in the file; maximum is ${MAX_ACTIVE_MAPPINGS}`,
        });
        continue;
      }

      const sum = projectRows.reduce(
        (acc, r) => acc + r.allocationPercentage,
        0,
      );
      // Use Math.round to avoid floating-point rounding errors (e.g. 33.33+33.33+33.34).
      const roundedSum = Math.round(sum);

      if (roundedSum > 100) {
        // Over-allocation is a hard error — blocks the batch.
        errors.push({
          row: projectRows[0].rowNumber,
          projectCode,
          programCode: '',
          message: `Project ${projectCode}: allocations sum to ${sum}%, must not exceed 100%`,
        });
      } else if (roundedSum < 100) {
        // Under-allocation is a non-blocking warning — batch may still commit.
        // The remaining percentage is left unallocated.
        const remaining = 100 - sum;
        warnings.push({
          row: projectRows[0].rowNumber,
          projectCode,
          programCode: '',
          message: `Project ${projectCode} allocation sums to ${sum}% (under 100%). The remaining ${remaining}% will be unallocated.`,
        });
      }
      // roundedSum === 100 → no warning, no error.
    }

    // --- If errors: return without batchId (warnings DO NOT block commit) ---
    if (errors.length > 0) {
      return {
        summary: {
          toCreate: 0,
          toUpdate: 0,
          toRemove: 0,
          errors: errors.length,
          warnings: warnings.length,
        },
        errors,
        warnings,
        preview: { toCreate: [], toUpdate: [], toRemove: [] },
      };
    }

    // --- Classify rows (create vs update) and detect removals ---
    const touchedProjectIds = [...new Set(validRows.map((r) => r.projectId!))];
    const existingMappings = await this.loadActiveMappings(touchedProjectIds);

    const toCreate: PreviewCreate[] = [];
    const toUpdate: PreviewUpdate[] = [];
    const toRemove: PreviewRemove[] = [];

    // Track which (projectId, programId) pairs are in the file.
    const fileSet = new Set(
      validRows.map((r) => `${r.projectId}-${r.programId}`),
    );

    for (const row of validRows) {
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

    // --- Issue batchId JWT and cache the rows ---
    const batchId = await this.createBatchSession(validRows, user);

    this.logger.log(
      `Validate OK for userId=${user.id}: toCreate=${toCreate.length}, toUpdate=${toUpdate.length}, toRemove=${toRemove.length}`,
    );

    return {
      batchId,
      summary: {
        toCreate: toCreate.length,
        toUpdate: toUpdate.length,
        toRemove: toRemove.length,
        errors: 0,
        warnings: warnings.length,
      },
      errors: [],
      warnings,
      preview: { toCreate, toUpdate, toRemove },
    };
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

        // Load current active mappings for this project.
        const activeMappings = await manager.find(ProjectMapping, {
          where: { projectId, status: Not(MappingStatus.REMOVED) },
          relations: ['program'],
        });

        // If project is locked: inline reopen logic.
        if (project.negotiationLocked) {
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

        // Set of programIds present in the file for this project.
        const fileProgramIds = new Set(projectRows.map((r) => r.programId!));

        // --- Create or update ---
        for (const row of projectRows) {
          const existing = currentByProgram.get(row.programId!);

          if (!existing) {
            // Create new draft mapping.
            const newMapping = manager.create(ProjectMapping, {
              projectId,
              programId: row.programId,
              allocationPercentage: row.allocationPercentage,
              complementarityRating: row.complementarityRating as Rating,
              efficiencyRating: row.efficiencyRating as Rating,
              status: MappingStatus.DRAFT,
              centerAgreed: false,
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
            imported++;
          } else {
            // Update existing mapping's allocation and ratings.
            existing.allocationPercentage = row.allocationPercentage;
            existing.complementarityRating =
              row.complementarityRating as Rating;
            existing.efficiencyRating = row.efficiencyRating as Rating;
            existing.centerAgreed = false;
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
        const draftMappings = await manager.find(ProjectMapping, {
          where: { projectId, status: MappingStatus.DRAFT },
        });

        for (const draft of draftMappings) {
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
      const allocationRaw = readCellString(row, 4);
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
   * Parse the list export's "Projects" sheet — one row per project with up
   * to three program slots (5 columns each). Emits one ParsedImportRow
   * per non-empty slot so the rest of the pipeline can treat both shapes
   * identically. Justification is read from the per-slot column when
   * present; blanks are normalized downstream by validateRow().
   *
   * Verifies the header row matches the export schema so we don't silently
   * misread a file from some other tool that happens to use the same sheet
   * name. The check is keyed on a handful of well-known headers — exact
   * column count isn't pinned in case the export adds tail columns later.
   */
  private parseProjectsSheet(sheet: ExcelJS.Worksheet): ParsedImportRow[] {
    const headerRow = sheet.getRow(1);
    const expectedHeaders: Array<[number, string]> = [
      [2, 'Code'],
      [18, 'Program 1'],
      [19, 'Program 1 Allc %'],
      [20, 'Program 1 Complementarity (HML)'],
      [21, 'Program 1 Efficiency (HML)'],
      [22, 'Program 1 Justification'],
      [23, 'Program 2'],
      [28, 'Program 3'],
      [41, 'Description'],
      [42, 'Summary'],
    ];

    for (const [col, expected] of expectedHeaders) {
      const got = readCellString(headerRow, col);
      if (got.toLowerCase() !== expected.toLowerCase()) {
        throw new BadRequestException(
          `The uploaded 'Projects' sheet does not match the export format. Re-export the projects list and try again. (expected column ${col} to be "${expected}", got "${got}")`,
        );
      }
    }

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
      const projectDescription = descriptionRaw.trim() === '' ? null : descriptionRaw;
      const projectSummary = summaryRaw.trim() === '' ? null : summaryRaw;

      /* Three slot quintuples — (programCol, pctCol, compCol, effCol, justCol).
       * Slots are 5 cols wide post justification-column addition. */
      const slots: Array<[number, number, number, number, number]> = [
        [18, 19, 20, 21, 22],
        [23, 24, 25, 26, 27],
        [28, 29, 30, 31, 32],
      ];

      for (const [progCol, pctCol, compCol, effCol, justCol] of slots) {
        const programCode = readCellString(row, progCol);
        const allocationRaw = readCellString(row, pctCol);
        const complementarityRating = normalizeRating(
          readCellString(row, compCol),
        );
        const efficiencyRating = normalizeRating(readCellString(row, effCol));
        const justification = readCellString(row, justCol);

        // Empty slot — skip silently.
        if (!programCode && !allocationRaw) continue;

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
        errors: 1,
        warnings: 0,
      },
      errors: [{ row: 0, projectCode: '', programCode: '', message }],
      warnings: [],
      preview: { toCreate: [], toUpdate: [], toRemove: [] },
    };
  }
}
