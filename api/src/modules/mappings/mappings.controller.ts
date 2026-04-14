import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  ParseIntPipe,
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
import { RemoveMappingDto } from './dto/remove-mapping.dto';
import { MappingQueryDto } from './dto/mapping-query.dto';
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
  getAllocationSummary(
    @Param('projectId', ParseIntPipe) projectId: number,
  ) {
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
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
  ) {
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

  /** Submits a counter-proposal (center rep or program rep). */
  @Post(':id/counter-propose')
  @Roles(UserRole.CENTER_REP, UserRole.PROGRAM_REP)
  @ApiOperation({
    summary: 'Counter-propose on a mapping (center rep or program rep)',
  })
  @ApiResponse({ status: 200, description: 'Counter-proposal submitted' })
  counterPropose(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CounterProposeDto,
    @CurrentUser() user: User,
  ) {
    return this.mappingsService.counterPropose(id, dto, user);
  }

  /** Marks agreement on current terms (center rep or program rep). */
  @Post(':id/agree')
  @Roles(UserRole.CENTER_REP, UserRole.PROGRAM_REP)
  @ApiOperation({
    summary: 'Agree on current terms (center rep or program rep)',
  })
  @ApiResponse({ status: 200, description: 'Agreement recorded' })
  agree(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
  ) {
    return this.mappingsService.agree(id, user);
  }

  /** Removes a program from negotiations (center rep or program rep). */
  @Post(':id/remove')
  @Roles(UserRole.CENTER_REP, UserRole.PROGRAM_REP)
  @ApiOperation({
    summary: 'Remove program from negotiations with justification',
  })
  @ApiResponse({ status: 200, description: 'Program removed' })
  removeProgram(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RemoveMappingDto,
    @CurrentUser() user: User,
  ) {
    return this.mappingsService.removeProgram(id, dto.justification, user);
  }

  // ─── Project-Level Actions ────────────────────────────────────────

  /** Locks the project round — all agreed mappings become locked (center rep only). */
  @Post('projects/:projectId/lock')
  @Roles(UserRole.CENTER_REP)
  @ApiOperation({
    summary: 'Lock the project round (center rep only)',
  })
  @ApiResponse({ status: 200, description: 'Project round locked' })
  @ApiResponse({
    status: 400,
    description: 'Not all agreed or total != 100%',
  })
  lockProjectRound(
    @Param('projectId', ParseIntPipe) projectId: number,
    @CurrentUser() user: User,
  ) {
    return this.mappingsService.lockProjectRound(projectId, user);
  }

  /** Reopens a locked project round for re-negotiation (center rep only). */
  @Post('projects/:projectId/reopen')
  @Roles(UserRole.CENTER_REP)
  @ApiOperation({
    summary: 'Reopen a locked project round (center rep only)',
  })
  @ApiResponse({ status: 200, description: 'Project round reopened' })
  reopenProjectRound(
    @Param('projectId', ParseIntPipe) projectId: number,
    @CurrentUser() user: User,
  ) {
    return this.mappingsService.reopenProjectRound(projectId, user);
  }
}
