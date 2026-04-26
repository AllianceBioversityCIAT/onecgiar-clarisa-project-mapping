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
} from '@nestjs/swagger';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { ProjectQueryDto } from './dto/project-query.dto';
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
   */
  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update a project (admin only)' })
  @ApiResponse({ status: 200, description: 'Project updated successfully' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 403, description: 'Forbidden — requires admin role' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 409, description: 'Duplicate project code' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateProjectDto) {
    return this.projectsService.update(id, dto);
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
