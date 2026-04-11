import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  ParseIntPipe,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from './enums/user-role.enum';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';

/**
 * Controller for user management endpoints.
 *
 * All endpoints are restricted to admin users. Provides listing
 * of all users and updating of admin-managed fields (role,
 * program/center association, active status).
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
   * Enforce role-specific constraints on program/center associations.
   *
   * These rules ensure data integrity: a program_rep without a programId
   * would have no scoping for their dashboard/mappings, and similarly
   * for center_rep without centerId.
   *
   * @throws BadRequestException if constraints are violated.
   */
  private validateRoleConstraints(dto: UpdateUserDto): void {
    const role = dto.role;

    if (role === UserRole.PROGRAM_REP) {
      if (!dto.programId) {
        throw new BadRequestException(
          'program_rep role requires a programId',
        );
      }
      if (dto.centerId) {
        throw new BadRequestException(
          'program_rep role cannot have a centerId',
        );
      }
    }

    if (role === UserRole.CENTER_REP) {
      if (!dto.centerId) {
        throw new BadRequestException(
          'center_rep role requires a centerId',
        );
      }
      if (dto.programId) {
        throw new BadRequestException(
          'center_rep role cannot have a programId',
        );
      }
    }

    if (role === UserRole.ADMIN) {
      if (dto.programId) {
        throw new BadRequestException(
          'admin role should not have a programId',
        );
      }
      if (dto.centerId) {
        throw new BadRequestException(
          'admin role should not have a centerId',
        );
      }
    }
  }
}
