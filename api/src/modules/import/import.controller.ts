import { Controller, Post, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import * as path from 'path';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { ImportService, ImportSummary } from './import.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';

/**
 * Admin-only controller for triggering CSV data imports.
 *
 * Provides a single endpoint to import projects and mappings from the
 * CSV file. The operation is idempotent — running it multiple times
 * will upsert existing records rather than creating duplicates.
 */
@ApiTags('Admin - Import')
@ApiBearerAuth('access-token')
@Controller('admin')
export class ImportController {
  private readonly logger = new Logger(ImportController.name);

  constructor(private readonly importService: ImportService) {}

  /**
   * Triggers a full CSV import of projects and program mappings.
   *
   * Requires ADMIN role. The import reads the CSV file, resolves
   * reference data (centers, programs, countries), and upserts
   * projects and their mappings. Safe to call multiple times.
   *
   * @returns Import summary with counts and any per-row errors.
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

  /**
   * Imports optional project metadata from the 4.1 Project Info CSV.
   *
   * Only updates projects whose `code` already exists in the database.
   * Unknown codes are counted as skipped. Idempotent — safe to re-run.
   * Never touches `project_mappings`.
   */
  @Post('import-project-info')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Import 4.1 Project Info CSV',
    description:
      'Reads 4.1 Project Info.csv from the repo root and updates optional ' +
      'project metadata (funder, category, CSP, pledge, PI, etc.) for ' +
      'existing projects. Idempotent. Requires ADMIN role.',
  })
  @ApiResponse({
    status: 200,
    description: 'Import completed. Returns matched/updated/skipped counts.',
    schema: {
      type: 'object',
      properties: {
        matched: { type: 'number' },
        updated: { type: 'number' },
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
  async importProjectInfo() {
    /* Repo root resolved from api/ cwd (the default for `npm run start:dev`) */
    const filePath = path.resolve(process.cwd(), '..', '4.1 Project info.csv');
    this.logger.log(`4.1 Project Info import triggered by admin: ${filePath}`);
    return this.importService.importProjectInfo(filePath);
  }

  /**
   * Imports fiscal-year budget lines from the 4.3 Project Budget CSV.
   *
   * Idempotent via the UNIQUE constraint on `project_budgets.external_code`
   * — re-runs update existing rows rather than inserting duplicates.
   * Never touches `project_mappings`.
   */
  @Post('import-project-budgets')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Import 4.3 Project Budget CSV',
    description:
      'Reads 4.3 Project Budget.csv from the repo root and upserts budget ' +
      'lines keyed by external_code. Idempotent. Requires ADMIN role.',
  })
  @ApiResponse({
    status: 200,
    description: 'Import completed. Returns inserted/updated/skipped counts.',
    schema: {
      type: 'object',
      properties: {
        budgetLinesInserted: { type: 'number' },
        budgetLinesUpdated: { type: 'number' },
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
  async importProjectBudgets() {
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
}
