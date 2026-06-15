import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import { ProjectsService, ProjectFilterOptions } from './projects.service';
import { ProjectsExportService } from './services/projects-export.service';
import { ProjectExclusionService } from './services/project-exclusion.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { UnitAdminUpdateProjectDto } from './dto/unit-admin-update-project.dto';
import { ExcludeProjectDto } from './dto/exclude-project.dto';
import { ProjectQueryDto } from './dto/project-query.dto';
import { ProjectExportQueryDto } from './dto/project-export-query.dto';
import { ProjectSummaryQueryDto } from './dto/project-summary-query.dto';
import { ProjectSuggestedQueryDto } from './dto/project-suggested-query.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { User } from '../users/entities/user.entity';

/**
 * REST controller for project CRUD operations.
 *
 * All endpoints require JWT authentication (enforced globally).
 * Write operations (create, update, delete) are restricted to
 * users with the ADMIN role.
 */
@ApiTags('projects')
@ApiBearerAuth('access-token')
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly exportService: ProjectsExportService,
    private readonly exclusionService: ProjectExclusionService,
  ) {}

  /**
   * Retrieves a paginated list of projects with optional search and filters.
   */
  @Get()
  @ApiOperation({
    summary: 'List projects with pagination, search, and filters',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of projects' })
  findAll(@Query() query: ProjectQueryDto, @CurrentUser() user: User) {
    return this.projectsService.findAll(query, user);
  }

  /**
   * Returns aggregate KPI totals (active count, total pledge, total budget
   * for the chosen fiscal year, mapped %) across the filtered projects set.
   *
   * Mounted BEFORE `:id` so Nest matches the literal `/projects/summary`
   * path instead of treating `summary` as a project ID.
   */
  @Get('summary')
  @ApiOperation({
    summary:
      'Aggregate budget/pledge/mapped totals across the filtered projects set',
  })
  @ApiResponse({ status: 200, description: 'Aggregate KPI totals' })
  getSummary(
    @Query() query: ProjectSummaryQueryDto,
    @CurrentUser() user: User,
  ) {
    return this.projectsService.getSummary(query, user);
  }

  /**
   * Returns the distinct, non-empty funder names across all projects,
   * sorted alphabetically. Used to populate the funder filter dropdown
   * on the projects list page.
   *
   * Mounted BEFORE `:id` so Nest matches the literal `/projects/funders`
   * path instead of treating `funders` as a project ID.
   */
  @Get('funders')
  @ApiOperation({ summary: 'List distinct funder names for the filter dropdown' })
  @ApiResponse({ status: 200, description: 'Alphabetically-sorted funder names' })
  getFunders(): Promise<string[]> {
    return this.projectsService.getDistinctFunders();
  }

  /**
   * Returns the values that should populate each context-aware filter
   * dropdown (funding source, center, programs, funder, mapping status),
   * given the caller's other active filters. Powers "only show what's there"
   * dropdowns on the projects list — a value is offered only when at least
   * one project would match it under every OTHER active filter.
   *
   * Accepts the same filter params as `GET /projects` (pagination/sort are
   * ignored). Mounted BEFORE `:id` so Nest matches the literal path.
   */
  @Get('filter-options')
  @ApiOperation({
    summary: 'Distinct filter-dropdown values present under the active filters',
  })
  @ApiResponse({
    status: 200,
    description: 'Available option values per filter facet',
  })
  getFilterOptions(
    @Query() query: ProjectQueryDto,
    @CurrentUser() user: User,
  ): Promise<ProjectFilterOptions> {
    return this.projectsService.getFilterOptions(query, user);
  }

  /**
   * Greedy "what to map next" suggestion. Returns the ordered list of
   * project IDs the center rep should tackle to push their FY mapped %
   * up to the requested target (defaults to 90 %).
   *
   * Mounted BEFORE `:id` so Nest matches the literal path rather than
   * treating `suggested-to-reach-target` as a project ID.
   */
  @Get('suggested-to-reach-target')
  @ApiOperation({
    summary:
      'Greedy list of projects to map next to reach the FY mapped-% target',
  })
  @ApiResponse({
    status: 200,
    description: 'Ordered project IDs and projected mapped %',
  })
  getSuggestedToReachTarget(
    @Query() query: ProjectSuggestedQueryDto,
    @CurrentUser() user: User,
  ) {
    return this.projectsService.getSuggestedToReachTarget(query, user);
  }

  /**
   * Streams a filtered project list as a multi-sheet Excel workbook.
   *
   * Accepts the same filters as `GET /projects` minus pagination and sort.
   * Hard-capped at EXPORT_MAX_ROWS (env, default 5000). Role scoping
   * (center rep / program rep) is enforced inside the service.
   *
   * Throttled: 5 requests per 60 seconds per IP.
   *
   * Mounted BEFORE `:id` so Nest resolves the literal path `export` first.
   */
  @Get('export')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Export filtered project list as Excel (.xlsx)' })
  @ApiResponse({ status: 200, description: 'Excel file stream' })
  @ApiResponse({
    status: 400,
    description: 'Filter matches more rows than the export cap',
  })
  @ApiResponse({ status: 429, description: 'Too many export requests' })
  exportList(
    @Query() query: ProjectExportQueryDto,
    @CurrentUser() user: User,
    @Res() res: Response,
  ): Promise<void> {
    return this.exportService.streamListExport(query, user, res);
  }

  /**
   * Retrieves a single project by ID.
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get a project by ID' })
  @ApiResponse({ status: 200, description: 'The project' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: User) {
    return this.projectsService.findOne(id, user);
  }

  /**
   * Creates a new project. Restricted to ADMIN users.
   */
  @Post()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Create a new project (admin only)' })
  @ApiResponse({ status: 201, description: 'Project created successfully' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 403, description: 'Forbidden — requires admin role' })
  @ApiResponse({ status: 409, description: 'Duplicate project code' })
  create(@Body() dto: CreateProjectDto, @CurrentUser() user: User) {
    return this.projectsService.create(dto, user.id);
  }

  /**
   * Updates an existing project. Restricted to ADMIN users.
   *
   * The authenticated user is forwarded to the service so scalar field
   * changes are recorded as `project_audit_events` rows; without this
   * the service would log a warning and skip the audit trail.
   */
  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update a project (admin only)' })
  @ApiResponse({ status: 200, description: 'Project updated successfully' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 403, description: 'Forbidden — requires admin role' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 409, description: 'Duplicate project code' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateProjectDto,
    @CurrentUser() user: User,
  ) {
    return this.projectsService.update(id, dto, user);
  }

  /**
   * Constrained metadata update for the unit-admin (PPU/PCU) role.
   *
   * Accepts the strict whitelist defined by `UnitAdminUpdateProjectDto`
   * (no code, centerId, status, or Anaplan-sourced fields) and records
   * the supplied justification on every audit row produced by the edit.
   * Admin is included so privileged users can reuse the same constrained
   * surface — the broader `PATCH /projects/:id` endpoint remains available
   * for full edits.
   */
  @Patch(':id/metadata')
  @Roles(UserRole.ADMIN, UserRole.UNIT_ADMIN, UserRole.CENTER_REP)
  @ApiOperation({
    summary:
      'Update a constrained subset of project metadata (admin, unit_admin, center_rep — center_rep limited to own center)',
  })
  @ApiParam({ name: 'id', type: Number, description: 'Project ID' })
  @ApiBody({ type: UnitAdminUpdateProjectDto })
  @ApiResponse({ status: 200, description: 'Project updated successfully' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({
    status: 403,
    description:
      'Forbidden — requires admin, unit_admin, or center_rep (own-center only)',
  })
  @ApiResponse({ status: 404, description: 'Project not found' })
  updateMetadata(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UnitAdminUpdateProjectDto,
    @CurrentUser() user: User,
  ) {
    return this.projectsService.unitAdminUpdate(id, dto, user);
  }

  /**
   * Returns the paginated audit-event history for a project, ordered by
   * most recent first with the actor user joined in. Used by the project
   * detail "history" tab. Open to admin, unit_admin, and workflow_admin
   * roles — the editors and the workflow admin who triages flagged
   * mappings all need visibility into what changed and when.
   */
  @Get(':id/audit')
  @Roles(UserRole.ADMIN, UserRole.UNIT_ADMIN, UserRole.WORKFLOW_ADMIN)
  @ApiOperation({
    summary:
      'Paginated audit history for a project (admin, unit_admin, workflow_admin)',
  })
  @ApiParam({ name: 'id', type: Number, description: 'Project ID' })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (1-based, default 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page (default 50, max 100)',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of audit events' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({
    status: 403,
    description:
      'Forbidden — requires admin, unit_admin, or workflow_admin role',
  })
  @ApiResponse({ status: 404, description: 'Project not found' })
  getAuditHistory(
    @Param('id', ParseIntPipe) id: number,
    @Query('page') pageRaw: string | undefined,
    @Query('limit') limitRaw: string | undefined,
    @CurrentUser() user: User,
  ) {
    /* Transitional: returns AuditEvent[] from the unified audit table.
     * Phase B.6 rewires the frontend Activity tab to consume that shape
     * and this route gets retired in favour of the generic /audit
     * endpoint. The controller's @Roles guard above is the first
     * authorization gate; the service additionally applies role-scoped
     * visibility inside AuditService.query.
     *
     * Pagination is parsed inline (the dedicated DTO was retired with
     * the project-only audit table). The service clamps invalid values
     * via AuditService.query()'s defaults. */
    const page = Number.isFinite(Number(pageRaw)) ? Number(pageRaw) : 1;
    const limit = Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 50;
    return this.projectsService.getAuditHistory(
      id,
      page,
      limit,
      user.role!,
      user.id,
    );
  }

  /**
   * Streams a single project as a multi-sheet Excel workbook.
   *
   * Sheets: Project | Budgets | Mappings | Negotiation Events | Chat | Audit.
   * Throttled: 5 requests per 60 seconds per IP.
   */
  @Get(':id/export')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Export a single project as Excel (.xlsx)' })
  @ApiParam({ name: 'id', type: Number, description: 'Project ID' })
  @ApiResponse({ status: 200, description: 'Excel file stream' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 429, description: 'Too many export requests' })
  exportDetail(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
    @Res() res: Response,
  ): Promise<void> {
    return this.exportService.streamDetailExport(id, user, res);
  }

  /**
   * Excludes a project from the acting center's default view.
   *
   * Center reps may only exclude projects belonging to their own center.
   * Admins may exclude any project; the exclusion is recorded under the
   * project's owning center so center reps of that center see the effect.
   *
   * Returns 409 when the (project, center) pair is already excluded.
   */
  @Post(':id/exclude')
  @Roles(UserRole.ADMIN, UserRole.CENTER_REP)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      "Exclude a project from this center's default view (admin, center_rep)",
  })
  @ApiParam({ name: 'id', type: Number, description: 'Project ID' })
  @ApiBody({ type: ExcludeProjectDto })
  @ApiResponse({ status: 201, description: 'Exclusion created' })
  @ApiResponse({
    status: 400,
    description: 'Validation error — reason too short',
  })
  @ApiResponse({
    status: 403,
    description:
      'Forbidden — center rep acting on a project outside their center',
  })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({
    status: 409,
    description: 'Project is already excluded for this center',
  })
  exclude(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ExcludeProjectDto,
    @CurrentUser() user: User,
  ) {
    return this.exclusionService.exclude(id, dto, user);
  }

  /**
   * Removes an existing exclusion, restoring the project to the center's
   * default view.
   *
   * Returns 404 when no matching exclusion exists for the (project, center)
   * pair, so callers can distinguish "already unexcluded" from "not found".
   */
  @Post(':id/unexclude')
  @Roles(UserRole.ADMIN, UserRole.CENTER_REP)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove a project exclusion for this center (admin, center_rep)',
  })
  @ApiParam({ name: 'id', type: Number, description: 'Project ID' })
  @ApiResponse({ status: 200, description: 'Exclusion removed' })
  @ApiResponse({
    status: 403,
    description:
      'Forbidden — center rep acting on a project outside their center',
  })
  @ApiResponse({
    status: 404,
    description: 'Project or exclusion not found',
  })
  unexclude(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
    @Query('centerId') centerIdRaw?: string,
  ) {
    /* Admin-only override: target a specific exclusion row when the project
     * is excluded by a center other than its owning center. Service ignores
     * this for non-admin actors. Parsed loosely (string from query). */
    const centerIdOverride =
      centerIdRaw !== undefined && centerIdRaw !== ''
        ? Number(centerIdRaw)
        : undefined;
    return this.exclusionService.unexclude(id, user, centerIdOverride);
  }

  /**
   * Archives a project (soft delete). Restricted to ADMIN users.
   * Returns 204 No Content on success.
   */
  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Archive a project (admin only)' })
  @ApiResponse({ status: 204, description: 'Project archived successfully' })
  @ApiResponse({ status: 403, description: 'Forbidden — requires admin role' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  archive(@Param('id', ParseIntPipe) id: number) {
    return this.projectsService.archive(id);
  }
}
