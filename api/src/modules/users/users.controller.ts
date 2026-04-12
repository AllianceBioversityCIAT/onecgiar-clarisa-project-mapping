import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  ParseIntPipe,
  BadRequestException,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from './enums/user-role.enum';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { User } from './entities/user.entity';

/**
 * Controller for user management endpoints.
 *
 * All endpoints are restricted to admin users. Provides listing,
 * creation, update, and soft-deletion of user records. Cross-field
 * role constraints (program_rep → programId, center_rep → centerId,
 * admin → neither) are enforced here so `POST` and `PATCH` share one
 * rule set.
 */
@ApiTags('Users')
@ApiBearerAuth('access-token')
@Controller('users')
export class UsersController {
  private readonly logger = new Logger(UsersController.name);

  constructor(private readonly usersService: UsersService) {}

  /**
   * Return all users with their program and center relations loaded.
   * Admin only.
   */
  @Get()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'List all users (admin only)' })
  async findAll(): Promise<User[]> {
    return this.usersService.findAllWithRelations();
  }

  /**
   * Create (pre-provision) a user by email.
   *
   * The resulting record has `cognitoSub = null`; the user is matched
   * on first Cognito login via `upsertFromCognito` and the Cognito sub
   * is backfilled at that point.
   *
   * Returns the hydrated user (with `program`/`center`) so the admin UI
   * can push the new row into its table without a follow-up fetch.
   */
  @Post()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Create (pre-provision) a user (admin only)' })
  @ApiResponse({ status: 201, description: 'User created successfully' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 409, description: 'Email already in use' })
  async create(@Body() dto: CreateUserDto): Promise<User> {
    this.validateRoleConstraints(dto);

    this.logger.log(`Admin creating user: ${dto.email}`);
    return this.usersService.createUser(dto);
  }

  /**
   * Update admin-managed fields on a user record.
   *
   * Validates cross-field constraints:
   * - program_rep must have programId, cannot have centerId
   * - center_rep must have centerId, cannot have programId
   * - admin should have neither programId nor centerId
   */
  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update user role/associations (admin only)' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
  ): Promise<User> {
    this.validateRoleConstraints(dto);

    this.logger.log(`Admin updating user ${id}: ${JSON.stringify(dto)}`);
    return this.usersService.updateUser(id, dto);
  }

  /**
   * Soft-delete (deactivate) a user.
   *
   * The row is not removed — `isActive` is flipped to `false` so audit
   * pointers (projects.created_by, project_mappings.submitted_by /
   * reviewed_by) remain valid. An admin cannot deactivate themselves;
   * the service raises 403 in that case.
   */
  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deactivate a user (admin only, soft delete)' })
  @ApiResponse({ status: 200, description: 'User deactivated' })
  @ApiResponse({ status: 403, description: 'Cannot deactivate own account' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() actor: User,
  ): Promise<{ id: number; isActive: false }> {
    this.logger.log(`Admin ${actor.id} deactivating user ${id}`);
    return this.usersService.softDelete(id, actor.id);
  }

  /**
   * Enforce role-specific constraints on program/center associations.
   *
   * These rules ensure data integrity: a program_rep without a programId
   * would have no scoping for their dashboard/mappings, and similarly
   * for center_rep without centerId.
   *
   * Shared between `create` (POST) and `update` (PATCH) so both
   * endpoints always validate the same way.
   *
   * @throws BadRequestException if constraints are violated.
   */
  private validateRoleConstraints(dto: CreateUserDto | UpdateUserDto): void {
    const role = dto.role;

    if (role === UserRole.PROGRAM_REP) {
      if (!dto.programId) {
        throw new BadRequestException('program_rep role requires a programId');
      }
      if (dto.centerId) {
        throw new BadRequestException(
          'program_rep role cannot have a centerId',
        );
      }
    }

    if (role === UserRole.CENTER_REP) {
      if (!dto.centerId) {
        throw new BadRequestException('center_rep role requires a centerId');
      }
      if (dto.programId) {
        throw new BadRequestException(
          'center_rep role cannot have a programId',
        );
      }
    }

    if (role === UserRole.ADMIN) {
      if (dto.programId) {
        throw new BadRequestException('admin role should not have a programId');
      }
      if (dto.centerId) {
        throw new BadRequestException('admin role should not have a centerId');
      }
    }
  }
}
