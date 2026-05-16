import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { MappingsService } from './mappings.service';
import { CreateMappingDto } from './dto/create-mapping.dto';
import { CounterProposeDto } from './dto/counter-propose.dto';
import { AgreeDto } from './dto/agree.dto';
import { RemoveMappingDto } from './dto/remove-mapping.dto';
import { DeclineRemovalDto } from './dto/decline-removal.dto';
import { MappingQueryDto } from './dto/mapping-query.dto';
import { UpdateAllocationDto } from './dto/update-allocation.dto';
import { AddProgramDto } from './dto/add-program.dto';
import { PostChatMessageDto } from './dto/post-chat-message.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { User } from '../users/entities/user.entity';

/**
 * REST controller for project-to-program mapping negotiation.
 *
 * Handles the full negotiation lifecycle: initiation by center reps,
 * counter-proposals, agreement tracking, project round locking, and reopening.
 */
@ApiTags('mappings')
@ApiBearerAuth('access-token')
@Controller('mappings')
export class MappingsController {
  constructor(private readonly mappingsService: MappingsService) {}

  // ─── Queries ──────────────────────────────────────────────────────

  /** Retrieves a paginated list of mappings, scoped by role. */
  @Get()
  @ApiOperation({
    summary: 'List mappings with pagination, filters, and role-based scoping',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of mappings' })
  findAll(@Query() query: MappingQueryDto, @CurrentUser() user: User) {
    return this.mappingsService.findAll(query, user);
  }

  /** Retrieves the allocation summary for a project. */
  @Get('projects/:projectId/allocation')
  @ApiOperation({ summary: 'Get allocation summary for a project' })
  @ApiResponse({ status: 200, description: 'Project allocation summary' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  getAllocationSummary(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.mappingsService.getAllocationSummary(projectId);
  }

  /** Retrieves all mappings for a project (admin/center rep). */
  @Get('projects/:projectId/review-summary')
  @ApiOperation({
    summary: 'Get review summary for a project (role-scoped)',
  })
  @ApiResponse({ status: 200, description: 'Project review summary' })
  getReviewSummary(
    @Param('projectId', ParseIntPipe) projectId: number,
    @CurrentUser() user: User,
  ) {
    return this.mappingsService.getReviewSummary(projectId, user);
  }

  /** Retrieves the negotiation thread (conversation history) for a mapping. */
  @Get(':id/negotiations')
  @ApiOperation({ summary: 'Get negotiation thread for a mapping' })
  @ApiResponse({
    status: 200,
    description: 'Mapping with ordered negotiation events',
  })
  getNegotiationThread(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
  ) {
    return this.mappingsService.getNegotiationThread(id, user);
  }

  /** Retrieves a single mapping by ID. */
  @Get(':id')
  @ApiOperation({ summary: 'Get a mapping by ID' })
  @ApiResponse({ status: 200, description: 'The mapping' })
  findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: User) {
    return this.mappingsService.findOne(id, user);
  }

  // ─── Creation ─────────────────────────────────────────────────────

  /** Creates a new draft mapping (center rep only). */
  @Post()
  @Roles(UserRole.CENTER_REP)
  @ApiOperation({ summary: 'Create a mapping (center rep only)' })
  @ApiResponse({ status: 201, description: 'Mapping created in draft status' })
  @ApiResponse({
    status: 400,
    description: 'Validation error',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden — requires center_rep role',
  })
  @ApiResponse({ status: 409, description: 'Duplicate project+program' })
  create(@Body() dto: CreateMappingDto, @CurrentUser() user: User) {
    return this.mappingsService.create(dto, user);
  }

  // ─── Negotiation Actions ──────────────────────────────────────────

  /** Opens negotiation on a draft mapping (center rep only). */
  @Post(':id/open')
  @Roles(UserRole.CENTER_REP)
  @ApiOperation({
    summary: 'Open negotiation on a draft mapping (center rep)',
  })
  @ApiResponse({ status: 200, description: 'Mapping opened for negotiation' })
  openNegotiation(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
  ) {
    return this.mappingsService.openNegotiation(id, user);
  }

  /** Submits a counter-proposal (workflow admin, center rep, or program rep). */
  @Post(':id/counter-propose')
  @Roles(UserRole.WORKFLOW_ADMIN, UserRole.CENTER_REP, UserRole.PROGRAM_REP)
  @ApiOperation({
    summary:
      'Counter-propose on a mapping (workflow admin, center rep, or program rep)',
  })
  @ApiResponse({ status: 200, description: 'Counter-proposal submitted' })
  counterPropose(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CounterProposeDto,
    @CurrentUser() user: User,
  ) {
    return this.mappingsService.counterPropose(id, dto, user);
  }

  /** Marks agreement on current terms (workflow admin, center rep, or program rep). */
  @Post(':id/agree')
  @Roles(UserRole.WORKFLOW_ADMIN, UserRole.CENTER_REP, UserRole.PROGRAM_REP)
  @ApiOperation({
    summary:
      'Agree on current terms (workflow admin, center rep, or program rep)',
  })
  @ApiResponse({ status: 200, description: 'Agreement recorded' })
  agree(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AgreeDto,
    @CurrentUser() user: User,
  ) {
    return this.mappingsService.agree(id, dto, user);
  }

  /**
   * Removes a program from negotiations.
   *
   * - Center side (center_rep / workflow_admin): immediate. When a
   *   program-rep removal request is pending, this acts as the "accept"
   *   action and carries the program rep's reason into the audit event.
   * - Program rep: rejected with 403; must use `request-removal` instead.
   */
  @Post(':id/remove')
  @Roles(UserRole.WORKFLOW_ADMIN, UserRole.CENTER_REP, UserRole.PROGRAM_REP)
  @ApiOperation({
    summary:
      'Remove program from negotiations (center side; accepts pending request)',
  })
  @ApiResponse({ status: 200, description: 'Program removed' })
  removeProgram(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RemoveMappingDto,
    @CurrentUser() user: User,
  ) {
    return this.mappingsService.removeProgram(id, dto.justification, user);
  }

  /**
   * Program rep raises a removal request on their own mapping. The
   * mapping stays in negotiation until the center side accepts (via
   * `:id/remove`) or declines (via `:id/decline-removal`).
   */
  @Post(':id/request-removal')
  @Roles(UserRole.PROGRAM_REP)
  @ApiOperation({
    summary: 'Request removal from negotiation (program rep)',
  })
  @ApiResponse({ status: 200, description: 'Removal request raised' })
  @ApiResponse({ status: 409, description: 'A request is already pending' })
  requestRemoval(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RemoveMappingDto,
    @CurrentUser() user: User,
  ) {
    return this.mappingsService.requestRemoval(id, dto.justification, user);
  }

  /** Center side declines a pending program-rep removal request. */
  @Post(':id/decline-removal')
  @Roles(UserRole.WORKFLOW_ADMIN, UserRole.CENTER_REP)
  @ApiOperation({
    summary: 'Decline a pending program-rep removal request',
  })
  @ApiResponse({ status: 200, description: 'Removal request declined' })
  @ApiResponse({ status: 400, description: 'No request is pending' })
  declineRemoval(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DeclineRemovalDto,
    @CurrentUser() user: User,
  ) {
    return this.mappingsService.declineRemoval(id, dto.reason, user);
  }

  // ─── Project-Level Actions ────────────────────────────────────────

  /** Locks project-level negotiation (workflow admin or owning center rep). */
  @Post('projects/:projectId/lock')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.WORKFLOW_ADMIN, UserRole.CENTER_REP)
  @ApiOperation({
    summary: 'Lock project negotiation (workflow admin or owning center rep)',
  })
  @ApiResponse({ status: 200, description: 'Project negotiation locked' })
  @ApiResponse({
    status: 400,
    description: 'Gate failed: not all agreed or total != 100%',
  })
  lockProjectRound(
    @Param('projectId', ParseIntPipe) projectId: number,
    @CurrentUser() user: User,
  ) {
    return this.mappingsService.lockProjectRound(projectId, user);
  }

  /** Reopens project-level negotiation (workflow admin or owning center rep). */
  @Post('projects/:projectId/reopen')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.WORKFLOW_ADMIN, UserRole.CENTER_REP)
  @ApiOperation({
    summary: 'Reopen project negotiation (workflow admin or owning center rep)',
  })
  @ApiResponse({ status: 200, description: 'Project negotiation reopened' })
  reopenProjectRound(
    @Param('projectId', ParseIntPipe) projectId: number,
    @CurrentUser() user: User,
  ) {
    return this.mappingsService.reopenProjectRound(projectId, user);
  }

  /**
   * Bulk-promotes draft mappings to `negotiating`, marking the
   * negotiation round as live. Used after a reopen-as-draft cycle:
   * the center rep edits drafts privately, then clicks "Start
   * Negotiation" to make them visible to program reps.
   */
  @Post('projects/:projectId/start-negotiation')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.WORKFLOW_ADMIN, UserRole.CENTER_REP)
  @ApiOperation({
    summary:
      'Start (or restart) project negotiation by promoting all draft mappings to negotiating',
  })
  @ApiResponse({
    status: 200,
    description: 'Draft mappings promoted to negotiating',
  })
  @ApiResponse({
    status: 400,
    description: 'Project is locked or has no draft mappings',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden — requires workflow admin or owning center rep',
  })
  startNegotiationRound(
    @Param('projectId', ParseIntPipe) projectId: number,
    @CurrentUser() user: User,
  ) {
    return this.mappingsService.startNegotiationRound(projectId, user);
  }

