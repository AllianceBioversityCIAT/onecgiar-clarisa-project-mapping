import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClarisaService } from '../clarisa/clarisa.service';
import { Center } from './entities/center.entity';
import { Program } from './entities/program.entity';
import { Country } from './entities/country.entity';
import { ActionArea } from './entities/action-area.entity';
import { CenterResponseDto } from './dto/center-response.dto';
import { ProgramResponseDto } from './dto/program-response.dto';
import { CountryResponseDto } from './dto/country-response.dto';
import { ActionAreaResponseDto } from './dto/action-area-response.dto';
import { SyncResultDto } from './dto/sync-result.dto';
import { AuditService } from '../audit/audit.service';
import { AuditEntityType } from '../audit/entities/audit-event.entity';
import { ActorRole } from '../mappings/enums/actor-role.enum';

/** Cache entry with data payload and expiry timestamp. */
interface CacheEntry<T> {
  data: T;
  expiry: number;
}

/** Cache time-to-live: 5 minutes in milliseconds. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Service responsible for syncing CLARISA reference data into local
 * database tables and serving cached query results via REST endpoints.
 *
 * On application startup the service checks whether the `centers` table
 * is empty. If so it triggers a full sync to seed all reference tables
 * from the CLARISA API.
 */
@Injectable()
export class ReferenceDataService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReferenceDataService.name);

  /** Simple in-memory cache with 5-minute TTL. */
  private cache = new Map<string, CacheEntry<any>>();

  constructor(
    @InjectRepository(Center)
    private readonly centerRepo: Repository<Center>,
    @InjectRepository(Program)
    private readonly programRepo: Repository<Program>,
    @InjectRepository(Country)
    private readonly countryRepo: Repository<Country>,
    @InjectRepository(ActionArea)
    private readonly actionAreaRepo: Repository<ActionArea>,
    private readonly clarisaService: ClarisaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Lifecycle hook: seed reference data on first startup when the
   * local tables are empty.
   */
  async onApplicationBootstrap(): Promise<void> {
    const centerCount = await this.centerRepo.count();
    if (centerCount === 0) {
      this.logger.log(
        'Reference data tables are empty — running initial CLARISA sync',
      );
      try {
        const result = await this.syncAll();
        this.logger.log(
          `Initial sync complete: ${JSON.stringify(result)}`,
        );
      } catch (error) {
        this.logger.error(
          `Initial CLARISA sync failed: ${error.message}`,
          error.stack,
        );
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────
  //  Sync operations
  // ──────────────────────────────────────────────────────────────────

  /**
   * Admin-triggered CLARISA sync. Wraps `syncAll()` and writes an audit
   * row with the per-entity counts so the admin log captures both
   * "who clicked sync" (resolved from request context) and what arrived
   * from CLARISA. Bootstrap-time `syncAll()` calls remain unaudited
   * because they have no actor context — they'd produce a bare SYSTEM
   * row on every cold start, which is just noise.
   */
  async manualSync(): Promise<SyncResultDto> {
    const result = await this.syncAll();

    const totalEntities =
      result.centers +
      result.programs +
      result.countries +
      result.actionAreas;

    await this.auditService.record({
      entityType: AuditEntityType.CLARISA_SYNC,
      entityId: null,
      action: 'clarisa.sync',
      summary: `Synced ${totalEntities} CLARISA entities`,
      changes: {
        counts: { before: null, after: result },
      },
      /* The admin endpoint runs inside an authenticated request, so the
       * default actor resolution from RequestContextService will populate
       * the row correctly. We pass an explicit SYSTEM override only when
       * the resolver returns nothing (e.g. CLI bootstrap reuse). Here we
       * trust the request context since the route is admin-gated. */
      actorOverride: undefined,
    });

    return result;
  }

  /**
   * Fetch all reference data from CLARISA and upsert into local tables.
   * Returns a summary with the count of records synced per entity type.
   */
  async syncAll(): Promise<SyncResultDto> {
    const now = new Date();

    const [centersCount, programsCount, countriesCount, actionAreasCount] =
      await Promise.all([
        this.syncCenters(now),
        this.syncPrograms(now),
        this.syncCountries(now),
        this.syncActionAreas(now),
      ]);

    /* Invalidate all caches after sync so next read picks up fresh data. */
    this.cache.clear();

    return {
      centers: centersCount,
      programs: programsCount,
      countries: countriesCount,
      actionAreas: actionAreasCount,
    };
  }

  /** Sync centers from CLARISA into the local `centers` table. */
  private async syncCenters(syncedAt: Date): Promise<number> {
    const items = await this.clarisaService.getCenters();
    this.logger.log(`Syncing ${items.length} centers from CLARISA`);

    for (const item of items) {
      let entity = await this.centerRepo.findOne({
        where: { clarisaId: item.institutionId },
      });
      if (!entity) {
        entity = this.centerRepo.create();
        entity.clarisaId = item.institutionId;
      }
      entity.code = item.code;
      entity.name = item.name;
      entity.acronym = item.acronym;
      entity.institutionId = item.institutionId;
      entity.syncedAt = syncedAt;
      await this.centerRepo.save(entity);
    }

    return items.length;
  }

  /**
   * Sync programs from CLARISA /api/cgiar-entities?version=2.
   * Uses the `code` field (e.g. "SP01") as the unique officialCode
   * and a hash of the code as the clarisaId (since this endpoint
   * doesn't provide a numeric ID).
   */
  private async syncPrograms(syncedAt: Date): Promise<number> {
    const items = await this.clarisaService.getPrograms();
    this.logger.log(`Syncing ${items.length} programs from CLARISA`);

    for (const item of items) {
      /* Use officialCode as the lookup key since cgiar-entities has no numeric id */
      let entity = await this.programRepo.findOne({
        where: { officialCode: item.code },
      });
      if (!entity) {
        /* Generate a stable numeric id from the code for the clarisaId column */
        entity = this.programRepo.create();
        entity.clarisaId = this.hashCode(item.code);
      }
      entity.officialCode = item.code;
      entity.name = (item.name || '').trim();
      entity.syncedAt = syncedAt;
      await this.programRepo.save(entity);
    }

    return items.length;
  }

  /** Simple string hash to generate a stable numeric ID from a code string. */
  private hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  /** Sync countries from CLARISA into the local `countries` table. */
  private async syncCountries(syncedAt: Date): Promise<number> {
    const items = await this.clarisaService.getCountries();
    this.logger.log(`Syncing ${items.length} countries from CLARISA`);

    for (const item of items) {
      let entity = await this.countryRepo.findOne({
        where: { clarisaId: item.code },
      });
      if (!entity) {
        entity = this.countryRepo.create();
        entity.clarisaId = item.code;
      }
      entity.isoAlpha2 = item.isoAlpha2;
      entity.isoAlpha3 = item.isoAlpha3;
      entity.name = item.name;
      entity.region = item.regionDTO?.name ?? '';
      entity.syncedAt = syncedAt;
      await this.countryRepo.save(entity);
    }

    return items.length;
  }

  /** Sync action areas from CLARISA into the local `action_areas` table. */
  private async syncActionAreas(syncedAt: Date): Promise<number> {
    const items = await this.clarisaService.getActionAreas();
    this.logger.log(`Syncing ${items.length} action areas from CLARISA`);

    for (const item of items) {
      let entity = await this.actionAreaRepo.findOne({
        where: { clarisaId: item.id },
      });
      if (!entity) {
        entity = this.actionAreaRepo.create();
        entity.clarisaId = item.id;
      }
      entity.name = item.name;
      entity.description = item.description;
      entity.color = item.color ?? '';
      entity.syncedAt = syncedAt;
      await this.actionAreaRepo.save(entity);
    }

    return items.length;
  }

  // ──────────────────────────────────────────────────────────────────
  //  Query operations (cached)
  // ──────────────────────────────────────────────────────────────────

  /** Return all centers sorted by name, with 5-minute cache. */
  async findAllCenters(): Promise<CenterResponseDto[]> {
    return this.cached('centers', async () => {
      const entities = await this.centerRepo.find({
        order: { name: 'ASC' },
      });
      return entities.map((e) => this.toCenterDto(e));
    });
  }

  /** Return all programs sorted by name, with 5-minute cache. */
  async findAllPrograms(): Promise<ProgramResponseDto[]> {
    return this.cached('programs', async () => {
      const entities = await this.programRepo.find({
        order: { name: 'ASC' },
      });
      return entities.map((e) => this.toProgramDto(e));
    });
  }

  /** Return all countries sorted by name, with 5-minute cache. */
  async findAllCountries(): Promise<CountryResponseDto[]> {
    return this.cached('countries', async () => {
      const entities = await this.countryRepo.find({
        order: { name: 'ASC' },
      });
      return entities.map((e) => this.toCountryDto(e));
    });
  }

  /** Return all action areas, with 5-minute cache. */
  async findAllActionAreas(): Promise<ActionAreaResponseDto[]> {
    return this.cached('actionAreas', async () => {
      const entities = await this.actionAreaRepo.find({
        order: { name: 'ASC' },
      });
      return entities.map((e) => this.toActionAreaDto(e));
    });
  }

  // ──────────────────────────────────────────────────────────────────
  //  Private helpers
  // ──────────────────────────────────────────────────────────────────

  /**
   * Generic in-memory cache with a 5-minute TTL.
   * If the cache entry exists and has not expired, return it directly.
   * Otherwise execute the loader, store the result, and return it.
   */
  private async cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const entry = this.cache.get(key);
    if (entry && entry.expiry > Date.now()) {
      return entry.data as T;
    }
    const data = await loader();
    this.cache.set(key, { data, expiry: Date.now() + CACHE_TTL_MS });
    return data;
  }

  /** Map a Center entity to its public DTO. */
  private toCenterDto(entity: Center): CenterResponseDto {
    return {
      id: entity.id,
      clarisaId: entity.clarisaId,
      code: entity.code,
      name: entity.name,
      acronym: entity.acronym,
    };
  }

  /** Map a Program entity to its public DTO. */
  private toProgramDto(entity: Program): ProgramResponseDto {
    return {
      id: entity.id,
      clarisaId: entity.clarisaId,
      officialCode: entity.officialCode,
      name: entity.name,
    };
  }

  /** Map a Country entity to its public DTO. */
  private toCountryDto(entity: Country): CountryResponseDto {
    return {
      id: entity.id,
      clarisaId: entity.clarisaId,
      isoAlpha2: entity.isoAlpha2,
      isoAlpha3: entity.isoAlpha3,
      name: entity.name,
      region: entity.region,
    };
  }

  /** Map an ActionArea entity to its public DTO. */
  private toActionAreaDto(entity: ActionArea): ActionAreaResponseDto {
    return {
      id: entity.id,
      clarisaId: entity.clarisaId,
      name: entity.name,
      description: entity.description,
      color: entity.color,
    };
  }
}
