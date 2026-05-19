import { Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { ReferenceDataService } from './reference-data.service';
import { TocSyncService } from './toc-sync.service';
import { CenterResponseDto } from './dto/center-response.dto';
import { ProgramResponseDto } from './dto/program-response.dto';
import { CountryResponseDto } from './dto/country-response.dto';
import { ActionAreaResponseDto } from './dto/action-area-response.dto';
import { SyncResultDto } from './dto/sync-result.dto';
import { TocSyncResultDto } from './dto/toc-sync-result.dto';

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
  constructor(
    private readonly referenceDataService: ReferenceDataService,
    private readonly tocSyncService: TocSyncService,
  ) {}

  // ──────────────────────────────────────────────────────────────────
  //  Admin sync endpoints
  // ──────────────────────────────────────────────────────────────────

  /**
   * Trigger a full CLARISA sync. Restricted to admin users.
   * Fetches latest data from all CLARISA endpoints and upserts locally.
   */
  @Post('admin/sync-clarisa')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Trigger CLARISA sync (admin only)' })
  async syncClarisa(): Promise<SyncResultDto> {
    /* manualSync() wraps syncAll() with an audit record so the admin
     * trigger leaves a trace; the bootstrap-time call from
     * onApplicationBootstrap continues to use syncAll() directly. */
    return this.referenceDataService.manualSync();
  }

  /**
   * Trigger a full TOC (Theory of Change) sync across every program
   * in the local database. Restricted to admin users.
   *
   * Per-program: fetches the TOC graph, upserts AOWs / Outcomes /
   * Outputs in a transaction. 404s are counted as `failed` (not an
   * error) so the response always returns 200 with per-program
   * detail in `details[]`.
   */
  @Post('admin/sync-toc')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Trigger TOC sync (admin only)' })
  async syncToc(): Promise<TocSyncResultDto> {
    return this.tocSyncService.syncAll();
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
