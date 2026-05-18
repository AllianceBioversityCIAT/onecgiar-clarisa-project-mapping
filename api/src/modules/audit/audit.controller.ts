import {
  BadRequestException,
  Controller,
  Get,
  HttpStatus,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { User } from '../users/entities/user.entity';
import { AuditService } from './audit.service';
import { AuditQueryDto } from './dto/audit-query.dto';

/**
 * REST controller for the unified audit log.
 *
 * Read-only by design. Audit rows are written ONLY via
 * `AuditService.record()` invoked from other feature services — there is
 * no public mutation surface here. POST/PATCH/DELETE endpoints would
 * compromise the append-only contract and are deliberately omitted.
 *
 * Authentication: enforced globally by `JwtAuthGuard` (registered as an
 * `APP_GUARD` in `AppModule`). Authorisation: enforced globally by
 * `RolesGuard` (also `APP_GUARD`); the class-level `@Roles(...)` decorator
 * here whitelists the three roles that may read audit data. Per-row
 * visibility scoping (e.g. unit_admin sees only their own + project metadata
 * events) is applied inside `AuditService.query()` / `findOne()`.
 */
@ApiTags('audit')
@ApiBearerAuth('access-token')
@Controller('audit')
@Roles(UserRole.ADMIN, UserRole.WORKFLOW_ADMIN, UserRole.UNIT_ADMIN)
export class AuditController {
  /** Default page size when the caller omits `limit`. Mirrors the service default. */
  private static readonly DEFAULT_LIMIT = 50;

  /** Default page number when the caller omits `page`. */
  private static readonly DEFAULT_PAGE = 1;

  constructor(private readonly auditService: AuditService) {}

  /**
   * Distinct list of action verbs ever recorded.
   *
   * Mounted BEFORE `:id` so Nest matches the literal `/audit/actions`
   * path instead of routing it through the dynamic id handler.
   */
  @Get('actions')
  @ApiOperation({
    summary: 'Distinct list of audit action verbs (for filter dropdowns)',
  })
  @ApiOkResponse({
    description: 'Array of action verb strings, alphabetically sorted.',
    schema: { type: 'array', items: { type: 'string' } },
  })
  async getActions(): Promise<string[]> {
    return this.auditService.getDistinctActions();
  }

  /**
   * Paginated, filtered, role-scoped list of audit events.
   *
   * Defaults applied here (page=1, limit=50) mirror the service-side
   * defaults for clarity in the API response shape — the service still
   * clamps them defensively.
   */
  @Get()
  @ApiOperation({
    summary:
      'Paginated audit log feed (admin sees all; workflow_admin sees project/mapping/snapshot; unit_admin sees own + project metadata)',
  })
  @ApiOkResponse({
    description: 'Paginated audit events with total count.',
  })
  async list(
    @Query() query: AuditQueryDto,
    @CurrentUser() user: User,
  ): Promise<{
    items: Awaited<ReturnType<AuditService['query']>>['items'];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = query.page ?? AuditController.DEFAULT_PAGE;
    const limit = query.limit ?? AuditController.DEFAULT_LIMIT;

    // The DTO instance is structurally compatible with AuditQueryFilters —
    // pass it through with the defaults filled in so the response can echo
    // the effective page/limit back to the caller.
    const { items, total } = await this.auditService.query(
      { ...query, page, limit },
      user.role as UserRole,
      user.id,
    );

    return { items, total, page, limit };
  }

  /**
   * Single audit row by ID. BIGINT primary keys are stringly-typed at the
   * TypeORM layer to avoid JS number-precision loss; we keep that
   * stringification all the way through and hand the raw string to the
   * service. Numeric format is validated here so non-digit input is
   * rejected with 400 before it reaches the SQL layer.
   *
   * Returns 404 when the row does not exist OR when the caller is not
   * permitted to see it — `findOne()` returns null for both cases on
   * purpose, so we never leak existence to unauthorised readers.
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get a single audit event by ID' })
  @ApiParam({
    name: 'id',
    type: 'string',
    description: 'Audit event ID (numeric BIGINT)',
  })
  @ApiOkResponse({ description: 'Audit event row.' })
  async findOne(@Param('id') id: string, @CurrentUser() user: User) {
    if (!/^\d+$/.test(id)) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Audit event id must be a positive integer',
      });
    }

    const event = await this.auditService.findOne(
      id,
      user.role as UserRole,
      user.id,
    );

    if (!event) {
      throw new NotFoundException(`Audit event ${id} not found`);
    }
    return event;
  }
}
