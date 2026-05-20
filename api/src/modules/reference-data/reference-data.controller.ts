import { Controller, Get, Post, Query } from '@nestjs/common';
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
import { TocAowQueryDto } from './dto/toc-aow-query.dto';
import { TocOutcomeQueryDto } from './dto/toc-outcome-query.dto';
import { TocOutputQueryDto } from './dto/toc-output-query.dto';
import { TocReferenceQueryDto } from './dto/toc-reference-query.dto';
import {
  TocAowListItemDto,
  TocListResponseDto,
  TocOutcomeListItemDto,
  TocOutputListItemDto,
} from './dto/toc-list-response.dto';

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
  //  Admin TOC viewer — paginated list endpoints
  // ──────────────────────────────────────────────────────────────────

  /**
   * Paginated list of AOWs scoped to one program.
   *
   * `programId` is required. `search` matches acronym /
   * wp_official_code / name (LIKE, OR). Ordered by
   * `wp_official_code ASC` so e.g. SP01-AOW01, SP01-AOW02…
   * appear in their natural sequence.
   */
  @Get('admin/toc/aows')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'List TOC AOWs (admin only)' })
  async listAows(
    @Query() query: TocAowQueryDto,
  ): Promise<TocListResponseDto<TocAowListItemDto>> {
    return this.referenceDataService.listAows(query);
  }

  /**
   * Paginated list of TOC outcomes (intermediate + portfolio).
   *
   * `programId` is required; `aowId` is optional. Backend is
   * liberal — a mismatched `aowId` returns empty `data` rather
   * than an error.
   */
  @Get('admin/toc/outcomes')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'List TOC outcomes (admin only)' })
  async listOutcomes(
    @Query() query: TocOutcomeQueryDto,
  ): Promise<TocListResponseDto<TocOutcomeListItemDto>> {
    return this.referenceDataService.listOutcomes(query);
  }

  /**
   * Paginated list of TOC outputs.
   *
   * Same shape as outcomes — `programId` required, `aowId`
   * optional, `search` matches title. Ordered `title ASC`.
   */
  @Get('admin/toc/outputs')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'List TOC outputs (admin only)' })
  async listOutputs(
    @Query() query: TocOutputQueryDto,
  ): Promise<TocListResponseDto<TocOutputListItemDto>> {
    return this.referenceDataService.listOutputs(query);
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

  // ──────────────────────────────────────────────────────────────────
  //  TOC reference reads (any authenticated user)
  //
  //  Distinct from the admin-only paginated viewer under
  //  /admin/toc/*: these endpoints return the full per-program set
  //  in one shot for the consolidated-page TOC-link picker. Per
  //  CLAUDE.md, datasets are small (≤ a few dozen rows per table
  //  per program) so pagination is unnecessary.
  // ──────────────────────────────────────────────────────────────────

  /**
   * All AOWs for one program. No role gate — any authenticated user
   * can read TOC reference data on the consolidated page.
   */
  @Get('toc/aows')
  @ApiOperation({ summary: 'List AOWs for a program (any auth)' })
  async getAowsForProgram(
    @Query() query: TocReferenceQueryDto,
  ): Promise<TocAowListItemDto[]> {
    return this.referenceDataService.listAowsForProgram(query.programId);
  }

  /**
   * Outputs for one program, optionally filtered to one or more AOWs.
   */
  @Get('toc/outputs')
  @ApiOperation({
    summary: 'List Outputs for a program, optionally filtered by AOW',
  })
  async getOutputsForProgram(
    @Query() query: TocReferenceQueryDto,
  ): Promise<TocOutputListItemDto[]> {
    return this.referenceDataService.listOutputsForProgram(
      query.programId,
      query.aowIds,
    );
  }

  /**
   * Intermediate Outcomes (only) for one program, optionally filtered
   * by AOW. Portfolio EOIs are excluded server-side.
   */
  @Get('toc/outcomes')
  @ApiOperation({
    summary:
      'List Intermediate Outcomes for a program, optionally filtered by AOW',
  })
  async getOutcomesForProgram(
    @Query() query: TocReferenceQueryDto,
  ): Promise<TocOutcomeListItemDto[]> {
    return this.referenceDataService.listIntermediateOutcomesForProgram(
      query.programId,
      query.aowIds,
    );
  }
}
