import { Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { ReferenceDataService } from './reference-data.service';
import { CenterResponseDto } from './dto/center-response.dto';
import { ProgramResponseDto } from './dto/program-response.dto';
import { CountryResponseDto } from './dto/country-response.dto';
import { ActionAreaResponseDto } from './dto/action-area-response.dto';
import { SyncResultDto } from './dto/sync-result.dto';

/**
 * Controller for reference data endpoints.
 *
 * Exposes read-only lists of CLARISA-synced entities (centers,
 * programs, countries, action areas) to any authenticated user,
 * and an admin-only sync trigger.
 */
@ApiTags('Reference Data')
@ApiBearerAuth('access-token')
@Controller()
export class ReferenceDataController {
  constructor(private readonly referenceDataService: ReferenceDataService) {}

  // ──────────────────────────────────────────────────────────────────
  //  Admin sync endpoint
  // ──────────────────────────────────────────────────────────────────

  /**
   * Trigger a full CLARISA sync. Restricted to admin users.
   * Fetches latest data from all CLARISA endpoints and upserts locally.
   */
  @Post('admin/sync-clarisa')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Trigger CLARISA sync (admin only)' })
  async syncClarisa(): Promise<SyncResultDto> {
    return this.referenceDataService.syncAll();
  }

  // ──────────────────────────────────────────────────────────────────
  //  Public read endpoints (any authenticated user)
  // ──────────────────────────────────────────────────────────────────

  /** Return all CGIAR centers sorted by name. */
  @Get('centers')
  @ApiOperation({ summary: 'List all centers' })
  async getCenters(): Promise<CenterResponseDto[]> {
    return this.referenceDataService.findAllCenters();
  }

  /** Return all programs (initiatives) sorted by name. */
  @Get('programs')
  @ApiOperation({ summary: 'List all programs' })
  async getPrograms(): Promise<ProgramResponseDto[]> {
    return this.referenceDataService.findAllPrograms();
  }

  /** Return all countries sorted by name. */
  @Get('countries')
  @ApiOperation({ summary: 'List all countries' })
  async getCountries(): Promise<CountryResponseDto[]> {
    return this.referenceDataService.findAllCountries();
  }

  /** Return all action areas. */
  @Get('action-areas')
  @ApiOperation({ summary: 'List all action areas' })
  async getActionAreas(): Promise<ActionAreaResponseDto[]> {
    return this.referenceDataService.findAllActionAreas();
  }
}
