import {
  Controller,
  Post,
  HttpCode,
  HttpStatus,
  Logger,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import * as path from 'path';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import {
  ImportService,
  ImportSummary,
  RowImportSummary,
  BulkImportSummary,
} from './import.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';

/**
 * Maximum size of an uploaded importer file, in bytes.
 *
 * The Anaplan exports we accept are CSV/XLSX with at most a few tens of
 * thousands of rows; 20 MB is well above the largest realistic export
 * and protects the API from DoS-style uploads.
 */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Allowed mime types for the upload-based importers. We are deliberately
 * permissive: browsers and OSes label CSVs inconsistently
 * (`application/vnd.ms-excel` is common for plain CSV), so we accept the
 * common variants and rely on the file extension when needed.
 */
const ALLOWED_IMPORT_MIME_TYPES = new Set<string>([
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
]);

const ALLOWED_IMPORT_EXTENSIONS = new Set<string>(['.csv', '.xlsx', '.xls']);

/**
 * Maximum number of files accepted by the bulk upload endpoint in a
 * single POST. Set high enough to handle a realistic batch (one 4.1 +
 * one 4.3 per center, plus headroom) but low enough that a misclick
 * cannot DoS the service.
 */
const MAX_BULK_FILES = 10;

/**
 * Validates that an uploaded file is present, within the size cap, and
 * has an extension / mime type we support. Throws BadRequestException
 * with a clear message otherwise so the client can show useful feedback.
 */
function assertImportFile(file: Express.Multer.File | undefined): void {
  if (!file) {
    throw new BadRequestException('No file was uploaded under field "file".');
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    throw new BadRequestException(
      `File exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit.`,
    );
  }

  const ext = (path.extname(file.originalname) || '').toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();

  if (
    !ALLOWED_IMPORT_EXTENSIONS.has(ext) &&
    !ALLOWED_IMPORT_MIME_TYPES.has(mime)
  ) {
    throw new BadRequestException(
      `Unsupported file type "${ext || mime}". Upload a .csv or .xlsx file.`,
    );
  }
}

/**
 * Validates that the bulk-import upload is well-formed: at least one
 * file present, no more than `MAX_BULK_FILES`, every file readable and
 * with an allowed extension. Reuses `assertImportFile` so the same
 * messaging is surfaced for both single and bulk endpoints.
 */
function assertBulkImportFiles(
  files: Express.Multer.File[] | undefined,
): asserts files is Express.Multer.File[] {
  if (!files || files.length === 0) {
    throw new BadRequestException(
      'No files were uploaded under field "files".',
    );
  }

  if (files.length > MAX_BULK_FILES) {
    throw new BadRequestException(
      `Too many files — upload at most ${MAX_BULK_FILES} per request.`,
    );
  }

  for (const file of files) {
    assertImportFile(file);
  }
}

/**
 * Admin-only controller for triggering CSV / Excel data imports.
 *
 * Hosts both the legacy file-path-based import endpoints (used during
 * the initial seed) and the upload-based variants used by the admin UI.
 * Every endpoint is gated by `@Roles(UserRole.ADMIN)`.
 */
@ApiTags('Admin - Import')
@ApiBearerAuth('access-token')
@Controller('admin')
export class ImportController {
  private readonly logger = new Logger(ImportController.name);

  constructor(private readonly importService: ImportService) {}

  /**
   * Clears all project data and reimports from the TOC_Projects.csv
   * shipped alongside the API. Use when the CSV structure has changed
   * and old data is stale.
   */
  @Post('reimport-csv')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Clear all project data and reimport from CSV',
    description:
      'Deletes all projects, mappings, budgets, and snapshots, then runs ' +
      'a fresh import from TOC_Projects.csv. Requires ADMIN role.',
  })
  @ApiResponse({ status: 200, description: 'Reimport completed.' })
  @ApiResponse({ status: 401, description: 'Unauthorized — no valid JWT.' })
  @ApiResponse({ status: 403, description: 'Forbidden — ADMIN role required.' })
  async reimportCsv(): Promise<ImportSummary> {
    this.logger.log('Full reimport triggered by admin — clearing data first');
    await this.importService.clearProjectData();
    return this.importService.runImport();
  }

  /**
   * Triggers a TOC_Projects.csv import (idempotent upsert).
   */
  @Post('import-csv')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Import projects and mappings from CSV',
    description:
      'Reads the TOC_Projects.csv file, upserts projects and their program ' +
      'mappings. Idempotent — safe to run multiple times. Requires ADMIN role.',
  })
  @ApiResponse({
    status: 200,
    description: 'Import completed successfully. Returns summary of changes.',
    schema: {
      type: 'object',
      properties: {
        projectsCreated: { type: 'number' },
        projectsUpdated: { type: 'number' },
        mappingsCreated: { type: 'number' },
        mappingsUpdated: { type: 'number' },
        skipped: { type: 'number' },
        errors: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              row: { type: 'number' },
              reason: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized — no valid JWT.' })
  @ApiResponse({ status: 403, description: 'Forbidden — ADMIN role required.' })
  async importCsv(): Promise<ImportSummary> {
    this.logger.log('CSV import triggered by admin');
    return this.importService.runImport();
  }

  /* ------------------------------------------------------------------ */
  /* Legacy file-path-based 4.1 / 4.3 importers (kept for compatibility) */
  /* ------------------------------------------------------------------ */

  /**
   * Imports the 4.1 Project Info CSV from the repo root. Kept for the
   * initial-seed workflow — admins use the upload variant for ongoing
   * imports.
   *
   * Returns the new normalized {created, updated, skipped, errors} shape.
   */
  @Post('import-project-info')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Import 4.1 Project Info CSV from repo root',
    description:
      'Reads "4.1 Project info.csv" from the repo root, upserts project ' +
      'metadata, and auto-creates projects whose code is new. Idempotent. ' +
      'Requires ADMIN role.',
  })
  @ApiResponse({
    status: 200,
    description: 'Import completed. Returns created/updated/skipped counts.',
    schema: { $ref: '#/components/schemas/RowImportSummary' },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized — no valid JWT.' })
  @ApiResponse({ status: 403, description: 'Forbidden — ADMIN role required.' })
  async importProjectInfo(): Promise<RowImportSummary> {
    /* Repo root resolved from api/ cwd (the default for `npm run start:dev`) */
    const filePath = path.resolve(process.cwd(), '..', '4.1 Project info.csv');
    this.logger.log(`4.1 Project Info import triggered by admin: ${filePath}`);
    return this.importService.importProjectInfo(filePath);
  }

  /**
   * Imports the 4.3 Project Budget CSV from the repo root. Kept for the
   * initial-seed workflow — admins use the upload variant for ongoing
   * imports.
   *
   * Returns the new normalized {created, updated, skipped, errors} shape.
   */
  @Post('import-project-budgets')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Import 4.3 Project Budget CSV from repo root',
    description:
      'Reads "4.3 Project Budget.csv" from the repo root and upserts budget ' +
      'lines keyed by external_code. Idempotent. Requires ADMIN role.',
  })
  @ApiResponse({
    status: 200,
    description: 'Import completed. Returns created/updated/skipped counts.',
    schema: { $ref: '#/components/schemas/RowImportSummary' },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized — no valid JWT.' })
  @ApiResponse({ status: 403, description: 'Forbidden — ADMIN role required.' })
  async importProjectBudgets(): Promise<RowImportSummary> {
    const filePath = path.resolve(
      process.cwd(),
      '..',
      '4.3 Project Budget.csv',
    );
    this.logger.log(
      `4.3 Project Budget import triggered by admin: ${filePath}`,
    );
    return this.importService.importProjectBudgets(filePath);
  }

  /* ------------------------------------------------------------------ */
  /* Upload-based 4.1 / 4.3 importers (admin UI)                          */
  /* ------------------------------------------------------------------ */

  /**
   * Upload-based 4.1 Project Info importer.
   *
   * Accepts a multipart `file` field (CSV or XLSX) capped at 20 MB. The
   * file is parsed in-memory and routed through the same per-row logic
   * used by the legacy file-path variant — which means existing
   * projects are updated and unknown codes auto-create new projects
   * (using the `Entity` column to resolve the center).
   */
  @Post('imports/project-info')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    }),
  )
  @ApiOperation({
    summary: 'Upload a 4.1 Project Info CSV / XLSX',
    description:
      'Accepts a multipart upload of an Anaplan 4.1 Project Info export ' +
      '(CSV or XLSX). Existing projects (matched by code) are updated; ' +
      'unknown codes auto-create new projects using the Entity column to ' +
      'resolve the center. Idempotent. Requires ADMIN role.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
      },
      required: ['file'],
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Import completed.',
    schema: { $ref: '#/components/schemas/RowImportSummary' },
  })
  @ApiResponse({ status: 400, description: 'Bad request — file invalid.' })
  @ApiResponse({ status: 401, description: 'Unauthorized — no valid JWT.' })
  @ApiResponse({ status: 403, description: 'Forbidden — ADMIN role required.' })
  async uploadProjectInfo(
    @UploadedFile() file: Express.Multer.File,
  ): Promise<RowImportSummary> {
    assertImportFile(file);
    this.logger.log(
      `4.1 upload import triggered by admin: ${file.originalname} ` +
        `(${file.size} bytes, ${file.mimetype})`,
    );
    return this.importService.importProjectInfoFromBuffer(
      file.buffer,
      file.originalname,
    );
  }

  /**
   * Upload-based 4.3 Project Budget importer.
   *
   * Accepts a multipart `file` field (CSV or XLSX) capped at 20 MB.
   * Idempotent via the UNIQUE constraint on `external_code`.
   */
  @Post('imports/project-data')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    }),
  )
  @ApiOperation({
    summary: 'Upload a 4.3 Project Budget CSV / XLSX',
    description:
      'Accepts a multipart upload of an Anaplan 4.3 Project Budget export ' +
      '(CSV or XLSX). Budget lines are upserted by external_code. Rows ' +
      'whose project code does not exist are counted as skipped. ' +
      'Idempotent. Requires ADMIN role.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
      },
      required: ['file'],
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Import completed.',
    schema: { $ref: '#/components/schemas/RowImportSummary' },
  })
  @ApiResponse({ status: 400, description: 'Bad request — file invalid.' })
  @ApiResponse({ status: 401, description: 'Unauthorized — no valid JWT.' })
  @ApiResponse({ status: 403, description: 'Forbidden — ADMIN role required.' })
  async uploadProjectData(
    @UploadedFile() file: Express.Multer.File,
  ): Promise<RowImportSummary> {
    assertImportFile(file);
    this.logger.log(
      `4.3 upload import triggered by admin: ${file.originalname} ` +
        `(${file.size} bytes, ${file.mimetype})`,
    );
    return this.importService.importProjectBudgetsFromBuffer(
      file.buffer,
      file.originalname,
    );
  }

  /* ------------------------------------------------------------------ */
  /* Bulk multi-file importer (admin UI)                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Accepts a multipart upload containing 1..N Anaplan importer files
   * under field name `files` and processes them in dependency order.
   *
   * Why this exists: when an admin uploaded a 4.3 Project Data file
   * BEFORE its matching 4.1 Project Info, every row was silently
   * skipped because the project codes didn't yet exist. This endpoint
   * detects the type of each file (filename pattern → header signature
   * → 'unknown') and processes ALL 4.1 files first, then ALL 4.3 files,
   * ensuring projects exist before their budgets are attached.
   *
   * Per-file failures (corrupt xlsx, unknown type, …) are recorded as
   * one error row in that file's result and the bulk run continues —
   * a single bad file never aborts the whole upload.
   *
   * Multer enforces the per-file size cap (20 MB) and the file-count
   * cap (10); if either is exceeded NestJS responds with 413 Payload
   * Too Large directly.
   */
  @Post('imports/bulk')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FilesInterceptor('files', MAX_BULK_FILES, {
      limits: { fileSize: MAX_UPLOAD_BYTES },
    }),
  )
  @ApiOperation({
    summary:
      'Bulk upload multiple 4.1 / 4.3 / Signalling importer files at once',
    description:
      'Accepts up to 10 multipart files under field "files" (CSV or XLSX, ' +
      '20 MB max each). Detects the type of each file (4.1 Project Info, ' +
      '4.3 Project Data, or Signalling historical mapping seed) by ' +
      'filename and header signature, then processes ALL 4.1 files ' +
      'first, then Signalling files, then 4.3 files — so projects exist ' +
      'before mappings or budgets are attached. Per-file failures are ' +
      'recorded individually and never abort the rest of the batch. ' +
      'Requires ADMIN role.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          description: '1..10 CSV or XLSX files (20 MB max each)',
        },
      },
      required: ['files'],
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Bulk import completed (per-file results in payload).',
    schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              filename: { type: 'string' },
              type: {
                type: 'string',
                enum: ['4.1', '4.3', 'signalling', 'unknown'],
              },
              created: { type: 'number' },
              updated: { type: 'number' },
              skipped: { type: 'number' },
              errors: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    row: { type: 'number' },
                    code: { type: 'string' },
                    reason: { type: 'string' },
                  },
                },
              },
            },
          },
        },
        totals: {
          type: 'object',
          properties: {
            filesProcessed: { type: 'number' },
            created: { type: 'number' },
            updated: { type: 'number' },
            skipped: { type: 'number' },
            errors: { type: 'number' },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request — no files, too many files, or unsupported type.',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized — no valid JWT.' })
  @ApiResponse({ status: 403, description: 'Forbidden — ADMIN role required.' })
  @ApiResponse({
    status: 413,
    description: 'Payload too large — at least one file exceeds the 20 MB cap.',
  })
  async uploadBulk(
    @UploadedFiles() files: Express.Multer.File[],
  ): Promise<BulkImportSummary> {
    assertBulkImportFiles(files);
    this.logger.log(
      `Bulk upload import triggered by admin: ${files.length} file(s) — ` +
        files
          .map((f) => `${f.originalname} (${f.size}b, ${f.mimetype})`)
          .join('; '),
    );
    return this.importService.runBulkImport(
      files.map((f) => ({ buffer: f.buffer, originalName: f.originalname })),
    );
  }
}
