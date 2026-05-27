import { Controller, Get, Logger, ParseIntPipe, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import {
  DashboardService,
  AdminSummary,
  ProgramRepSummary,
  CenterRepSummary,
  AllocationStatusItem,
  CenterAllocationSummary,
  ProgramAllocationSummary,
  CenterProgressItem,
  ProgramProgressItem,
  RecentActivityItem,
} from './dashboard.service';

/**
 * Controller for dashboard aggregation endpoints.
 *
 * All endpoints are role-aware: the response shape and data scope
 * depend on the authenticated user's role and associated center/program.
 */
@ApiTags('Dashboard')
@ApiBearerAuth('access-token')
@Controller('dashboard')
@Roles(UserRole.ADMIN, UserRole.PROGRAM_REP, UserRole.CENTER_REP)
export class DashboardController {
  private readonly logger = new Logger(DashboardController.name);

  constructor(private readonly dashboardService: DashboardService) {}

  /**
   * Return role-aware aggregate statistics for the dashboard.
   *
   * - Admin: system-wide totals (projects, mappings, approvals, etc.)
   * - Program Rep: own mappings breakdown and total allocation
   * - Center Rep: own center's projects and mapping review stats
   */
  @Get('summary')
  @ApiOperation({ summary: 'Role-aware dashboard summary statistics' })
  async getSummary(
    @CurrentUser() user: User,
  ): Promise<AdminSummary | ProgramRepSummary | CenterRepSummary> {
    this.logger.debug(`Dashboard summary requested by user ${user.id}`);
    return this.dashboardService.getSummary(user);
  }

  /**
   * Return projects with their allocation progress, sorted by least
   * allocated first. Admin sees all; center_rep sees own center only.
   * Limited to 50 results.
   */
  @Get('allocation-status')
  @ApiOperation({
    summary: 'Project allocation progress (top 50, least allocated first)',
  })
  async getAllocationStatus(
    @CurrentUser() user: User,
  ): Promise<AllocationStatusItem[]> {
    this.logger.debug(`Allocation status requested by user ${user.id}`);
    return this.dashboardService.getAllocationStatus(user);
  }

  /**
   * Return the center FY26 allocation summary: total budget, 90 % target,
   * per-program agreed share, and remaining gap.
   *
   * Center reps see their own center; admins may pass a `centerId` query
   * parameter to inspect any center. Returns `null` when the caller has
   * no associated center (e.g. an unscoped admin without an override).
   */
  @Get('center-allocation')
  @ApiOperation({
    summary:
      'Center FY26 allocation summary (90 % target, per-program agreed share)',
  })
  @ApiQuery({
    name: 'centerId',
    required: false,
    type: Number,
    description: 'Admin-only override to inspect a specific center.',
  })
  async getCenterAllocation(
    @CurrentUser() user: User,
    @Query('centerId', new ParseIntPipe({ optional: true }))
    centerId?: number,
  ): Promise<CenterAllocationSummary | null> {
    this.logger.debug(`Center allocation requested by user ${user.id}`);
    return this.dashboardService.getCenterAllocation(user, centerId);
  }

  /**
   * Program FY26 agreed-allocation summary, broken down per contributing
   * center — the program-rep mirror of the center-allocation widget.
   *
   * Program reps see their own program; admins may pass a `programId`
   * query parameter to inspect any program. Returns `null` when the caller
   * has no associated program (e.g. a center rep).
   */
  @Get('program-allocation')
  @ApiOperation({
    summary: 'Program FY26 agreed allocation, broken down per center',
  })
  @ApiQuery({
    name: 'programId',
    required: false,
    type: Number,
    description: 'Admin-only override to inspect a specific program.',
  })
  async getProgramAllocation(
    @CurrentUser() user: User,
    @Query('programId', new ParseIntPipe({ optional: true }))
    programId?: number,
  ): Promise<ProgramAllocationSummary | null> {
    const targetProgramId =
      user.role === UserRole.ADMIN && programId ? programId : user.programId;
    this.logger.debug(`Program allocation requested by user ${user.id}`);
    return this.dashboardService.getProgramAllocation(targetProgramId ?? null);
  }

  /**
   * Return the last 20 mapping events (creation, approval, rejection).
   * Role-filtered: admin = all, program_rep = own program,
   * center_rep = own center's projects.
   */
  @Get('recent-activity')
  @ApiOperation({ summary: 'Recent mapping activity (last 20 events)' })
  async getRecentActivity(
    @CurrentUser() user: User,
  ): Promise<RecentActivityItem[]> {
    this.logger.debug(`Recent activity requested by user ${user.id}`);
    return this.dashboardService.getRecentActivity(user);
  }

  /**
   * Admin-only: per-center progress toward the 90 % budget-allocation goal.
   * Method-level @Roles overrides the class-level list (handler wins in the
   * RolesGuard), restricting this to admins.
   */
  @Get('center-progress')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Admin: per-center progress toward 90 % budget allocation',
  })
  async getCenterProgress(
    @CurrentUser() user: User,
  ): Promise<CenterProgressItem[]> {
    this.logger.debug(`Center progress requested by admin ${user.id}`);
    return this.dashboardService.getCenterProgress();
  }

  /**
   * Admin-only: per-program progress toward the zero-open-negotiations goal.
   */
  @Get('program-progress')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Admin: per-program progress toward zero open negotiations',
  })
  async getProgramProgress(
    @CurrentUser() user: User,
  ): Promise<ProgramProgressItem[]> {
    this.logger.debug(`Program progress requested by admin ${user.id}`);
    return this.dashboardService.getProgramProgress();
  }
}
