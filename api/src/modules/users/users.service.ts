import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { UserRole } from './enums/user-role.enum';

/**
 * Payload accepted by {@link UsersService.upsertFromCognito}.
 */
export interface CognitoUpsertPayload {
  cognitoSub: string;
  email: string;
  firstName: string;
  lastName: string;
}

/**
 * Fields an administrator can update on a user record.
 */
export interface AdminUpdatePayload {
  role?: UserRole | null;
  programId?: string | null;
  centerId?: string | null;
  isActive?: boolean;
}

/**
 * Service responsible for user CRUD operations.
 *
 * Users are provisioned automatically on first Cognito login and managed
 * by administrators for role/program/center assignment.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  /**
   * Find a user by their AWS Cognito `sub` identifier.
   *
   * @param sub - The Cognito `sub` claim value.
   * @returns The matching user or `null` if not found.
   */
  async findByCognitoSub(sub: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { cognitoSub: sub } });
  }

  /**
   * Find a user by their internal UUID.
   *
   * @param id - The user UUID primary key.
   * @returns The matching user or `null` if not found.
   */
  async findById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  /**
   * Return all users in the system.
   *
   * @returns An array of all user records.
   */
  async findAll(): Promise<User[]> {
    return this.usersRepository.find();
  }

  /**
   * Return all users with their program and center relations eagerly loaded.
   *
   * Used by the admin user-management endpoint to display association
   * details without additional queries.
   *
   * @returns An array of all user records with relations.
   */
  async findAllWithRelations(): Promise<User[]> {
    return this.usersRepository.find({
      relations: ['program', 'center'],
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Create a user record on first Cognito login, or update the email and
   * name fields if the user already exists.
   *
   * This method intentionally does **not** set the `role` field -- role
   * assignment is an admin-only action performed via {@link updateUser}.
   *
   * @param payload - Cognito token claims (sub, email, first/last name).
   * @returns The created or updated user entity.
   */
  async upsertFromCognito(payload: CognitoUpsertPayload): Promise<User> {
    const { cognitoSub, email, firstName, lastName } = payload;

    let user = await this.findByCognitoSub(cognitoSub);

    if (user) {
      user.email = email;
      user.firstName = firstName;
      user.lastName = lastName;
      user = await this.usersRepository.save(user);
      this.logger.log(`Updated existing user from Cognito: ${user.id}`);
    } else {
      user = this.usersRepository.create({
        cognitoSub,
        email,
        firstName,
        lastName,
      });
      user = await this.usersRepository.save(user);
      this.logger.log(`Created new user from Cognito: ${user.id}`);
    }

    return user;
  }

  /**
   * Update admin-managed fields on a user record (role, program, center,
   * active status).
   *
   * @param id      - The user UUID to update.
   * @param updates - Partial object with fields to change.
   * @returns The updated user entity.
   * @throws NotFoundException if no user exists with the given ID.
   */
  async updateUser(id: string, updates: AdminUpdatePayload): Promise<User> {
    const user = await this.findById(id);

    if (!user) {
      throw new NotFoundException(`User with ID "${id}" not found`);
    }

    Object.assign(user, updates);
    const saved = await this.usersRepository.save(user);
    this.logger.log(`Admin updated user ${id}: ${JSON.stringify(updates)}`);
    return saved;
  }
}
