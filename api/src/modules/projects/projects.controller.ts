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
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { UnitAdminUpdateProjectDto } from './dto/unit-admin-update-project.dto';
import { ProjectQueryDto } from './dto/project-query.dto';
import { ProjectSummaryQueryDto } from './dto/project-summary-query.dto';
import { ProjectSuggestedQueryDto } from './dto/project-suggested-query.dto';
import { ProjectAuditQueryDto } from './dto/project-audit-query.dto';
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
  constructor(private readonly projectsService: ProjectsService) {}

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
   * Retrieves a single project by ID.
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get a project by ID' })
  @ApiResponse({ status: 200, description: 'The project' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.projectsService.findOne(id);
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
  @Roles(UserRole.ADMIN, UserRole.UNIT_ADMIN)
  @ApiOperation({
    summary:
      'Update a constrained subset of project metadata (admin, unit_admin)',
  })
  @ApiParam({ name: 'id', type: Number, description: 'Project ID' })
  @ApiBody({ type: UnitAdminUpdateProjectDto })
  @ApiResponse({ status: 200, description: 'Project updated successfully' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden — requires admin or unit_admin role',
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
    @Query() query: ProjectAuditQueryDto,
  ) {
    return this.projectsService.getAuditHistory(id, query.page, query.limit);
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
