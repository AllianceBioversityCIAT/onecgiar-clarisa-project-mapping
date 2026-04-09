import { Controller, Post, HttpCode, HttpStatus, Logger } from '@nestjs/common';
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
}