  // ─── Consolidated Negotiation Page ────────────────────────────────

  /**
   * Returns the consolidated view for a project: header + lock state +
   * all active mappings with their negotiation threads. Single call that
   * powers the consolidated negotiation page.
   */
  @Get('projects/:projectId/consolidated')
  @ApiOperation({ summary: 'Get consolidated negotiation view for a project' })
  @ApiResponse({ status: 200, description: 'Consolidated project view' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  getConsolidatedView(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.mappingsService.getConsolidatedView(projectId);
  }

  /**
   * Inline update of a mapping's allocation percentage. Resets agreement
   * flags, appends a counter_proposed audit event, and transitions any
   * previously-agreed mapping back to negotiating.
   */
  @Patch(':id/allocation')
  @Roles(UserRole.WORKFLOW_ADMIN, UserRole.CENTER_REP, UserRole.PROGRAM_REP)
  @ApiOperation({ summary: 'Update a mapping allocation percentage' })
  @ApiResponse({ status: 200, description: 'Allocation updated' })
  @ApiResponse({ status: 403, description: 'Forbidden or project locked' })
  updateAllocation(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateAllocationDto,
    @CurrentUser() user: User,
  ) {
    return this.mappingsService.updateAllocation(id, dto, user);
  }

  /**
   * Adds a program to a project from the consolidated page. URL-scoped
   * alias of create(); rejects when the project is locked or a non-removed
   * mapping already exists for (projectId, programId).
   */
  @Post('projects/:projectId/add-program')
  @Roles(UserRole.WORKFLOW_ADMIN, UserRole.CENTER_REP)
  @ApiOperation({
    summary: 'Add a program to a project (workflow admin or owning center rep)',
  })
  @ApiResponse({ status: 201, description: 'Mapping created' })
  @ApiResponse({ status: 403, description: 'Forbidden or project locked' })
  @ApiResponse({ status: 409, description: 'Duplicate project+program' })
  addProgram(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Body() dto: AddProgramDto,
    @CurrentUser() user: User,
  ) {
    return this.mappingsService.addProgramToProject(
      projectId,
      dto.programId,
      dto.allocationPercentage,
      dto.complementarityRating,
      dto.efficiencyRating,
      user,
    );
  }

  /**
   * Posts a free-text chat message on the project's consolidated
   * negotiation thread. Returns the created message as a
   * `ConsolidatedEvent` so the UI can append it directly without a
   * re-fetch of the full view.
   */
  @Post('projects/:projectId/chat')
  @Roles(UserRole.WORKFLOW_ADMIN, UserRole.CENTER_REP, UserRole.PROGRAM_REP)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Post a chat message on a project negotiation (workflow admin, owning center rep, or participating program rep)',
  })
  @ApiResponse({ status: 201, description: 'Chat message posted' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden — not a participant, or project is locked',
  })
  @ApiResponse({ status: 404, description: 'Project not found' })
  postChatMessage(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Body() dto: PostChatMessageDto,
    @CurrentUser() user: User,
  ) {
    return this.mappingsService.postChatMessage(projectId, dto.message, user);
  }
}
