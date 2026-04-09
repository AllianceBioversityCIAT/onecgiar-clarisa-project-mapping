import { Controller, Get, Logger } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import {
  DashboardService,
  AdminSummary,
  ProgramRepSummary,
  CenterRepSummary,
  AllocationStatusItem,
  RecentActivityItem,
} from './dashboard.service';

/**
 * Controller for dashboard aggregation endpoints.
 *
 * All endpoints are role-aware: the response shape and data scope
 * depend on the authenticated user's role and associated center/program.
 * Results are cached per-user for 2 minutes.
 */
@ApiTags('Dashboard')
@ApiBearerAuth('access-token')
@Controller('dashboard')
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
  @ApiOperation({ summary: 'Project allocation progress (top 50, least allocated first)' })
  async getAllocationStatus(
    @CurrentUser() user: User,
  ): Promise<AllocationStatusItem[]> {
    this.logger.debug(`Allocation status requested by user ${user.id}`);
    return this.dashboardService.getAllocationStatus(user);
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
}
