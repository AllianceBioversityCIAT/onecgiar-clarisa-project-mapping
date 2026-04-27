import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  ParseIntPipe,
  NotFoundException,
} from '@nestjs/common';
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
@Controller('published')
export class PublishedController {
  constructor(private readonly publishedService: PublishedService) {}

  @Post('snapshots')
  @Roles(UserRole.ADMIN, UserRole.UNIT_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create a new published snapshot from current data',
  })
  create(@CurrentUser() user: User, @Body() dto: CreateSnapshotDto) {
    return this.publishedService.createSnapshot(user, dto);
  }

  @Get('snapshots')
  @Roles(UserRole.ADMIN, UserRole.UNIT_ADMIN)
  @ApiBearerAuth('access-token')
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

  @Get('latest/projects/:id')
  @Public()
  @ApiOperation({
    summary: 'Get a single published project by ID from the active snapshot',
  })
  async getLatestProjectById(@Param('id', ParseIntPipe) id: number) {
    const snapshot = await this.publishedService.getLatestSnapshot();
    if (!snapshot) {
      throw new NotFoundException('No published snapshot available');
    }
    const project = await this.publishedService.getPublishedProjectById(
      snapshot.id,
      id,
    );
    if (!project) {
      throw new NotFoundException('Published project not found');
    }
    return project;
  }
}
