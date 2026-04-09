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
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { MappingsService } from './mappings.service';
import { CreateMappingDto } from './dto/create-mapping.dto';
import { UpdateMappingDto } from './dto/update-mapping.dto';
import { MappingQueryDto } from './dto/mapping-query.dto';
import { RejectMappingDto } from './dto/reject-mapping.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { User } from '../users/entities/user.entity';

/**
 * REST controller for project-to-program mapping operations.
 *
 * Handles the full mapping lifecycle: creation by program representatives,
 * querying with role-based filtering, updates, deletions, and the
 * center approval workflow (approve/reject).
 */
@ApiTags('mappings')
@ApiBearerAuth('access-token')
@Controller('mappings')
export class MappingsController {
  constructor(private readonly mappingsService: MappingsService) {}

  /**
   * Retrieves a paginated list of mappings.
   * Results are scoped by the authenticated user's role.
   */
  @Get()
  @ApiOperation({ summary: 'List mappings with pagination, filters, and role-based scoping' })
  @ApiResponse({ status: 200, description: 'Paginated list of mappings' })
  findAll(@Query() query: MappingQueryDto, @CurrentUser() user: User) {
    return this.mappingsService.findAll(query, user);
  }

  /**
   * Retrieves the allocation summary for a specific project.
   * Shows total allocated, remaining, and per-program breakdown.
   */
  @Get('projects/:projectId/allocation')
  @ApiOperation({ summary: 'Get allocation summary for a project' })
  @ApiResponse({ status: 200, description: 'Project allocation summary' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  getAllocationSummary(@Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.mappingsService.getAllocationSummary(projectId);
  }

  /**
   * Retrieves the review summary for a project (all mappings with details).
   * Restricted to admin and center representatives.
   */
  @Get('projects/:projectId/review-summary')
  @Roles(UserRole.ADMIN, UserRole.CENTER_REP)
  @ApiOperation({ summary: 'Get review summary for a project (admin/center rep)' })
  @ApiResponse({ status: 200, description: 'Project review summary' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  getReviewSummary(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: User,
  ) {
    return this.mappingsService.getReviewSummary(projectId, user);
  }

  /**
   * Retrieves a single mapping by UUID.
   * Access is validated based on the user's role.
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get a mapping by ID' })
  @ApiResponse({ status: 200, description: 'The mapping' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Mapping not found' })
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User) {
    return this.mappingsService.findOne(id, user);
  }

  /**
   * Creates a new project-to-program mapping.
   * Restricted to program representatives. The program is inferred
   * from the authenticated user's profile.
   */
  @Post()
  @Roles(UserRole.PROGRAM_REP)
  @ApiOperation({ summary: 'Create a mapping (program rep only)' })
  @ApiResponse({ status: 201, description: 'Mapping created successfully' })
  @ApiResponse({ status: 400, description: 'Validation error or allocation exceeds 100%' })
  @ApiResponse({ status: 403, description: 'Forbidden — requires program_rep role' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 409, description: 'Duplicate mapping for project+program' })
  create(@Body() dto: CreateMappingDto, @CurrentUser() user: User) {
    return this.mappingsService.create(dto, user);
  }

  /**
   * Updates an existing mapping.
   * Only the submitter can update, and only while the mapping is pending or rejected.
   */
  @Patch(':id')
  @Roles(UserRole.PROGRAM_REP)
  @ApiOperation({ summary: 'Update a mapping (submitter only, pending/rejected status)' })
  @ApiResponse({ status: 200, description: 'Mapping updated successfully' })
  @ApiResponse({ status: 400, description: 'Validation error or allocation exceeds 100%' })
  @ApiResponse({ status: 403, description: 'Forbidden — not the submitter' })
  @ApiResponse({ status: 404, description: 'Mapping not found' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMappingDto,
    @CurrentUser() user: User,
  ) {
    return this.mappingsService.update(id, dto, user);
  }

  /**
   * Deletes a pending mapping.
   * Only the submitter can delete, and only while the mapping is pending.
   */
  @Delete(':id')
  @Roles(UserRole.PROGRAM_REP)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a pending mapping (submitter only)' })
  @ApiResponse({ status: 204, description: 'Mapping deleted successfully' })
  @ApiResponse({ status: 400, description: 'Mapping is not pending' })
  @ApiResponse({ status: 403, description: 'Forbidden — not the submitter' })
  @ApiResponse({ status: 404, description: 'Mapping not found' })
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User) {
    return this.mappingsService.remove(id, user);
  }

  /**
   * Approves a pending mapping.
   * Restricted to center representatives whose center owns the mapped project.
   * All allocations for the project must total 100% before approval.
   */
  @Post(':id/approve')
  @Roles(UserRole.CENTER_REP)
  @ApiOperation({ summary: 'Approve a mapping (center rep only)' })
  @ApiResponse({ status: 200, description: 'Mapping approved successfully' })
  @ApiResponse({ status: 400, description: 'Already reviewed or allocation incomplete' })
  @ApiResponse({ status: 403, description: 'Forbidden — not matching center rep' })
  @ApiResponse({ status: 404, description: 'Mapping not found' })
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User) {
    return this.mappingsService.approve(id, user);
  }

  /**
   * Rejects a pending mapping with a required reason.
   * Restricted to center representatives whose center owns the mapped project.
   */
  @Post(':id/reject')
  @Roles(UserRole.CENTER_REP)
  @ApiOperation({ summary: 'Reject a mapping (center rep only)' })
  @ApiResponse({ status: 200, description: 'Mapping rejected successfully' })
  @ApiResponse({ status: 400, description: 'Already reviewed or invalid reason' })
  @ApiResponse({ status: 403, description: 'Forbidden — not matching center rep' })
  @ApiResponse({ status: 404, description: 'Mapping not found' })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectMappingDto,
    @CurrentUser() user: User,
  ) {
    return this.mappingsService.reject(id, dto.reason, user);
  }
}
