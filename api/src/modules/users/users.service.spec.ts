/**
 * Unit tests for UsersService.
 *
 * All repository dependencies are mocked; these tests exercise the
 * service's decision logic in isolation. Integration coverage (real
 * database writes, HTTP flow) lives in `api/test/users.e2e-spec.ts`.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { UsersService } from './users.service';
import { User } from './entities/user.entity';
import { UserRole } from './enums/user-role.enum';
import { Program } from '../reference-data/entities/program.entity';
import { Center } from '../reference-data/entities/center.entity';
import { CreateUserDto } from './dto/create-user.dto';

/**
 * Factory for a minimal User entity with sane defaults. Individual
 * tests override only the fields they care about.
 */
function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    cognitoSub: 'cognito-sub-1',
    email: 'user@example.com',
    firstName: 'First',
    lastName: 'Last',
    role: null,
    program: null,
    programId: null,
    center: null,
    centerId: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as User;
}

describe('UsersService', () => {
  let service: UsersService;
  let usersRepo: jest.Mocked<Repository<User>>;
  let programsRepo: jest.Mocked<Repository<Program>>;
  let centersRepo: jest.Mocked<Repository<Center>>;

  beforeEach(async () => {
    /* Each test gets a fresh module so jest.fn call counts are isolated. */
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
            create: jest.fn((obj) => obj),
            save: jest.fn(async (obj) => obj),
            update: jest.fn(async () => ({ affected: 1 })),
          },
        },
        {
          provide: getRepositoryToken(Program),
          useValue: { findOne: jest.fn() },
        },
        {
          provide: getRepositoryToken(Center),
          useValue: { findOne: jest.fn() },
        },
      ],
    }).compile();

    service = moduleRef.get(UsersService);
    usersRepo = moduleRef.get(getRepositoryToken(User));
    programsRepo = moduleRef.get(getRepositoryToken(Program));
    centersRepo = moduleRef.get(getRepositoryToken(Center));
  });

  /* ------------------------------------------------------------------ */
  /* createUser()                                                        */
  /* ------------------------------------------------------------------ */

  describe('createUser()', () => {
    it('creates a user with cognitoSub=null on a fresh email', async () => {
      /* First findOne() -> duplicate check (no row).
       * Second findOne() -> relations reload after save. */
      const hydrated = makeUser({
        id: 42,
        email: 'new@example.com',
        cognitoSub: null,
      });
      usersRepo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(hydrated);
      usersRepo.save.mockResolvedValueOnce(hydrated);

      const dto: CreateUserDto = {
        email: 'new@example.com',
        firstName: 'New',
        lastName: 'User',
      };

      const result = await service.createUser(dto);

      expect(usersRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'new@example.com',
          firstName: 'New',
          lastName: 'User',
          cognitoSub: null,
          isActive: true,
          role: null,
          programId: null,
          centerId: null,
        }),
      );
      expect(usersRepo.save).toHaveBeenCalledTimes(1);
      expect(result).toBe(hydrated);
    });

    it('throws ConflictException when email already exists', async () => {
      usersRepo.findOne.mockResolvedValueOnce(makeUser({ id: 7 }));

      await expect(
        service.createUser({
          email: 'taken@example.com',
          firstName: 'Dup',
          lastName: 'Dup',
        }),
      ).rejects.toThrow(ConflictException);
      expect(usersRepo.save).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when programId does not exist', async () => {
      usersRepo.findOne.mockResolvedValueOnce(null); // duplicate check passes
      programsRepo.findOne.mockResolvedValueOnce(null); // program missing

      await expect(
        service.createUser({
          email: 'pm@example.com',
          firstName: 'P',
          lastName: 'M',
          role: UserRole.PROGRAM_REP,
          programId: 999,
        }),
      ).rejects.toThrow(NotFoundException);
      expect(usersRepo.save).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when centerId does not exist', async () => {
      usersRepo.findOne.mockResolvedValueOnce(null);
      centersRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.createUser({
          email: 'cr@example.com',
          firstName: 'C',
          lastName: 'R',
          role: UserRole.CENTER_REP,
          centerId: 999,
        }),
      ).rejects.toThrow(NotFoundException);
      expect(usersRepo.save).not.toHaveBeenCalled();
    });
  });

  /* ------------------------------------------------------------------ */
  /* softDelete()                                                        */
  /* ------------------------------------------------------------------ */

  describe('softDelete()', () => {
    it('sets isActive=false on the target user and returns the id', async () => {
      const target = makeUser({ id: 10, email: 'victim@example.com' });
      usersRepo.findOne.mockResolvedValueOnce(target);

      const result = await service.softDelete(10, 1);

      expect(usersRepo.update).toHaveBeenCalledWith(10, { isActive: false });
      expect(result).toEqual({ id: 10, isActive: false });
    });

    it('throws NotFoundException when the target user does not exist', async () => {
      usersRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.softDelete(999, 1)).rejects.toThrow(
        NotFoundException,
      );
      expect(usersRepo.update).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when admin tries to deactivate self', async () => {
      const me = makeUser({ id: 5, email: 'me@example.com' });
      usersRepo.findOne.mockResolvedValueOnce(me);

      await expect(service.softDelete(5, 5)).rejects.toThrow(
        ForbiddenException,
      );
      expect(usersRepo.update).not.toHaveBeenCalled();
    });
  });

  /* ------------------------------------------------------------------ */
  /* upsertFromCognito()                                                 */
  /* ------------------------------------------------------------------ */

  describe('upsertFromCognito()', () => {
    it('backfills cognito_sub when email matches a pre-provisioned row (cognito_sub IS NULL)', async () => {
      const pending = makeUser({
        id: 20,
        email: 'pending@example.com',
        cognitoSub: null,
        firstName: 'Admin-Set',
        lastName: 'Name',
      });

      /* First lookup is by cognito sub — no hit.
       * Second lookup is by email — returns the pending row. */
      usersRepo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(pending);
      usersRepo.save.mockImplementation(async (u) => u as User);

      const result = await service.upsertFromCognito({
        cognitoSub: 'real-cognito-sub',
        email: 'pending@example.com',
        firstName: 'Cognito',
        lastName: 'Provided',
      });

      expect(result.cognitoSub).toBe('real-cognito-sub');
      /* Admin's names are preserved — Cognito does not overwrite them
       * on the pre-provisioned backfill path. */
      expect(result.firstName).toBe('Admin-Set');
      expect(result.lastName).toBe('Name');
      expect(usersRepo.save).toHaveBeenCalledTimes(1);
    });

    it('returns existing record unchanged when email matches a row with a different non-null cognito_sub (no takeover)', async () => {
      const existing = makeUser({
        id: 30,
        email: 'shared@example.com',
        cognitoSub: 'original-sub',
        firstName: 'Original',
        lastName: 'Owner',
      });

      usersRepo.findOne
        .mockResolvedValueOnce(null) // no sub match
        .mockResolvedValueOnce(existing); // email match with different sub

      const result = await service.upsertFromCognito({
        cognitoSub: 'attacker-sub',
        email: 'shared@example.com',
        firstName: 'Attacker',
        lastName: 'Name',
      });

      /* Record must come back unmodified in memory AND not persisted. */
      expect(result.cognitoSub).toBe('original-sub');
      expect(result.firstName).toBe('Original');
      expect(result.lastName).toBe('Owner');
      expect(usersRepo.save).not.toHaveBeenCalled();
    });

    it('updates email/name when an existing row matches by cognito sub', async () => {
      const existing = makeUser({
        id: 40,
        email: 'old@example.com',
        cognitoSub: 'stable-sub',
        firstName: 'Old',
        lastName: 'Name',
      });
      usersRepo.findOne.mockResolvedValueOnce(existing);
      usersRepo.save.mockImplementation(async (u) => u as User);

      const result = await service.upsertFromCognito({
        cognitoSub: 'stable-sub',
        email: 'new@example.com',
        firstName: 'New',
        lastName: 'Name',
      });

      expect(result.email).toBe('new@example.com');
      expect(result.firstName).toBe('New');
      expect(result.lastName).toBe('Name');
      expect(usersRepo.save).toHaveBeenCalledTimes(1);
    });

    it('creates a new user when neither cognito sub nor email matches', async () => {
      usersRepo.findOne
        .mockResolvedValueOnce(null) // no sub match
        .mockResolvedValueOnce(null); // no email match
      usersRepo.save.mockImplementation(
        async (u) => ({ ...u, id: 99 }) as User,
      );

      const result = await service.upsertFromCognito({
        cognitoSub: 'brand-new-sub',
        email: 'brand@example.com',
        firstName: 'Brand',
        lastName: 'New',
      });

      expect(usersRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          cognitoSub: 'brand-new-sub',
          email: 'brand@example.com',
          firstName: 'Brand',
          lastName: 'New',
        }),
      );
      expect(result.id).toBe(99);
    });
  });
});
