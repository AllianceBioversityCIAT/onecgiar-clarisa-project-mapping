import {
  Controller,
  Get,
  Post,
  Body,
  Res,
  UploadedFile,
  UseInterceptors,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { ApiTags, ApiConsumes, ApiOperation } from '@nestjs/swagger';

import { CenterImportsService } from './center-imports.service';
import { CommitImportDto } from './dto/commit-import.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { User } from '../users/entities/user.entity';

/**
 * Controller for center-rep bulk mappings import.
 *
 * Three endpoints:
 *  GET  /center-imports/mappings/template — download pre-filled Excel template
 *  POST /center-imports/mappings/validate  — upload file, get preview + batchId
 *  POST /center-imports/mappings/commit    — execute the import from a batchId
 */
@ApiTags('Center Imports')
@Controller('center-imports/mappings')
export class CenterImportsController {
  constructor(private readonly centerImportsService: CenterImportsService) {}

  /**
   * Download an Excel template pre-filled with the caller's center's active
   * projects and their current mappings.
   *
   * Accessible to center_rep and workflow_admin.
   */
  @Get('template')
  @Roles(UserRole.CENTER_REP, UserRole.WORKFLOW_ADMIN)
  @ApiOperation({
    summary: 'Download pre-filled mappings import template (.xlsx)',
  })
  async downloadTemplate(
    @CurrentUser() user: User,
    @Res() res: Response,
  ): Promise<void> {
    const buffer = await this.centerImportsService.buildTemplate(user);
    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="mappings-import.xlsx"',
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  /**
   * Upload an Excel file and receive a validation report + preview.
   *
   * Returns 200 in all cases (even when there are errors) so the client
   * can display all validation issues at once. When errors.length === 0,
   * the response also contains a batchId JWT the client must submit to /commit.
   */
  @Post('validate')
  @Roles(UserRole.CENTER_REP, UserRole.WORKFLOW_ADMIN)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Validate a mappings import file and preview changes',
  })
  async validate(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: User,
  ) {
    if (!file) {
      return {
        summary: {
          toCreate: 0,
          toUpdate: 0,
          toRemove: 0,
          errors: 1,
          warnings: 0,
        },
        errors: [
          {
            row: 0,
            projectCode: '',
            programCode: '',
            message: 'Please upload a valid .xlsx file',
          },
        ],
        warnings: [],
        preview: { toCreate: [], toUpdate: [], toRemove: [] },
      };
    }
    return this.centerImportsService.validate(file.buffer, user);
  }

  /**
   * Execute the import for a previously validated batch.
   *
   * The client submits the batchId JWT returned by /validate.
   * The server verifies the token, retrieves the cached rows,
   * and runs the full import in a single database transaction.
   */
  @Post('commit')
  @Roles(UserRole.CENTER_REP, UserRole.WORKFLOW_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Commit a validated import batch' })
  async commit(@Body() dto: CommitImportDto, @CurrentUser() user: User) {
    return this.centerImportsService.commit(dto.batchId, user);
  }
}
