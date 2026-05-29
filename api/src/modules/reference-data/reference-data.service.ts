import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClarisaService } from '../clarisa/clarisa.service';
import { Center } from './entities/center.entity';
import { Program } from './entities/program.entity';
import { Country } from './entities/country.entity';
import { ActionArea } from './entities/action-area.entity';
import { TocAow } from './entities/toc-aow.entity';
import { TocOutcome } from './entities/toc-outcome.entity';
import { TocOutput } from './entities/toc-output.entity';
import { CenterResponseDto } from './dto/center-response.dto';
import { ProgramResponseDto } from './dto/program-response.dto';
import { CountryResponseDto } from './dto/country-response.dto';
import { ActionAreaResponseDto } from './dto/action-area-response.dto';
import { SyncResultDto } from './dto/sync-result.dto';
import { TocAowQueryDto } from './dto/toc-aow-query.dto';
import { TocOutcomeQueryDto } from './dto/toc-outcome-query.dto';
import { TocOutputQueryDto } from './dto/toc-output-query.dto';
import {
  TocAowListItemDto,
  TocAowRefDto,
  TocListResponseDto,
  TocOutcomeListItemDto,
  TocOutputListItemDto,
  TocProgramRefDto,
} from './dto/toc-list-response.dto';
import { TocSyncService } from './toc-sync.service';
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
    @InjectRepository(TocAow)
    private readonly tocAowRepo: Repository<TocAow>,
    @InjectRepository(TocOutcome)
    private readonly tocOutcomeRepo: Repository<TocOutcome>,
    @InjectRepository(TocOutput)
    private readonly tocOutputRepo: Repository<TocOutput>,
    private readonly clarisaService: ClarisaService,
    private readonly auditService: AuditService,
    private readonly tocSyncService: TocSyncService,
  ) {}

  /**
   * Lifecycle hook: seed reference data on first startup when the
   * local tables are empty.
   *
   * Two independent seed paths run here:
   *
   *  1. **CLARISA** — if `centers` is empty, run the full CLARISA sync.
   *  2. **TOC** — if all three TOC tables (`toc_aows`, `toc_outcomes`,
   *     `toc_outputs`) are empty, run the full TOC sync. Both paths
   *     are wrapped in try/catch so a downstream API outage cannot
   *     block app startup.
   */
  async onApplicationBootstrap(): Promise<void> {
    const centerCount = await this.centerRepo.count();
    if (centerCount === 0) {
      this.logger.log(
        'Reference data tables are empty — running initial CLARISA sync',
      );
      try {
        const result = await this.syncAll();
        this.logger.log(`Initial sync complete: ${JSON.stringify(result)}`);
      } catch (error) {
        this.logger.error(
          `Initial CLARISA sync failed: ${error.message}`,
          error.stack,
        );
      }
    }

    /* TOC bootstrap is independent of CLARISA — it depends on the
     * `programs` table being populated (so TocSyncService has codes
     * to iterate). On a cold start the CLARISA sync above will have
     * populated programs first; on a warm restart the CLARISA seed
     * is skipped but TOC may still be empty (or vice-versa). */
    const [aowCount, outcomeCount, outputCount] = await Promise.all([
      this.tocAowRepo.count(),
      this.tocOutcomeRepo.count(),
      this.tocOutputRepo.count(),
    ]);
    if (aowCount === 0 && outcomeCount === 0 && outputCount === 0) {
      this.logger.log(
        'TOC tables are empty — running initial TOC sync across all programs',
      );
      try {
        const result = await this.tocSyncService.syncAll();
        this.logger.log(
          `Initial TOC sync complete: synced=${result.synced}, failed=${result.failed}`,
        );
      } catch (error) {
        this.logger.error(
          `Initial TOC sync failed: ${(error as Error).message}`,
          (error as Error).stack,
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
      result.centers + result.programs + result.countries + result.actionAreas;

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

  // ──────────────────────────────────────────────────────────────────
  //  TOC admin viewer — paginated list endpoints
  // ──────────────────────────────────────────────────────────────────

  /**
   * Paginated AOW list for the admin TOC viewer.
   *
   * Scoping: `programId` is required, enforced by the DTO. `search`
   * matches `acronym OR wp_official_code OR name` (LIKE, OR).
   *
   * Implementation notes (CLAUDE.md rules):
   *  - QueryBuilder + `leftJoinAndSelect` for the program relation.
   *  - `.where()` / `.andWhere()` use **camelCase** property names
   *    (`aow.programId`, NOT `aow.program_id`).
   *  - `orderBy()` uses the **raw DB column name** (`aow.wp_official_code`)
   *    to dodge the TypeORM `databaseName` undefined bug with
   *    `getManyAndCount()`.
   *  - Pagination uses `offset` / `limit` (not `skip` / `take`) for
   *    the same reason.
   *  - Bound term as a `:term` parameter — never concat user input
   *    into the SQL string.
   */
  async listAows(
    query: TocAowQueryDto,
  ): Promise<TocListResponseDto<TocAowListItemDto>> {
    const qb = this.tocAowRepo
      .createQueryBuilder('aow')
      .leftJoinAndSelect('aow.program', 'program')
      .where('aow.programId = :programId', { programId: query.programId });

    if (query.search && query.search.trim().length > 0) {
      const term = `%${query.search.trim()}%`;
      qb.andWhere(
        '(aow.acronym LIKE :term OR aow.wp_official_code LIKE :term OR aow.name LIKE :term)',
        { term },
      );
    }

    /* Raw DB column name to avoid the TypeORM `databaseName` bug. */
    qb.orderBy('aow.wp_official_code', 'ASC');
    /* Deterministic tie-breaker — many rows share NULL on
     * wp_official_code in older synced data. */
    qb.addOrderBy('aow.id', 'ASC');

    const offset = (query.page - 1) * query.limit;
    qb.offset(offset).limit(query.limit);

    const [rows, total] = await qb.getManyAndCount();

    return {
      data: rows.map((row) => this.toAowListItemDto(row)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /**
   * Paginated outcome list for the admin TOC viewer.
   *
   * Scoping: `programId` required; `aowId` optional. The backend is
   * **liberal** — an `aowId` whose program differs from `programId`
   * simply yields an empty `data` array, no error. The frontend
   * cascade prevents this UX-side.
   *
   * `search` matches `title` only (LIKE).
   * Sort: `title ASC` (raw DB column name).
   */
  async listOutcomes(
    query: TocOutcomeQueryDto,
  ): Promise<TocListResponseDto<TocOutcomeListItemDto>> {
    const qb = this.tocOutcomeRepo
      .createQueryBuilder('outcome')
      .leftJoinAndSelect('outcome.program', 'program')
      .leftJoinAndSelect('outcome.aow', 'aow')
      .where('outcome.programId = :programId', { programId: query.programId });

    if (typeof query.aowId === 'number') {
      qb.andWhere('outcome.aowId = :aowId', { aowId: query.aowId });
    }

    if (query.search && query.search.trim().length > 0) {
      const term = `%${query.search.trim()}%`;
      qb.andWhere('outcome.title LIKE :term', { term });
    }

    qb.orderBy('outcome.title', 'ASC');
    qb.addOrderBy('outcome.id', 'ASC');

    const offset = (query.page - 1) * query.limit;
    qb.offset(offset).limit(query.limit);

    const [rows, total] = await qb.getManyAndCount();

    return {
      data: rows.map((row) => this.toOutcomeListItemDto(row)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /**
   * Paginated output list for the admin TOC viewer.
   *
   * Same shape as {@link listOutcomes} — `programId` required,
   * `aowId` optional, `search` over `title` only, sort `title ASC`.
   */
  async listOutputs(
    query: TocOutputQueryDto,
  ): Promise<TocListResponseDto<TocOutputListItemDto>> {
    const qb = this.tocOutputRepo
      .createQueryBuilder('output')
      .leftJoinAndSelect('output.program', 'program')
      .leftJoinAndSelect('output.aow', 'aow')
      .where('output.programId = :programId', { programId: query.programId });

    if (typeof query.aowId === 'number') {
      qb.andWhere('output.aowId = :aowId', { aowId: query.aowId });
    }

    if (query.search && query.search.trim().length > 0) {
      const term = `%${query.search.trim()}%`;
      qb.andWhere('output.title LIKE :term', { term });
    }

    qb.orderBy('output.title', 'ASC');
    qb.addOrderBy('output.id', 'ASC');

    const offset = (query.page - 1) * query.limit;
    qb.offset(offset).limit(query.limit);

    const [rows, total] = await qb.getManyAndCount();

    return {
      data: rows.map((row) => this.toOutputListItemDto(row)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /* ── TOC response mappers ──────────────────────────────────────── */

  /**
   * Project the joined Program entity to the narrow embedded ref
   * shape `{ id, officialCode, name }` — everything else on the
   * program row (clarisaId, syncedAt, audit columns) is stripped.
   */
  private toProgramRefDto(entity: Program): TocProgramRefDto {
    return {
      id: entity.id,
      officialCode: entity.officialCode,
      name: entity.name,
    };
  }

  /**
   * Project the joined AOW entity to the narrow embedded ref shape
   * `{ id, acronym, name }`. Returns null when the input is null
   * (outcome / output rows where `aow_id IS NULL`).
   */
  private toAowRefDto(entity: TocAow | null): TocAowRefDto | null {
    if (!entity) return null;
    return {
      id: entity.id,
      acronym: entity.acronym,
      name: entity.name,
    };
  }

  // ──────────────────────────────────────────────────────────────────
  //  Unpaginated TOC reference reads (any authenticated user)
  //
  //  These power the consolidated negotiation page's TOC-link picker.
  //  Datasets per program are small (≤ a few dozen rows per table per
  //  program) so we return the entire set in one trip and let the
  //  client cascade-filter in memory.
  // ──────────────────────────────────────────────────────────────────

  /**
   * All AOWs for one program, ordered by `wp_official_code ASC`.
   * Returns the same row shape as the admin list endpoint so the
   * frontend can reuse the same DTO.
   */
  async listAowsForProgram(programId: number): Promise<TocAowListItemDto[]> {
    const rows = await this.tocAowRepo
      .createQueryBuilder('aow')
      .leftJoinAndSelect('aow.program', 'program')
      .where('aow.programId = :programId', { programId })
      .orderBy('aow.wp_official_code', 'ASC')
      .addOrderBy('aow.id', 'ASC')
      .getMany();
    return rows.map((row) => this.toAowListItemDto(row));
  }

  /**
   * Outputs for one program, optionally filtered to a set of AOWs.
   * Ordered by `title ASC` for stable cascade rendering.
   */
  async listOutputsForProgram(
    programId: number,
    aowIds?: number[],
  ): Promise<TocOutputListItemDto[]> {
    const qb = this.tocOutputRepo
      .createQueryBuilder('output')
      .leftJoinAndSelect('output.program', 'program')
      .leftJoinAndSelect('output.aow', 'aow')
      .where('output.programId = :programId', { programId });

    if (aowIds && aowIds.length > 0) {
      qb.andWhere('output.aowId IN (:...aowIds)', { aowIds });
    }

    qb.orderBy('output.title', 'ASC').addOrderBy('output.id', 'ASC');

    const rows = await qb.getMany();
    return rows.map((row) => this.toOutputListItemDto(row));
  }

  /**
   * Intermediate Outcomes (only) for one program, optionally filtered
   * to a set of AOWs. Portfolio EOIs (`outcome_type='portfolio'`) are
   * never returned by this endpoint — the picker only links IOCs.
   */
  /**
   * List outcomes available for the TOC Contribution picker.
   *
   * Returns **both** intermediate and portfolio (2030 EOI) outcomes — the
   * program-rep picker treats them as one pool. When `aowIds` is supplied,
   * the filter is **inclusive of orphans**: outcomes whose `aow_id IS NULL`
   * are surfaced regardless of which AOWs were chosen, because they aren't
   * scoped to any AOW and should be selectable across the board (otherwise
   * they'd be unreachable through the UI — the picker forces an AOW
   * selection before enabling the outcomes multiselect).
   *
   * Historical name: `listIntermediateOutcomesForProgram`. Renamed when
   * portfolio outcomes were folded in; the old name is no longer accurate.
   */
  async listOutcomesForProgram(
    programId: number,
    aowIds?: number[],
  ): Promise<TocOutcomeListItemDto[]> {
    const qb = this.tocOutcomeRepo
      .createQueryBuilder('outcome')
      .leftJoinAndSelect('outcome.program', 'program')
      .leftJoinAndSelect('outcome.aow', 'aow')
      .where('outcome.programId = :programId', { programId });

    if (aowIds && aowIds.length > 0) {
      /* Include both matching AOWs AND orphan (NULL aow_id) outcomes —
       * `NULL IN (…)` is NULL in MySQL, so the IS NULL branch must be
       * explicit. Wrapped in parens to keep precedence with the
       * programId AND clause above. */
      qb.andWhere('(outcome.aowId IN (:...aowIds) OR outcome.aowId IS NULL)', {
        aowIds,
      });
    }

    qb.orderBy('outcome.title', 'ASC').addOrderBy('outcome.id', 'ASC');

    const rows = await qb.getMany();
    return rows.map((row) => this.toOutcomeListItemDto(row));
  }

  /** Map a TocAow entity (with `program` joined) to its list-row DTO. */
  private toAowListItemDto(entity: TocAow): TocAowListItemDto {
    return {
      id: entity.id,
      nodeId: entity.nodeId,
      clarisaTocId: entity.clarisaTocId,
      acronym: entity.acronym,
      wpOfficialCode: entity.wpOfficialCode,
      name: entity.name,
      programId: entity.programId,
      program: this.toProgramRefDto(entity.program),
      syncedAt: entity.syncedAt,
    };
  }

  /** Map a TocOutcome entity (with `program` + `aow` joined) to its list-row DTO. */
  private toOutcomeListItemDto(entity: TocOutcome): TocOutcomeListItemDto {
    return {
      id: entity.id,
      nodeId: entity.nodeId,
      title: entity.title,
      description: entity.description,
      outcomeType: entity.outcomeType,
      relatedNodeId: entity.relatedNodeId,
      aowId: entity.aowId,
      aow: this.toAowRefDto(entity.aow),
      programId: entity.programId,
      program: this.toProgramRefDto(entity.program),
      syncedAt: entity.syncedAt,
    };
  }

  /** Map a TocOutput entity (with `program` + `aow` joined) to its list-row DTO. */
  private toOutputListItemDto(entity: TocOutput): TocOutputListItemDto {
    return {
      id: entity.id,
      nodeId: entity.nodeId,
      title: entity.title,
      description: entity.description,
      typeOfOutput: entity.typeOfOutput,
      relatedNodeId: entity.relatedNodeId,
      aowId: entity.aowId,
      aow: this.toAowRefDto(entity.aow),
      programId: entity.programId,
      program: this.toProgramRefDto(entity.program),
      syncedAt: entity.syncedAt,
    };
  }
}
