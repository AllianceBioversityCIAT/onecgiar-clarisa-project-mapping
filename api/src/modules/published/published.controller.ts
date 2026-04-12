import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PublishedService } from './published.service';
import { CreateSnapshotDto } from './dto/create-snapshot.dto';
import { PublishedProjectQueryDto } from './dto/published-project-query.dto';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { User } from '../users/entities/user.entity';

@ApiTags('Published')
@ApiBearerAuth('access-token')
@Controller('published')
export class PublishedController {
  constructor(private readonly publishedService: PublishedService) {}

  @Post('snapshots')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Create a new published snapshot from current data',
  })
  create(@CurrentUser() user: User, @Body() dto: CreateSnapshotDto) {
    return this.publishedService.createSnapshot(user.id, dto);
  }

  @Get('snapshots')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'List all published snapshots' })
  listSnapshots() {
    return this.publishedService.listSnapshots();
  }

  @Get('latest')
  @Public()
  @ApiOperation({ summary: 'Get the latest active snapshot metadata' })
  async getLatest() {
    const snapshot = await this.publishedService.getLatestSnapshot();
    if (!snapshot) {
      return null;
    }
    return snapshot;
  }

  @Get('latest/projects')
  @Public()
  @ApiOperation({
    summary: 'Get paginated published projects from the active snapshot',
  })
  async getLatestProjects(@Query() query: PublishedProjectQueryDto) {
    const snapshot = await this.publishedService.getLatestSnapshot();
    if (!snapshot) {
      return { data: [], total: 0, page: query.page, limit: query.limit };
    }
    return this.publishedService.getPublishedProjects(snapshot.id, query);
  }
}
