import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager, DataSource, Like } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';

import { Project } from '../projects/entities/project.entity';
import { ProjectBudget } from '../projects/entities/project-budget.entity';
import { ProjectMapping } from '../mappings/entities/project-mapping.entity';
import { MappingNegotiation } from '../mappings/entities/mapping-negotiation.entity';
import { NegotiationEventType } from '../mappings/enums/negotiation-event-type.enum';
import { Center } from '../reference-data/entities/center.entity';
import { Program } from '../reference-data/entities/program.entity';
import { Country } from '../reference-data/entities/country.entity';
import { User } from '../users/entities/user.entity';
import { FundingSource } from '../projects/enums/funding-source.enum';
import { ProjectStatus } from '../projects/enums/project-status.enum';
import { NatureOfFunder } from '../projects/enums/nature-of-funder.enum';
import { ProjectCategory } from '../projects/enums/project-category.enum';
import { CspFlag } from '../projects/enums/csp-flag.enum';
import { In2026 } from '../projects/enums/in-2026.enum';
import { MappingStatus } from '../mappings/enums/mapping-status.enum';
import { Rating } from '../mappings/enums/rating.enum';
import { UserRole } from '../users/enums/user-role.enum';
import { AuditService } from '../audit/audit.service';
import { AuditEntityType } from '../audit/entities/audit-event.entity';
import { ActorRole } from '../mappings/enums/actor-role.enum';

/**
 * Represents a single parsed CSV row from the TOC_Projects.csv file
 * with typed column names.
 */
interface CsvRow {
  Program: string;
  ID: string;
  Name: string;
  Dscription: string;
  Comments: string;
  'Program/Accelerator Interim Director review': string;
  'Complementarity of Results SI': string;
  'Efficiencies/Strategic Benefit SI': string;
  'Budget allocation from Project to Program': string;
  'Total Budget for this Program': string;
  'Total approximate project remaining budget': string;
  'Project Summary': string;
  'Project results': string;
  'Start Date': string;
  'End Date': string;
  Center: string;
  Location: string;
  Countries: string;
  'Source of funding': string;
  Funder: string;
}

/**
 * Summary object returned after the TOC_Projects.csv import run.
 */
export interface ImportSummary {
  projectsCreated: number;
  projectsUpdated: number;
  mappingsCreated: number;
  mappingsUpdated: number;
  skipped: number;
  errors: { row: number; reason: string }[];
}

/**
 * Normalized summary returned by the upload-based 4.1 / 4.3 importers
 * (and by the legacy file-path-based variants, for consistency).
 *
 * - `created` – new rows inserted (4.1: new projects, 4.3: new budget lines)
 * - `updated` – existing rows updated in place
 * - `skipped` – valid-but-not-applied rows (e.g. blank code)
 * - `errors` – per-row failures that did NOT abort the batch.
 *   IMPORTANT: every silent skip MUST also push an error entry so
 *   admins can see exactly why a row was not applied.
 */
export interface RowImportSummary {
  created: number;
  updated: number;
  skipped: number;
  errors: { row: number; code?: string; reason: string }[];
}

/**
 * Detected type for an uploaded importer file. "unknown" means we could
 * not match it against either the 4.1 or 4.3 signature and therefore
 * will not run any importer against it.
 */
export type ImportFileType = '4.1' | '4.3' | 'signalling' | 'toc' | 'unknown';

/* ------------------------------------------------------------------ */
/* Synthetic budget line written by the 4.1 importer.                  */
/*                                                                     */
/* When the Anaplan 4.1 template carries a "2026 Budget simulation"    */
/* value for a project, the importer also writes a `project_budgets`   */
/* row so the figure shows up alongside any real 4.3 fiscal-year       */
/* breakdown. The shape is fixed:                                      */
/*   year:           FY26       (canonical 2026 filter in this app)   */
/*   version:        Anaplan                                           */
/*   account:        TotalBudgetAnaplan                                */
/*   external_code:  anaplan-fy26:<project.code>                       */
/* The external_code prefix lets us load every synthetic row in one    */
/* query so the upsert is idempotent across re-imports.                */
/* ------------------------------------------------------------------ */
const ANAPLAN_BUDGET_YEAR = 'FY26';
const ANAPLAN_BUDGET_VERSION = 'Anaplan';
const ANAPLAN_BUDGET_ACCOUNT = 'TotalBudgetAnaplan';
const ANAPLAN_BUDGET_EXTERNAL_PREFIX = 'anaplan-fy26:';

/**
 * Maps the short program acronyms used in CGIAR Signalling exports
 * (e.g. "B4T", "SAAF", "GEI") to the `official_code` values stored in
 * the `programs` table. Lookup is exact, case-sensitive — the file
 * itself is consistent on casing. Add new pairs here when new science
 * programs are introduced.
 */
const SIGNALLING_PROGRAM_ACRONYM_TO_OFFICIAL_CODE: Record<string, string> = {
  B4T: 'SP01',
  SF: 'SP02',
  SAAF: 'SP03',
  ML: 'SP04',
  BDN: 'SP05',
  CA: 'SP06',
  PI: 'SP07',
  FFS: 'SP08',
  S4I: 'SP09',
  GEI: 'SP10',
  CS: 'SP11',
  DT: 'SP12',
  GB: 'SP13',
};

/**
 * Maps the long program names used in TOC_Projects.csv to programs.official_code.
 * Lookup is case-insensitive; non-breaking spaces ( ) and trailing
 * whitespace are stripped before comparison.
 */
const TOC_PROGRAM_NAME_TO_OFFICIAL_CODE: Record<string, string> = {
  'breeding for tomorrow': 'SP01',
  'sustainable farming': 'SP02',
  'sustainable animal and aquatic foods': 'SP03',
  'multifunctional landscapes': 'SP04',
  'better diets and nutrition': 'SP05',
  'climate action': 'SP06',
  'policy innovations': 'SP07',
  'food frontiers and security': 'SP08',
  'scaling for impact': 'SP09',
  'gender equality and inclusion': 'SP10',
  'capacity sharing': 'SP11',
  'digital transformation': 'SP12',
  genebank: 'SP13',
};

/**
 * Per-file result returned by the bulk import endpoint. Combines the
 * detected file type, the original filename (so the UI can label the
 * section), and the standard {created, updated, skipped, errors} shape.
 */
export interface BulkFileResult {
  filename: string;
  type: ImportFileType;
  created: number;
  updated: number;
  skipped: number;
  errors: { row: number; code?: string; reason: string }[];
}

/**
 * Aggregate response for the bulk import endpoint — one entry per file
 * (in dependency-resolved processing order, NOT upload order) plus a
 * roll-up of totals for the whole run.
 */
export interface BulkImportSummary {
  files: BulkFileResult[];
  totals: {
    filesProcessed: number;
    created: number;
    updated: number;
    skipped: number;
    errors: number;
  };
}

/**
 * Shape accepted by `runBulkImport`. The controller adapts
 * `Express.Multer.File` to this shape so the service is not coupled
 * to the HTTP layer.
 */
export interface BulkImportFileInput {
  buffer: Buffer;
  originalName: string;
}

/**
 * Counts of rows wiped by `ImportService.resetProjects()`. Each field is
 * the `affectedRows` returned by MySQL for the corresponding DELETE
 * statement, surfaced verbatim in the API response so the admin can
 * verify what was actually removed.
 */
export interface ResetDeletedCounts {
  mappingNegotiations: number;
  projectNegotiationMessages: number;
  projectMappings: number;
  projectBudgets: number;
  projectCountries: number;
  projectExclusions: number;
  projects: number;
}

/**
 * Full response shape of `ImportService.resetProjects()` — the per-table
 * delete counts plus the wall-clock duration of the destructive
 * transaction (handy for the admin UI's "took N ms" toast).
 */
export interface ResetSummary {
  deleted: ResetDeletedCounts;
  durationMs: number;
}

/**
 * MySQL's response envelope for an executed DELETE. TypeORM's
 * `manager.query()` returns this as an opaque `any`, so we pin the
 * shape locally to keep the call sites type-safe.
 */
interface MysqlDeleteResult {
  affectedRows: number;
}

/**
 * Executes `DELETE FROM <table>` against the supplied transactional
 * manager and returns the affected-row count. Centralised so the
 * caller's body stays a flat list of table names without repeating the
 * cast-and-coerce dance for every statement.
 *
 * The table name is interpolated directly rather than parameterised —
 * MySQL does not allow identifier placeholders, and every call site in
 * this service passes a hard-coded literal so there is no injection
 * surface. We still wrap the affected-row read in `Number(... ?? 0)`
 * because MySQL drivers have historically returned strings for large
 * counts and `undefined` for empty tables.
 */
async function runDelete(
  manager: EntityManager,
  table: string,
): Promise<number> {
  const result = (await manager.query(
    `DELETE FROM ${table}`,
  )) as MysqlDeleteResult;
  return Number(result?.affectedRows ?? 0);
}

/**
 * Handles bulk CSV / XLSX import of projects, mappings, project metadata
 * (4.1) and budget lines (4.3). Reads a CSV file or an in-memory buffer
 * (Excel or CSV), groups/parses rows, resolves reference data, and
 * upserts entities idempotently.
 */
@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(ProjectMapping)
    private readonly mappingRepo: Repository<ProjectMapping>,
    @InjectRepository(Center)
    private readonly centerRepo: Repository<Center>,
    @InjectRepository(Program)
    private readonly programRepo: Repository<Program>,
    @InjectRepository(Country)
    private readonly countryRepo: Repository<Country>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(ProjectBudget)
    private readonly budgetRepo: Repository<ProjectBudget>,
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Records a single import.run audit event. Used at the tail of every
   * importer entry-point so each invocation leaves an audit row showing
   * which file produced which counts.
   *
   * The synthetic-changes shape (`{ counts: { before: null, after: ... } }`)
   * keeps the JSON column schema consistent with field-level diff events
   * even though import counts are not a before/after pair semantically —
   * the alternative would be a third audit shape per the call-site spec.
   *
   * Import endpoints have no signed-in user context (they are admin-only,
   * but driven from an HTTP request that does carry the actor). When the
   * request context resolver returns null (e.g. CLI-driven imports) we
   * fall back to the SYSTEM actor override so the row still lands.
   */
  private async recordImportRun(
    filename: string,
    counts: {
      created: number;
      updated: number;
      skipped: number;
      errors: number;
    },
    extra?: { mappingsCreated?: number; mappingsUpdated?: number },
  ): Promise<void> {
    const merged = { ...counts, ...(extra ?? {}) };
    await this.auditService.record({
      entityType: AuditEntityType.IMPORT_RUN,
      entityId: null,
      action: 'import.run',
      summary: `Imported ${filename}`,
      changes: {
        counts: { before: null, after: merged },
      },
      /* Fall back to a SYSTEM actor when the call has no request context
       * (e.g. CLI bootstrap or tests). Inside an HTTP request handler
       * the override is ignored only when actorOverride is undefined —
       * we always pass it here, so the row consistently shows "system
       * (importer)" regardless of who triggered it. The endpoint's
       * @Roles guard already restricted the trigger to admins.
       *
       * Note: AuditService treats actorOverride as authoritative when
       * present. To keep imports attributable to the admin who clicked
       * "import" in the UI, callers can still see the X-Request-ID on
       * the audit row even though the actor is SYSTEM. */
      actorOverride: {
        userId: null,
        role: ActorRole.SYSTEM,
        displayName: 'system (importer)',
        email: null,
      },
    });
  }

  /**
   * Deletes all project-related data in the correct FK order so the
   * database can be cleanly re-seeded from CSV.
   *
   * Order: published_projects → published_snapshots → project_budgets →
   *        project_mappings → project_countries → projects
   */
  async clearProjectData(): Promise<void> {
    this.logger.log('Clearing all project-related data…');

    await this.dataSource.query('DELETE FROM published_projects');
    await this.dataSource.query('DELETE FROM published_snapshots');
    await this.dataSource.query('DELETE FROM project_budgets');
    await this.dataSource.query('DELETE FROM project_mappings');
    await this.dataSource.query('DELETE FROM project_countries');
    await this.dataSource.query('DELETE FROM projects');
    await this.dataSource.query('ALTER TABLE projects AUTO_INCREMENT = 1');

    this.logger.log('All project data cleared');
  }

  /**
   * DANGER ZONE: wipes every project-scoped table so the admin can
   * re-run the bulk importers from a clean slate.
   *
   * The destructive surface is wider than `clearProjectData()` — this
   * call also removes negotiation history, chat threads, and per-center
   * exclusions, then resets AUTO_INCREMENT counters on the affected
   * tables so re-imported IDs start at 1.
   *
   * Intentionally NOT touched:
   *   - `users`           (would lock out the calling admin)
   *   - `centers`, `programs`, `countries`, `action_areas` (CLARISA
   *      reference data — kept so re-import can resolve FKs)
   *   - `audit_events`    (history of admin actions — preserved)
   *   - `published_snapshots` (frozen portfolio history — preserved)
   *   - `migrations`      (TypeORM tracking — never touched)
   *
   * All DELETEs and AUTO_INCREMENT resets execute inside a single
   * transaction so a mid-operation failure rolls back cleanly without
   * leaving orphans. The audit event is emitted AFTER commit so the
   * audit row only exists when the destructive work actually succeeded.
   */
  async resetProjects(): Promise<ResetSummary> {
    const start = Date.now();
    this.logger.warn('Admin reset triggered — wiping all project-scoped data');

    const deleted = await this.dataSource.transaction(
      async (manager: EntityManager) => {
        /* Delete in child-first FK order to avoid violating constraints.
         * Each DELETE returns MySQL's `{ affectedRows }` envelope which
         * we capture per table so the response can surface real counts
         * to the admin (useful for verifying the reset actually emptied
         * what they expected). */
        const mappingNegotiations = await runDelete(
          manager,
          'mapping_negotiations',
        );
        const projectNegotiationMessages = await runDelete(
          manager,
          'project_negotiation_messages',
        );
        const projectMappings = await runDelete(manager, 'project_mappings');
        const projectBudgets = await runDelete(manager, 'project_budgets');
        // `project_countries` is the M2M join table — TypeORM has no
        // entity for it, so we hit it directly with raw SQL like the
        // other tables in this method.
        const projectCountries = await runDelete(manager, 'project_countries');
        const projectExclusions = await runDelete(
          manager,
          'project_exclusions',
        );
        const projects = await runDelete(manager, 'projects');

        /* Reset AUTO_INCREMENT counters inside the same transaction.
         * `project_countries` has no AUTO_INCREMENT column (composite
         * PK on project_id + country_id) so it is intentionally
         * excluded from this list. */
        await manager.query('ALTER TABLE projects AUTO_INCREMENT = 1');
        await manager.query('ALTER TABLE project_mappings AUTO_INCREMENT = 1');
        await manager.query('ALTER TABLE project_budgets AUTO_INCREMENT = 1');
        await manager.query(
          'ALTER TABLE project_exclusions AUTO_INCREMENT = 1',
        );
        await manager.query(
          'ALTER TABLE project_negotiation_messages AUTO_INCREMENT = 1',
        );
        await manager.query(
          'ALTER TABLE mapping_negotiations AUTO_INCREMENT = 1',
        );

        return {
          mappingNegotiations,
          projectNegotiationMessages,
          projectMappings,
          projectBudgets,
          projectCountries,
          projectExclusions,
          projects,
        };
      },
    );

    const durationMs = Date.now() - start;

    this.logger.warn(
      `Admin reset: deleted ${deleted.projects} projects, ` +
        `${deleted.projectMappings} mappings, ` +
        `${deleted.mappingNegotiations} negotiation events, ` +
        `${deleted.projectNegotiationMessages} chat messages, ` +
        `${deleted.projectBudgets} budgets, ` +
        `${deleted.projectCountries} country links, ` +
        `${deleted.projectExclusions} exclusions ` +
        `in ${durationMs}ms`,
    );

    /* Emit the audit event AFTER the transaction commits. Routing
     * through AuditService.record() means the actor is resolved from
     * the active request context — the @Roles guard on the controller
     * has already proven the caller is an admin, so this row is
     * attributable to the human who clicked the button. We reuse
     * `IMPORT_RUN` as the entity type because that's the closest
     * existing bucket (this action is logically an inverse import). */
    await this.auditService.record({
      entityType: AuditEntityType.IMPORT_RUN,
      entityId: null,
      action: 'admin.reset_projects',
      summary: 'Admin reset all project data',
      changes: {
        counts: { before: null, after: deleted },
      },
    });

    return { deleted, durationMs };
  }

  /**
   * Runs the full TOC_Projects.csv import.
   *
   * 1. Reads and parses the CSV file.
   * 2. Groups rows by project name.
   * 3. For each project group, upserts the project and its mappings
   *    inside a transaction.
   * 4. Returns an import summary with counts and error details.
   *
   * @param csvPath - Optional override for the CSV file path.
   * @returns Import summary with created/updated/skipped counts and errors.
   */
  async runImport(csvPath?: string): Promise<ImportSummary> {
    const filePath =
      csvPath || path.resolve(__dirname, '..', '..', '..', 'TOC_Projects.csv');
    this.logger.log(`Starting CSV import from: ${filePath}`);

    /* Read and parse CSV */
    const csvContent = fs.readFileSync(filePath, 'utf-8');
    const rows: CsvRow[] = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });

    this.logger.log(`Parsed ${rows.length} CSV rows`);

    /* Pre-load reference data into memory for fast lookups */
    const allCenters = await this.centerRepo.find();
    const allPrograms = await this.programRepo.find();
    const allCountries = await this.countryRepo.find();

    /* Find or create system admin user for createdBy */
    const systemUser = await this.getOrCreateSystemUser();

    /* Group rows by project name */
    const projectGroups = this.groupRowsByProject(rows);
    this.logger.log(`Found ${projectGroups.size} unique projects`);

    const summary: ImportSummary = {
      projectsCreated: 0,
      projectsUpdated: 0,
      mappingsCreated: 0,
      mappingsUpdated: 0,
      skipped: 0,
      errors: [],
    };

    let processedCount = 0;

    for (const [projectName, groupRows] of projectGroups) {
      processedCount++;

      /* Log progress every 50 projects */
      if (processedCount % 50 === 0) {
        this.logger.log(
          `Import progress: ${processedCount}/${projectGroups.size} projects processed`,
        );
      }

      try {
        await this.processProjectGroup(
          projectName,
          groupRows,
          allCenters,
          allPrograms,
          allCountries,
          systemUser,
          summary,
        );
      } catch (error) {
        const rowNumber = rows.indexOf(groupRows[0]) + 2; // +2 for header + 0-index
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Failed to import project "${projectName}" at row ${rowNumber}: ${message}`,
        );
        summary.errors.push({ row: rowNumber, reason: message });
      }
    }

    this.logger.log(
      `Import complete: ${summary.projectsCreated} created, ${summary.projectsUpdated} updated, ` +
        `${summary.mappingsCreated} mappings created, ${summary.mappingsUpdated} mappings updated, ` +
        `${summary.skipped} skipped, ${summary.errors.length} errors`,
    );

    /* Audit the TOC import run with both project and mapping counts so
     * the audit row reflects the full surface this importer touched. */
    await this.recordImportRun(
      path.basename(filePath),
      {
        created: summary.projectsCreated,
        updated: summary.projectsUpdated,
        skipped: summary.skipped,
        errors: summary.errors.length,
      },
      {
        mappingsCreated: summary.mappingsCreated,
        mappingsUpdated: summary.mappingsUpdated,
      },
    );

    return summary;
  }

  /**
   * Groups CSV rows by the "Name" column value.
   *
   * Rows with empty or whitespace-only names are excluded.
   *
   * @param rows - All parsed CSV rows.
   * @returns Map of project name to its associated rows.
   */
  private groupRowsByProject(rows: CsvRow[]): Map<string, CsvRow[]> {
    const groups = new Map<string, CsvRow[]>();

    for (const row of rows) {
      const name = (row.Name || '').trim();
      if (!name) continue;

      const existing = groups.get(name);
      if (existing) {
        existing.push(row);
      } else {
        groups.set(name, [row]);
      }
    }

    return groups;
  }

  /**
   * Processes a single project group (one project + N mapping rows)
   * inside a transaction.
   *
   * The first row with populated data provides the project-level
   * details. Every row produces a project-to-program mapping.
   */
  private async processProjectGroup(
    projectName: string,
    rows: CsvRow[],
    centers: Center[],
    programs: Program[],
    countries: Country[],
    systemUser: User,
    summary: ImportSummary,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager: EntityManager) => {
      /* Find the first row with meaningful project data (has a center) */
      const primaryRow =
        rows.find((r) => (r.Center || '').trim().length > 0) || rows[0];

      /* Extract project code and name */
      const { code, name } = this.extractCodeAndName(projectName);

      /* Extract explicit ID from CSV — used as the primary key */
      const csvId = parseInt((primaryRow.ID || '').trim(), 10);

      /* Resolve center */
      const centerName = (primaryRow.Center || '').trim();
      const center = centerName
        ? this.resolveCenter(centerName, centers)
        : null;

      if (!center) {
        summary.skipped++;
        this.logger.warn(
          `Skipping project "${projectName}": no matching center for "${centerName}"`,
        );
        return;
      }

      /* Resolve countries */
      const countriesStr = (primaryRow.Countries || '').trim();
      const resolvedCountries = this.resolveCountries(countriesStr, countries);

      /* Parse funding source */
      const fundingSource = this.normalizeFundingSource(
        primaryRow['Source of funding'],
      );

      /* Parse dates */
      const startDate = this.parseDate(primaryRow['Start Date']);
      const endDate = this.parseDate(primaryRow['End Date']);

      /* Parse budgets */
      const totalBudget = this.parseBudget(
        primaryRow['Total Budget for this Program'],
      );
      const remainingBudget = this.parseBudget(
        primaryRow['Total approximate project remaining budget'],
      );

      /* Description: use Dscription column, fall back to Comments */
      const description =
        (primaryRow.Dscription || '').trim() ||
        (primaryRow.Comments || '').trim() ||
        null;
      const projectSummary =
        (primaryRow['Project Summary'] || '').trim() || null;
      const projectResults =
        (primaryRow['Project results'] || '').trim() || null;
      const funder = (primaryRow.Funder || '').trim() || null;

      /* Upsert project — find by CSV ID (primary key) or code for idempotent re-runs */
      let project = !isNaN(csvId)
        ? await manager.findOne(Project, {
            where: { id: csvId },
            relations: ['countries'],
          })
        : await manager.findOne(Project, {
            where: { code },
            relations: ['countries'],
          });

      if (project) {
        /* Update existing project with latest data */
        project.name = name;
        if (description) project.description = description;
        if (projectSummary) project.summary = projectSummary;
        if (projectResults) project.results = projectResults;
        if (startDate) project.startDate = startDate;
        if (endDate) project.endDate = endDate;
        project.totalBudget = totalBudget;
        project.remainingBudget = remainingBudget;
        if (fundingSource) project.fundingSource = fundingSource;
        if (funder) project.funder = funder;
        project.centerId = center.id;
        if (resolvedCountries.length > 0) {
          project.countries = resolvedCountries;
        }

        await manager.save(Project, project);
        summary.projectsUpdated++;
      } else {
        /* Create new project — use raw SQL when CSV provides an explicit
           ID so MySQL inserts the exact value instead of auto-incrementing. */
        let newId: number;

        if (!isNaN(csvId)) {
          await manager.query(
            `INSERT INTO projects
              (id, code, name, description, summary, results,
               start_date, end_date, total_budget, remaining_budget,
               funding_source, funder, status, center_id, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              csvId,
              code,
              name,
              description,
              projectSummary,
              projectResults,
              startDate,
              endDate,
              totalBudget,
              remainingBudget,
              fundingSource,
              funder,
              ProjectStatus.ACTIVE,
              center.id,
              systemUser.id,
            ],
          );
          newId = csvId;
        } else {
          const insertResult = await manager
            .createQueryBuilder()
            .insert()
            .into(Project)
            .values({
              code,
              name,
              description,
              summary: projectSummary,
              results: projectResults,
              startDate,
              endDate,
              totalBudget,
              remainingBudget,
              fundingSource,
              funder,
              status: ProjectStatus.ACTIVE,
              centerId: center.id,
              createdById: systemUser.id,
            })
            .execute();
          newId = insertResult.identifiers[0].id;
        }

        /* Reload so we can attach countries via the M2M relation */
        project = await manager.findOneOrFail(Project, {
          where: { id: newId },
          relations: ['countries'],
        });

        if (resolvedCountries.length > 0) {
          project.countries = resolvedCountries;
          await manager.save(Project, project);
        }

        summary.projectsCreated++;
      }

      /* Process mappings for each row */
      for (const row of rows) {
        const programName = (row.Program || '').trim();
        if (!programName) continue;

        const program = this.resolveProgram(programName, programs);
        if (!program) {
          this.logger.warn(
            `No program match for "${programName}" on project "${code}"`,
          );
          continue;
        }

        await this.upsertMapping(
          manager,
          project,
          program,
          row,
          systemUser,
          summary,
        );
      }
    });
  }

  /**
   * Extracts a project code and clean name from the raw CSV Name field.
   *
   * Patterns recognized:
   * - "S0003 -Name..." → code: "S0003", name: "Name..."
   * - "N-344002- Name..." → code: "N-344002", name: "Name..."
   * - "T-PJ-004023-Name..." → code: "T-PJ-004023", name: "Name..."
   * - "D-200394-Name..." → code: "D-200394", name: "Name..."
   *
   * Falls back to using the full string as both code and name.
   */
  private extractCodeAndName(raw: string): { code: string; name: string } {
    const trimmed = raw.trim();

    /*
     * Match a code prefix consisting of letters, digits, and hyphens
     * that starts with a letter or digit, followed by a separator
     * (hyphen with optional spaces, or space-hyphen) before the name.
     */
    const codePattern =
      /^([A-Z]\d+|[A-Z](?:-[A-Za-z0-9]+)+|[A-Z]-\d+)\s*[-–]\s*/i;
    const match = trimmed.match(codePattern);

    if (match) {
      const code = match[1].trim();
      const name = trimmed.slice(match[0].length).trim() || trimmed;
      return { code, name };
    }

    /* Fallback: use first 50 chars as code if no pattern matches */
    const fallbackCode = trimmed.slice(0, 50).replace(/\s+/g, '-');
    return { code: fallbackCode, name: trimmed };
  }

  /**
   * Resolves a center by matching the CSV center name against the
   * local centers table. Uses case-insensitive partial matching
   * on both the full name and the acronym.
   */
  private resolveCenter(csvCenter: string, centers: Center[]): Center | null {
    const normalized = csvCenter.toLowerCase().trim();

    /* Try exact name match first */
    const exactMatch = centers.find((c) => c.name.toLowerCase() === normalized);
    if (exactMatch) return exactMatch;

    /* Try acronym match — CSV often uses the full name which contains the acronym */
    const acronymMatch = centers.find((c) =>
      normalized.includes(c.acronym.toLowerCase()),
    );
    if (acronymMatch) return acronymMatch;

    /* Try partial name match — CSV name may contain the CLARISA name or vice versa */
    const partialMatch = centers.find(
      (c) =>
        normalized.includes(c.name.toLowerCase()) ||
        c.name.toLowerCase().includes(normalized),
    );
    if (partialMatch) return partialMatch;

    /*
     * Try matching by significant words (at least 3 chars) —
     * handles cases where the CSV has a slightly different name format.
     */
    const csvWords = normalized
      .split(/[\s/,]+/)
      .filter((w) => w.length >= 3)
      .slice(0, 5);

    if (csvWords.length >= 2) {
      const wordMatch = centers.find((c) => {
        const centerLower = c.name.toLowerCase();
        const matchCount = csvWords.filter((w) =>
          centerLower.includes(w),
        ).length;
        return matchCount >= Math.min(3, csvWords.length);
      });
      if (wordMatch) return wordMatch;
    }

    return null;
  }

  /**
   * Resolves a program by matching the CSV program name against the
   * local programs table using case-insensitive comparison.
   */
  private resolveProgram(
    csvProgram: string,
    programs: Program[],
  ): Program | null {
    const normalized = csvProgram.toLowerCase().trim();

    /* Exact name match */
    const exactMatch = programs.find(
      (p) => p.name.toLowerCase() === normalized,
    );
    if (exactMatch) return exactMatch;

    /* Partial match — CSV name is contained in DB name or vice versa */
    const partialMatch = programs.find(
      (p) =>
        normalized.includes(p.name.toLowerCase()) ||
        p.name.toLowerCase().includes(normalized),
    );
    if (partialMatch) return partialMatch;

    return null;
  }

  /**
   * Resolves countries from a comma-separated string.
   *
   * Skips values like "country", "global", and empty strings
   * which appear in the CSV as placeholder values.
   */
  private resolveCountries(
    csvCountries: string,
    countries: Country[],
  ): Country[] {
    if (!csvCountries) return [];

    const skipValues = new Set(['country', 'global', '']);
    const names = csvCountries.split(',').map((n) => n.trim());
    const resolved: Country[] = [];

    for (const name of names) {
      if (skipValues.has(name.toLowerCase())) continue;

      const match = countries.find(
        (c) => c.name.toLowerCase() === name.toLowerCase(),
      );
      if (match) {
        resolved.push(match);
      } else {
        this.logger.debug(`Country not found: "${name}"`);
      }
    }

    return resolved;
  }

  /**
   * Normalizes a funding source string to the FundingSource enum.
   */
  private normalizeFundingSource(source: string): FundingSource | null {
    if (!source) return null;
    const normalized = source.toLowerCase().trim();

    if (
      normalized.includes('window 3') ||
      normalized.includes('w3') ||
      normalized.includes('windows 3')
    ) {
      return FundingSource.WINDOW3;
    }
    if (normalized.includes('bilateral')) {
      return FundingSource.BILATERAL;
    }
    if (normalized.includes('srv')) {
      return FundingSource.SRV;
    }
    if (normalized.length > 0) {
      return FundingSource.OTHER;
    }

    return null;
  }

  /**
   * Parses a date string in any of the formats the importers encounter.
   *
   * Supported:
   * - "DD-MMM-YY" / "DD-MMM-YYYY" (e.g. "21-Nov-24")
   * - ISO "YYYY-MM-DD"
   * - "D/M/YYYY" or "DD/MM/YYYY" (legacy CSV slash format with 4-digit year)
   * - "M/D/YY" or "MM/DD/YY" (May-2026 XLSX slash format with 2-digit year)
   *
   * @returns Parsed Date or null if the input is empty/unparseable.
   */
  private parseDate(dateStr: string): Date | null {
    if (!dateStr || !dateStr.trim()) return null;

    const trimmed = dateStr.trim();

    /* ISO YYYY-MM-DD (the leading group must be 4 digits) */
    const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (isoMatch) {
      const [, y, m, d] = isoMatch;
      return new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10));
    }

    /* Slash-format dates. Two flavours show up in Anaplan exports:
       - Legacy CSV (4-digit year): "D/M/YYYY"  e.g. "12/7/2027"
       - May-2026 XLSX (2-digit year, US locale): "M/D/YY"  e.g. "7/12/27"
       We discriminate by year length:
         · 4-digit year → first group = day, second = month (D/M/YYYY)
         · 2-digit year → first group = month, second = day (M/D/YY)
       2-digit years map 00-49 → 2000-2049, 50-99 → 1950-1999. */
    const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (slashMatch) {
      const [, a, b, y] = slashMatch;
      const isFourDigitYear = y.length === 4;
      const day = parseInt(isFourDigitYear ? a : b, 10);
      const month = parseInt(isFourDigitYear ? b : a, 10);
      let year = parseInt(y, 10);
      if (!isFourDigitYear) year = year < 50 ? 2000 + year : 1900 + year;
      if (
        isNaN(day) ||
        isNaN(month) ||
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > 31
      ) {
        return null;
      }
      return new Date(year, month - 1, day);
    }

    /* DD-MMM-YY or DD-MMM-YYYY */
    const months: Record<string, number> = {
      jan: 0,
      feb: 1,
      mar: 2,
      apr: 3,
      may: 4,
      jun: 5,
      jul: 6,
      aug: 7,
      sep: 8,
      oct: 9,
      nov: 10,
      dec: 11,
    };

    const parts = trimmed.split('-');
    if (parts.length !== 3) return null;

    const day = parseInt(parts[0], 10);
    const monthStr = parts[1].toLowerCase();
    const yearStr = parts[2];

    const month = months[monthStr];
    if (month === undefined || isNaN(day)) return null;

    let year = parseInt(yearStr, 10);
    if (isNaN(year)) return null;

    /* Handle 2-digit year: 00-49 → 2000-2049, 50-99 → 1950-1999 */
    if (year < 100) {
      year = year < 50 ? 2000 + year : 1900 + year;
    }

    return new Date(year, month, day);
  }

  /**
   * Parses a budget value string, removing commas and converting to a number.
   *
   * @returns Parsed number or 0 if unparseable.
   */
  private parseBudget(value: string): number {
    if (!value || !value.trim()) return 0;

    const cleaned = value.trim().replace(/,/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
  }

  /**
   * Normalizes a director review status string to a MappingStatus enum.
   */
  private normalizeDirectorReview(review: string): MappingStatus {
    const normalized = (review || '').trim().toLowerCase();

    if (normalized === 'agree') return MappingStatus.AGREED;
    if (normalized === 'disagree') return MappingStatus.REMOVED;
    return MappingStatus.NEGOTIATING;
  }

  /**
   * Normalizes a rating string to the Rating enum.
   */
  private normalizeRating(rating: string): Rating | null {
    const normalized = (rating || '').trim().toLowerCase();

    if (normalized === 'high') return Rating.HIGH;
    if (normalized === 'med' || normalized === 'medium') return Rating.MEDIUM;
    if (normalized === 'low') return Rating.LOW;
    return null;
  }

  /**
   * Upserts a project mapping for a single CSV row.
   *
   * Uses the unique constraint on (project_id, program_id) to
   * determine whether to create or update.
   */
  private async upsertMapping(
    manager: EntityManager,
    project: Project,
    program: Program,
    row: CsvRow,
    systemUser: User,
    summary: ImportSummary,
  ): Promise<void> {
    const allocationRaw = parseFloat(
      row['Budget allocation from Project to Program'] || '0',
    );
    /* CSV stores allocation as decimal (0.5 = 50%), convert to percentage */
    const allocationPercentage = isNaN(allocationRaw) ? 0 : allocationRaw * 100;

    const status = this.normalizeDirectorReview(
      row['Program/Accelerator Interim Director review'],
    );
    const complementarityRating = this.normalizeRating(
      row['Complementarity of Results SI'],
    );
    const efficiencyRating = this.normalizeRating(
      row['Efficiencies/Strategic Benefit SI'],
    );

    const now = new Date();

    /* Check for existing mapping */
    let mapping = await manager.findOne(ProjectMapping, {
      where: { projectId: project.id, programId: program.id },
    });

    if (mapping) {
      /* Update existing mapping */
      mapping.allocationPercentage = allocationPercentage;
      mapping.complementarityRating = complementarityRating;
      mapping.efficiencyRating = efficiencyRating;
      mapping.status = status;

      if (status === MappingStatus.AGREED || status === MappingStatus.REMOVED) {
        mapping.reviewedAt = now;
      }

      await manager.save(ProjectMapping, mapping);
      summary.mappingsUpdated++;
    } else {
      /* Create new mapping */
      mapping = manager.create(ProjectMapping, {
        projectId: project.id,
        programId: program.id,
        allocationPercentage,
        complementarityRating,
        efficiencyRating,
        status,
        centerAgreed: status === MappingStatus.AGREED,
        programAgreed: status === MappingStatus.AGREED,
        initiatedById: systemUser.id,
        initiatedAt: now,
        submittedById: systemUser.id,
        submittedAt: now,
        reviewedAt:
          status === MappingStatus.AGREED || status === MappingStatus.REMOVED
            ? now
            : null,
        reviewedById: null,
        rejectionReason: null,
      });

      await manager.save(ProjectMapping, mapping);
      summary.mappingsCreated++;
    }

    /* Imported historical data is treated as finalized at the project level. */
    if (status === MappingStatus.AGREED && !project.negotiationLocked) {
      project.negotiationLocked = true;
      await manager.save(Project, project);
    }
  }

  /**
   * Retrieves or creates a system admin user used as the creator
   * for imported projects and the submitter for imported mappings.
   *
   * This ensures that the NOT NULL createdBy / submittedBy foreign
   * keys can be satisfied during CSV imports.
   */
  private async getOrCreateSystemUser(): Promise<User> {
    const systemEmail = 'system@prms.cgiar.org';

    let user = await this.userRepo.findOneBy({ email: systemEmail });
    if (user) return user;

    user = this.userRepo.create({
      cognitoSub: 'system-import-user',
      email: systemEmail,
      firstName: 'System',
      lastName: 'Import',
      role: UserRole.ADMIN,
      isActive: true,
    });

    user = await this.userRepo.save(user);
    this.logger.log(`Created system user for import: ${user.id}`);
    return user;
  }

  /* ================================================================== */
  /* Tabular file parsing — CSV + XLSX                                   */
  /* ================================================================== */

  /**
   * Parses an in-memory CSV or XLSX file into the same
   * `Record<string, string>[]` shape produced by `csv-parse`.
   *
   * For .xlsx, the first sheet is read and converted with header keys
   * taken from row 1. All values are coerced to strings and trimmed,
   * and empty cells become empty strings — matching csv-parse's
   * `trim: true` behaviour.
   *
   * Throws BadRequestException with a clear message when the buffer is
   * unparseable (e.g. corrupt xlsx, or csv that does not yield rows).
   */
  private parseTabularBuffer(
    buffer: Buffer,
    originalName: string,
  ): Record<string, string>[] {
    const ext = (path.extname(originalName) || '').toLowerCase();
    const isExcel = ext === '.xlsx' || ext === '.xls';

    try {
      if (isExcel) {
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        if (!workbook.SheetNames.length) {
          throw new Error('workbook contains no sheets');
        }
        /* Anaplan exports sometimes ship multiple revisions of the same
           4.1 sheet (e.g. "4.1" and "4.1-update5May26"). Prefer any sheet
           whose name contains "update" — that is the canonical current
           revision — and fall back to the first sheet otherwise. */
        const sheetName =
          workbook.SheetNames.find((n) => /update/i.test(n)) ||
          workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];

        /* defval: '' so empty cells become "" not undefined; raw: false so
           values come through as formatted strings (not Date objects, etc.) */
        const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
          defval: '',
          raw: false,
        });

        return raw.map((r) => this.normalizeRow(r));
      }

      /* CSV path — same options as the legacy importers */
      const csvContent = buffer.toString('utf-8');
      const rows = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      });

      return (rows as Record<string, unknown>[]).map((r) =>
        this.normalizeRow(r),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to parse uploaded file "${originalName}": ${message}`,
      );
      throw new BadRequestException(
        `Could not parse uploaded file (${ext || 'unknown type'}): ${message}`,
      );
    }
  }

  /**
   * Coerces every cell value in a parsed row to a trimmed string,
   * dropping `null` / `undefined` to ''.
   *
   * Also normalizes the column KEYS — Anaplan exports often wrap header
   * cells with leading/trailing whitespace and use multiple internal
   * spaces (e.g. " Total Pledge ", "  2026 Budget ", "2026 Budget
   * simulation"). xlsx preserves those bytes verbatim, which silently
   * breaks any importer that does `row['Total Pledge']` exact-match
   * lookups. We trim each key and collapse any run of whitespace to a
   * single space so the importer can rely on the clean column names.
   * Late-duplicate keys (after normalization) keep the first non-empty
   * value to avoid losing data when two source columns normalize to
   * the same name.
   */
  private normalizeRow(row: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of Object.keys(row)) {
      const cleanKey = (key || '').trim().replace(/\s+/g, ' ');
      const v = row[key];
      let value: string;
      if (v === null || v === undefined) {
        value = '';
      } else if (typeof v === 'string') {
        value = v.trim();
      } else {
        value = String(v).trim();
      }
      /* Preserve the first non-empty value when two source headers
         collapse to the same normalized key. */
      if (out[cleanKey] === undefined || out[cleanKey] === '') {
        out[cleanKey] = value;
      }
    }
    return out;
  }

  /* ================================================================== */
  /* 4.1 Project Info importer                                           */
  /* ================================================================== */

  /**
   * Imports / upserts project metadata from the 4.1 Project Info CSV
   * (legacy file-path entry point).
   *
   * @param filePath - Absolute path to the 4.1 Project Info CSV.
   */
  async importProjectInfo(filePath: string): Promise<RowImportSummary> {
    this.logger.log(`Starting 4.1 Project Info import from: ${filePath}`);
    const buffer = fs.readFileSync(filePath);
    return this.importProjectInfoFromBuffer(buffer, path.basename(filePath));
  }

  /**
   * Imports / upserts project metadata from an in-memory 4.1 Project
   * Info file (CSV or XLSX) — the upload-driven entry point.
   *
   * Behaviour:
   * - Existing projects (matched by `code`) get their metadata updated.
   *   Blank cells do NOT erase existing values for free-text fields,
   *   but enum / nullable structured fields are written through.
   * - Unknown codes auto-CREATE a new project, using `Entity` to resolve
   *   the center via the same matcher used by the TOC importer.
   *   `name` falls back from "Signed Contract Title" → CSV row label →
   *   `code` so the row never lands without a name. Budget defaults to 0.
   * - Rows without a `Code` are counted as `skipped`.
   * - Rows whose `Entity` does not resolve to a center are counted as
   *   errors and the row is not created.
   *
   * Per-row errors do NOT abort the batch.
   */
  async importProjectInfoFromBuffer(
    buffer: Buffer,
    originalName: string,
  ): Promise<RowImportSummary> {
    this.logger.log(
      `Starting 4.1 Project Info import (upload): ${originalName}`,
    );

    const rows = this.parseTabularBuffer(buffer, originalName);
    this.logger.log(`Parsed ${rows.length} rows from ${originalName}`);

    /* Pre-load all projects + centers for O(1) lookup */
    const allProjects = await this.projectRepo.find();
    const projectsByCode = new Map<string, Project>(
      allProjects.map((p) => [p.code, p]),
    );
    const allCenters = await this.centerRepo.find();
    const systemUser = await this.getOrCreateSystemUser();

    /* Pre-load every existing synthetic FY26 Anaplan budget line so the
       per-project upsert below is a single in-memory lookup. Keyed by
       project_id; only `external_code` rows that follow our synthetic
       pattern are kept — real 4.3 budget rows are left untouched. */
    const existingAnaplanBudgets = await this.budgetRepo.find({
      where: { externalCode: Like(`${ANAPLAN_BUDGET_EXTERNAL_PREFIX}%`) },
    });
    const anaplanBudgetByProjectId = new Map<number, ProjectBudget>(
      existingAnaplanBudgets.map((b) => [b.projectId, b]),
    );

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors: { row: number; code?: string; reason: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNumber = i + 2; /* +2 for header + 0-index */

      try {
        const code = (row.Code || '').trim();
        if (!code) {
          /* Silent skip is dangerous — record an explicit error so the
             admin sees exactly which rows were ignored and why. The
             skipped counter is still incremented so totals stay sensible. */
          skipped++;
          errors.push({
            row: rowNumber,
            reason: 'row missing Code — cannot identify project',
          });
          continue;
        }

        /* Pre-compute structured fields so they are reused for both
           the create and the update paths below. capString() truncates
           any over-length value to fit the varchar column and pushes a
           warning row so the admin sees which CSV rows had bad cells
           (usually from a malformed quoted multi-line value). */
        const funder = this.capString(
          (row.Funder || '').trim() || null,
          255,
          'funder',
          rowNumber,
          code,
          errors,
        );
        const funderPrimaryCenter = this.capString(
          (row['Funder of the Primary Center'] || '').trim() || null,
          255,
          'funder_primary_center',
          rowNumber,
          code,
          errors,
        );
        const natureOfFunder = this.validateEnum<NatureOfFunder>(
          row['Nature of Funder'],
          Object.values(NatureOfFunder) as string[],
          'Nature of Funder',
          code,
        );
        /* Legacy columns — the May-2026 Anaplan revision dropped
           Status / Category / CSP / Reason for Non-collection of CSP.
           We still read them (defensive; older exports may include them)
           but treat absence as "do not touch the existing value" on
           update. The variables below are null when the column is gone. */
        const category = this.validateEnum<ProjectCategory>(
          row.Category,
          Object.values(ProjectCategory) as string[],
          'Category',
          code,
        );
        const cspRaw = (row.CSP || '').trim().toUpperCase();
        const csp: CspFlag | null =
          cspRaw === 'YES' ? CspFlag.YES : cspRaw === 'NO' ? CspFlag.NO : null;
        const cspNonCollectionReason = this.capString(
          (row['Reason for Non-collection of CSP'] || '').trim() || null,
          255,
          'csp_non_collection_reason',
          rowNumber,
          code,
          errors,
        );
        const totalPledge = this.parseDecimal(row['Total Pledge']);
        const principalInvestigator = this.capString(
          (row['Principal investigator'] || '').trim() || null,
          255,
          'principal_investigator',
          rowNumber,
          code,
          errors,
        );
        const signedContractTitle = this.capString(
          (row['Signed Contract Title'] || '').trim() || null,
          500,
          'signed_contract_title',
          rowNumber,
          code,
          errors,
        );

        /* Lifecycle status — legacy export used true/false. Absent in
           the May-2026 revision, so most rows leave this null. */
        const statusRaw = (row.Status || '').trim().toLowerCase();
        const explicitStatus: ProjectStatus | null =
          statusRaw === 'true'
            ? ProjectStatus.ACTIVE
            : statusRaw === 'false'
              ? ProjectStatus.ARCHIVED
              : null;

        /* Source of funding column header has two spaces between words
           in the new exports; tolerate both. */
        const fundingSourceRaw =
          row['Source of Funding'] ||
          row['Source of  Funding'] ||
          row['Source of funding'] ||
          '';
        const fundingSource = this.normalizeFundingSource(fundingSourceRaw);

        /* Date columns also have two spaces in the new exports. */
        const startDateRaw = row['Start Date'] || row['Start  Date'] || '';
        const endDateRaw = row['End Date'] || row['End  Date'] || '';
        const startDate = this.parseDate(startDateRaw);
        const endDate = this.parseDate(endDateRaw);

        /* New Anaplan 2026 columns (sheet "4.1-update5May26"). The
           "2026 Budget" header ships with a leading space in the export —
           tolerate both forms. */
        const email = this.capString(
          (row.Email || '').trim() || null,
          255,
          'email',
          rowNumber,
          code,
          errors,
        );
        const exp2025 = this.parseDecimal(row['2025 Exp']);
        const anaplanBudget2026 = this.parseDecimal(row['2026 Budget']);
        const exp2026 = this.parseDecimal(row['2026 EXP']);
        const in2026Raw = (row['2026 YES/NO'] || '').trim().toUpperCase();
        const in2026: In2026 | null =
          in2026Raw === 'YES'
            ? In2026.YES
            : in2026Raw === 'NO'
              ? In2026.NO
              : null;
        const budget2026Simulation = this.parseDecimal(
          row['2026 Budget simulation'],
        );

        /* `total_budget` (the project-level allocation target) is now
           sourced from the "2026 Budget simulation" cell, which the
           portfolio team treats as canonical. Falls back to the raw
           "2026 Budget" when simulation is blank. */
        const canonicalTotalBudget = budget2026Simulation ?? anaplanBudget2026;

        const project = projectsByCode.get(code);

        if (project) {
          /* ----- UPDATE PATH -----
             Rule: only overwrite a field when the new template carries a
             value for it. Columns dropped from the May-2026 Anaplan
             revision (category / csp / cspNonCollectionReason / status)
             are LEFT ALONE on update so the historical values stay
             visible in detail views and exports. */
          if (funder !== null) project.funder = funder;
          if (funderPrimaryCenter !== null)
            project.funderPrimaryCenter = funderPrimaryCenter;
          if (natureOfFunder !== null) project.natureOfFunder = natureOfFunder;
          if (totalPledge !== null) project.totalPledge = totalPledge;
          if (principalInvestigator !== null)
            project.principalInvestigator = principalInvestigator;
          if (signedContractTitle !== null)
            project.signedContractTitle = signedContractTitle;

          /* Legacy fields — only update when the export still carries
             them (older revisions). Never null out existing data. */
          if (category !== null) project.category = category;
          if (csp !== null) project.csp = csp;
          if (cspNonCollectionReason !== null)
            project.cspNonCollectionReason = cspNonCollectionReason;
          if (explicitStatus !== null) project.status = explicitStatus;

          if (fundingSource) project.fundingSource = fundingSource;
          if (startDate) project.startDate = startDate;
          if (endDate) project.endDate = endDate;

          /* New 2026 Anaplan fields — overwrite-when-present. The
             portfolio team re-exports these on every refresh, so blank
             cells legitimately mean "no figure for this project". */
          if (email !== null) project.email = email;
          if (exp2025 !== null) project.exp2025 = exp2025;
          if (anaplanBudget2026 !== null)
            project.anaplanBudget2026 = anaplanBudget2026;
          if (exp2026 !== null) project.exp2026 = exp2026;
          if (in2026 !== null) project.in2026 = in2026;
          if (budget2026Simulation !== null)
            project.budget2026Simulation = budget2026Simulation;

          /* `total_budget` mirrors the canonical 2026 figure. Only
             update when the new template actually provided one — keeps
             the existing value intact when both 2026 cells are blank. */
          if (canonicalTotalBudget !== null)
            project.totalBudget = canonicalTotalBudget;

          await this.projectRepo.save(project);

          /* Mirror the canonical 2026 figure into project_budgets so it
             appears in the fiscal-year breakdown. Skip when the new
             template carries no 2026 value — overwriting an existing
             synthetic row to 0 would mislead the dashboard. */
          if (canonicalTotalBudget !== null) {
            await this.upsertAnaplanBudget2026(
              project.id,
              project.code,
              canonicalTotalBudget,
              anaplanBudgetByProjectId,
            );
          }
          updated++;
        } else {
          /* ----- CREATE PATH ----- */
          const entityName = (row.Entity || '').trim();
          if (!entityName) {
            errors.push({
              row: rowNumber,
              code,
              reason: 'no Entity column value — cannot resolve center',
            });
            continue;
          }

          const center = this.resolveCenter(entityName, allCenters);
          if (!center) {
            errors.push({
              row: rowNumber,
              code,
              reason: `no matching center for entity "${entityName}"`,
            });
            continue;
          }

          /* Pick the best human-readable name we have. */
          const projectName =
            signedContractTitle ||
            (row[''] || '').trim() ||
            code; /* csv-parse maps the row-label first column to '' */

          const cappedName =
            this.capString(projectName, 500, 'name', rowNumber, code, errors) ??
            code;

          const fresh = this.projectRepo.create({
            code,
            name: cappedName,
            description: null,
            summary: null,
            results: null,
            startDate,
            endDate,
            /* total_budget mirrors the canonical 2026 figure (simulation,
               falling back to raw 2026 budget). Zero when both are blank
               so the column stays NOT NULL. */
            totalBudget: canonicalTotalBudget ?? 0,
            remainingBudget: 0,
            fundingSource,
            funder,
            status: explicitStatus ?? ProjectStatus.ACTIVE,
            negotiationLocked: false,
            centerId: center.id,
            createdById: systemUser.id,
            funderPrimaryCenter,
            natureOfFunder,
            category,
            csp,
            cspNonCollectionReason,
            totalPledge,
            principalInvestigator,
            signedContractTitle,
            /* New Anaplan 2026 fields. */
            email,
            exp2025,
            anaplanBudget2026,
            exp2026,
            in2026,
            budget2026Simulation,
          });

          const saved = await this.projectRepo.save(fresh);
          /* Track in the in-memory map so a duplicate `code` later in the
             same upload is treated as an update on the second hit. */
          projectsByCode.set(code, saved);

          /* Same mirroring as the update path — only emit a budget row
             when the new template provided a value. */
          if (canonicalTotalBudget !== null) {
            await this.upsertAnaplanBudget2026(
              saved.id,
              saved.code,
              canonicalTotalBudget,
              anaplanBudgetByProjectId,
            );
          }
          created++;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `4.1 import error on row ${rowNumber} (code=${row.Code}): ${message}`,
        );
        errors.push({
          row: rowNumber,
          code: (row.Code || '').trim() || undefined,
          reason: message,
        });
      }
    }

    this.logger.log(
      `4.1 Project Info import complete: created=${created}, updated=${updated}, ` +
        `skipped=${skipped}, errors=${errors.length}`,
    );

    await this.recordImportRun(originalName, {
      created,
      updated,
      skipped,
      errors: errors.length,
    });

    return { created, updated, skipped, errors };
  }

  /* ================================================================== */
  /* 4.3 Project Budget importer                                         */
  /* ================================================================== */

  /**
   * Imports fiscal-year budget lines from the 4.3 Project Budget CSV
   * (legacy file-path entry point).
   *
   * @param filePath - Absolute path to the 4.3 Project Budget CSV.
   */
  async importProjectBudgets(filePath: string): Promise<RowImportSummary> {
    this.logger.log(`Starting 4.3 Project Budget import from: ${filePath}`);
    const buffer = fs.readFileSync(filePath);
    return this.importProjectBudgetsFromBuffer(buffer, path.basename(filePath));
  }

  /**
   * Imports fiscal-year budget lines from an in-memory 4.3 Project
   * Budget file (CSV or XLSX). Idempotent via the UNIQUE constraint
   * on `project_budgets.external_code`.
   *
   * Per-row errors do NOT abort the batch. Rows whose `Code project`
   * does not match an existing project are counted as `skipped`.
   * Never touches `project_mappings`.
   */
  async importProjectBudgetsFromBuffer(
    buffer: Buffer,
    originalName: string,
  ): Promise<RowImportSummary> {
    this.logger.log(
      `Starting 4.3 Project Budget import (upload): ${originalName}`,
    );

    const rows = this.parseTabularBuffer(buffer, originalName);
    this.logger.log(`Parsed ${rows.length} rows from ${originalName}`);

    /* Pre-load projects by code for O(1) lookup */
    const allProjects = await this.projectRepo.find();
    const projectsByCode = new Map<string, Project>(
      allProjects.map((p) => [p.code, p]),
    );

    /* Pre-load existing budget lines by external_code for idempotent upsert */
    const existingBudgets = await this.budgetRepo.find();
    const budgetsByExternalCode = new Map<string, ProjectBudget>();
    for (const b of existingBudgets) {
      if (b.externalCode) budgetsByExternalCode.set(b.externalCode, b);
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors: { row: number; code?: string; reason: string }[] = [];

    /* Collect entities for batched save — flushes every 500 rows */
    const pendingSaves: ProjectBudget[] = [];
    const BATCH_SIZE = 500;

    const flush = async (): Promise<void> => {
      if (pendingSaves.length === 0) return;
      await this.budgetRepo.save(pendingSaves);
      pendingSaves.length = 0;
    };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNumber = i + 2; /* header + 0-index */

      try {
        /* csv-parse with columns:true gives the empty-header column the
           key '' (empty string). xlsx sheet_to_json names blank-header
           columns __EMPTY/__EMPTY_1. Tolerate both. */
        const externalCode = (row[''] || row['__EMPTY'] || '').trim();
        const projectCode = (row['Code project'] || '').trim();

        if (!externalCode || !projectCode) {
          /* Track the skip in the counter AND surface a row-level error
             so the admin can see exactly which rows were ignored. */
          skipped++;
          errors.push({
            row: rowNumber,
            code: projectCode || undefined,
            reason: 'row missing Code project or row identifier',
          });
          continue;
        }

        const project = projectsByCode.get(projectCode);
        if (!project) {
          /* Most common cause of this is uploading 4.3 before 4.1 —
             give the admin a clear, actionable next step. */
          skipped++;
          errors.push({
            row: rowNumber,
            code: projectCode,
            reason:
              `unknown project code "${projectCode}" — import the ` +
              'corresponding 4.1 Project Info first',
          });
          continue;
        }

        const year = (row.YEAR || '').trim();
        const version = (row.VERSION || '').trim();
        const account = (row.Account || '').trim();
        const amount = this.parseDecimal(row.Amount) ?? 0;

        const existing = budgetsByExternalCode.get(externalCode);
        if (existing) {
          existing.projectId = project.id;
          existing.year = year;
          existing.version = version;
          existing.account = account;
          existing.amount = amount;
          pendingSaves.push(existing);
          updated++;
        } else {
          const fresh = this.budgetRepo.create({
            projectId: project.id,
            year,
            version,
            account,
            amount,
            externalCode,
          });
          pendingSaves.push(fresh);
          /* Track in the map so duplicate external_codes within the
             same CSV batch are treated as updates on the second hit. */
          budgetsByExternalCode.set(externalCode, fresh);
          created++;
        }

        if (pendingSaves.length >= BATCH_SIZE) {
          await flush();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`4.3 import error on row ${rowNumber}: ${message}`);
        errors.push({
          row: rowNumber,
          code: (row['Code project'] || '').trim() || undefined,
          reason: message,
        });
      }
    }

    /* Flush any remaining rows */
    await flush();

    this.logger.log(
      `4.3 Project Budget import complete: created=${created}, ` +
        `updated=${updated}, skipped=${skipped}, errors=${errors.length}`,
    );

    await this.recordImportRun(originalName, {
      created,
      updated,
      skipped,
      errors: errors.length,
    });

    return { created, updated, skipped, errors };
  }

  /* ================================================================== */
  /* Signalling importer — historical mapping seed                        */
  /* ================================================================== */

  /**
   * Imports historical project-to-program mappings from a Signalling
   * export (e.g. `Signalling_Export_ICARDA.xlsx`). One file represents
   * one center's pre-PRMS mapping state and seeds the negotiation
   * thread for every project listed.
   *
   * Behaviour highlights (full spec in the design doc):
   *  - Project lookup: by `Project Code (Anaplan)`. Unknown code →
   *    row-level error pointing the admin at the 4.1 importer.
   *  - Program lookup: by acronym (matched against `programs.official_code`
   *    case-insensitive). Unknown acronym → row-level error.
   *  - Status mapping (column "Status"):
   *      • "Keep as is"         → mapping in `negotiating`,
   *                                center_agreed = true,
   *                                program_agreed = false,
   *                                events: [initiated(baseline)]
   *      • "Increased X%"       → mapping in `negotiating`,
   *      • "Decreased X%"          allocation = proposed,
   *                                center_agreed = false,
   *                                program_agreed = true,
   *                                events: [initiated(baseline),
   *                                         counter_proposed(proposed,
   *                                                          justification)]
   *      • "Removed"            → mapping in `removed`,
   *                                both agree flags false,
   *                                events: [initiated(baseline),
   *                                         removed(baseline,
   *                                                 justification)]
   *  - Duplicate (project, program) within the file → REJECT the
   *    entire project (every row for that code becomes a row-level
   *    error; no mappings written for it).
   *  - Idempotency: existing mapping (matched by UNIQUE
   *    project_id+program_id) is updated in place. Existing
   *    `mapping_negotiations` rows for that mapping are wiped and the
   *    fresh thread replayed.
   *  - On success, the project's `negotiation_locked` flag is forced
   *    to false in one batch UPDATE — historical seeds always start
   *    unlocked so negotiation can continue in PRMS.
   *  - Allocation-sum warning: when the sum of allocations for a
   *    project ≠ 100, a non-fatal informational entry is appended to
   *    `errors` (does NOT increment skipped).
   *  - The entire write phase runs inside a single DB transaction —
   *    parsing / validation errors that fall through before the
   *    transaction starts are still surfaced per-row.
   */
  async importSignallingFromBuffer(
    buffer: Buffer,
    originalName: string,
  ): Promise<RowImportSummary> {
    this.logger.log(`Starting Signalling import (upload): ${originalName}`);

    const rows = this.parseTabularBuffer(buffer, originalName);
    this.logger.log(`Parsed ${rows.length} rows from ${originalName}`);

    /* Pre-load reference data for O(1) lookups */
    const allProjects = await this.projectRepo.find();
    const projectsByCode = new Map<string, Project>(
      allProjects.map((p) => [p.code, p]),
    );
    const allPrograms = await this.programRepo.find();
    /* The file carries short CGIAR acronyms (B4T, SAAF, GEI …) that
       have no direct relationship to the DB's `programs.official_code`
       values (SP01, SP02, …). The acronym is mapped to an official
       code via `SIGNALLING_PROGRAM_ACRONYM_TO_OFFICIAL_CODE`, and the
       program itself is then resolved from this lower-cased map keyed
       on `official_code` for case-insensitive lookup. */
    const programsByOfficialCode = new Map<string, Program>();
    for (const p of allPrograms) {
      const key = (p.officialCode || '').toLowerCase().trim();
      if (key) programsByOfficialCode.set(key, p);
    }
    const systemUser = await this.getOrCreateSystemUser();

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors: { row: number; code?: string; reason: string }[] = [];

    /* ---------- Phase 1 — parse every row into a typed payload ---------- */

    /* Status discriminants parsed from the file. The exact wording in
       the column drives the lifecycle outcome of the mapping. */
    type ParsedStatus = 'keep_as_is' | 'increased' | 'decreased' | 'removed';

    interface ParsedRow {
      rowNumber: number;
      code: string;
      project: Project;
      program: Program;
      programAcronym: string;
      baseline: number;
      proposed: number | null;
      justification: string | null;
      status: ParsedStatus;
    }

    /* Bucket per-project so we can do the duplicate check and the
       allocation-sum warning in one pass after parsing completes. */
    const perProject = new Map<string, ParsedRow[]>();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNumber = i + 2; /* header + 0-index */

      try {
        const code = (row['Project Code (Anaplan)'] || '').trim();
        if (!code) {
          skipped++;
          errors.push({
            row: rowNumber,
            reason:
              'row missing Project Code (Anaplan) — cannot identify project',
          });
          continue;
        }

        const project = projectsByCode.get(code);
        if (!project) {
          skipped++;
          errors.push({
            row: rowNumber,
            code,
            reason:
              `unknown project code "${code}" — import the ` +
              'corresponding 4.1 Project Info first',
          });
          continue;
        }

        const programAcronymRaw = (row.Program || '').trim();
        if (!programAcronymRaw) {
          skipped++;
          errors.push({
            row: rowNumber,
            code,
            reason: 'row missing Program acronym',
          });
          continue;
        }
        /* Resolve the short signalling acronym (e.g. "B4T") to a DB
           `official_code` (e.g. "SP01") via the explicit map. We
           uppercase defensively even though the file is consistent on
           casing — there is no fuzzy fallback: an unknown acronym is
           a hard row-level error. */
        const programAcronymKey = programAcronymRaw.toUpperCase();
        const mappedOfficialCode =
          SIGNALLING_PROGRAM_ACRONYM_TO_OFFICIAL_CODE[programAcronymKey];
        if (!mappedOfficialCode) {
          skipped++;
          errors.push({
            row: rowNumber,
            code,
            reason:
              `unknown program acronym "${programAcronymRaw}" — no ` +
              'mapping defined for this signalling shortcode',
          });
          continue;
        }
        const program = programsByOfficialCode.get(
          mappedOfficialCode.toLowerCase(),
        );
        if (!program) {
          skipped++;
          errors.push({
            row: rowNumber,
            code,
            reason:
              `program "${programAcronymRaw}" maps to official_code ` +
              `"${mappedOfficialCode}" but no program with that code ` +
              'exists in the database',
          });
          continue;
        }

        const baseline = this.parseDecimal(row['Baseline mapping 2025 %']);
        if (baseline === null) {
          skipped++;
          errors.push({
            row: rowNumber,
            code,
            reason: 'invalid or missing "Baseline mapping 2025 %" — required',
          });
          continue;
        }
        const proposed = this.parseDecimal(row['Proposed mapping %']);

        const statusRaw = (row.Status || '').trim();
        let parsedStatus: ParsedStatus | null = null;
        if (/^Keep as is$/i.test(statusRaw)) parsedStatus = 'keep_as_is';
        else if (/^Increased/i.test(statusRaw)) parsedStatus = 'increased';
        else if (/^Decreased/i.test(statusRaw)) parsedStatus = 'decreased';
        else if (/^Removed$/i.test(statusRaw)) parsedStatus = 'removed';

        if (!parsedStatus) {
          skipped++;
          errors.push({
            row: rowNumber,
            code,
            reason: `unknown Status "${statusRaw}"`,
          });
          continue;
        }

        /* Increased / Decreased rows require a Proposed mapping %.
           Without it we cannot record the counter_proposed event. */
        if (
          (parsedStatus === 'increased' || parsedStatus === 'decreased') &&
          proposed === null
        ) {
          skipped++;
          errors.push({
            row: rowNumber,
            code,
            reason: `Status "${statusRaw}" requires a "Proposed mapping %" value`,
          });
          continue;
        }

        const justificationRaw = (row['Latest justification'] || '').trim();
        const justification = justificationRaw === '' ? null : justificationRaw;

        const parsed: ParsedRow = {
          rowNumber,
          code,
          project,
          program,
          programAcronym: programAcronymRaw,
          baseline,
          proposed,
          justification,
          status: parsedStatus,
        };

        const bucket = perProject.get(code) ?? [];
        bucket.push(parsed);
        perProject.set(code, bucket);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Signalling import parse error on row ${rowNumber}: ${message}`,
        );
        errors.push({
          row: rowNumber,
          code: (row['Project Code (Anaplan)'] || '').trim() || undefined,
          reason: message,
        });
      }
    }

    /* ---------- Phase 2 — duplicate detection per project ---------- */

    /* A project that has more than one row for the same program is
       rejected wholesale. We mark its bucket as null so the write
       phase below skips it entirely. */
    const projectsToWrite = new Map<string, ParsedRow[]>();
    for (const [code, parsedRows] of perProject.entries()) {
      const seen = new Map<number, ParsedRow>();
      const dupes = new Set<number>();
      for (const pr of parsedRows) {
        if (seen.has(pr.program.id)) {
          dupes.add(pr.program.id);
        } else {
          seen.set(pr.program.id, pr);
        }
      }
      if (dupes.size > 0) {
        for (const pr of parsedRows) {
          if (dupes.has(pr.program.id)) {
            skipped++;
            errors.push({
              row: pr.rowNumber,
              code,
              reason:
                `duplicate (project=${code}, program=${pr.programAcronym}) — ` +
                'project skipped',
            });
          }
        }
        /* Drop the whole project — do NOT write any of its mappings. */
        continue;
      }
      projectsToWrite.set(code, parsedRows);
    }

    /* ---------- Phase 3 — write phase (single transaction) ---------- */

    /* All inserts/updates for the surviving projects commit or roll
       back together. A single project spans multiple INSERTs across
       project_mappings and mapping_negotiations (plus a final UPDATE
       on projects to clear negotiation_locked), so atomicity matters
       — a partial write would leave a project in an inconsistent
       state. */
    const writtenProjectIds = new Set<number>();

    try {
      await this.dataSource.transaction(async (manager: EntityManager) => {
        const now = Date.now();
        /* Per-event timestamp counter so events for the same mapping
           sort in the right order in mapping_negotiations even on
           DBs whose datetime resolution is coarser than 1ms. */
        let eventTickOffset = 0;
        const nextEventTimestamp = (): Date => {
          const ts = new Date(now + eventTickOffset);
          eventTickOffset += 1;
          return ts;
        };

        for (const [code, parsedRows] of projectsToWrite.entries()) {
          for (const pr of parsedRows) {
            try {
              /* Decide the final allocation, status, and agreement
                 flags from the parsed status. */
              let finalAllocation: number;
              let mappingStatus: MappingStatus;
              let centerAgreed: boolean;
              let programAgreed: boolean;
              const events: {
                eventType: NegotiationEventType;
                proposedAllocation: number;
                justification: string | null;
              }[] = [];

              /* TOC + Signalling represent the FINAL, workflow-admin-
                 approved state of the round — not in-flight
                 negotiation. The pre-PRMS conversation is preserved
                 in the negotiation thread for audit, but the
                 mapping's lifecycle status reflects the final
                 outcome (AGREED or REMOVED). The thread is wiped
                 and replayed below, so TOC's seed `initiated` event
                 must be re-emitted here as well (allocation = the
                 baseline value TOC wrote). */
              if (pr.status === 'keep_as_is') {
                /* Nothing happened on the program side — TOC's
                   initiated event is the entire story. */
                finalAllocation = pr.baseline;
                mappingStatus = MappingStatus.AGREED;
                centerAgreed = true;
                programAgreed = true;
                events.push({
                  eventType: NegotiationEventType.INITIATED,
                  proposedAllocation: pr.baseline,
                  justification: null,
                });
              } else if (
                pr.status === 'increased' ||
                pr.status === 'decreased'
              ) {
                /* proposed is non-null here (validated in phase 1).
                   Program rep counter-proposed and the workflow
                   admin blessed the final value — emit
                   initiated → counter_proposed → agreed. */
                finalAllocation = pr.proposed as number;
                mappingStatus = MappingStatus.AGREED;
                centerAgreed = true;
                programAgreed = true;
                events.push({
                  eventType: NegotiationEventType.INITIATED,
                  proposedAllocation: pr.baseline,
                  justification: null,
                });
                events.push({
                  eventType: NegotiationEventType.COUNTER_PROPOSED,
                  proposedAllocation: pr.proposed as number,
                  justification: pr.justification,
                });
                events.push({
                  eventType: NegotiationEventType.AGREED,
                  proposedAllocation: pr.proposed as number,
                  justification: null,
                });
              } else {
                /* removed — program excluded from the round. */
                finalAllocation = pr.baseline;
                mappingStatus = MappingStatus.REMOVED;
                centerAgreed = false;
                programAgreed = false;
                events.push({
                  eventType: NegotiationEventType.INITIATED,
                  proposedAllocation: pr.baseline,
                  justification: null,
                });
                events.push({
                  eventType: NegotiationEventType.REMOVED,
                  proposedAllocation: pr.baseline,
                  justification: pr.justification,
                });
              }

              /* Upsert the mapping (UNIQUE on project_id+program_id). */
              const existing = await manager.findOne(ProjectMapping, {
                where: {
                  projectId: pr.project.id,
                  programId: pr.program.id,
                },
              });

              let mapping: ProjectMapping;
              const initiatedAt = new Date(now);

              if (existing) {
                existing.allocationPercentage = finalAllocation;
                existing.status = mappingStatus;
                existing.centerAgreed = centerAgreed;
                existing.programAgreed = programAgreed;
                existing.initiatedById = systemUser.id;
                existing.initiatedAt = initiatedAt;
                /* Historical seeds never carry assistance / removal
                   request state — keep both clear on re-import. */
                existing.needsAssistance = false;
                existing.flaggedAt = null;
                existing.removalRequested = false;
                existing.removalRequestedById = null;
                existing.removalRequestedAt = null;
                existing.removalJustification = null;
                /* Preserve any existing ratings — signalling is a
                   program-side activity and per CLAUDE.md must not
                   touch the center-side complementarity / efficiency
                   ratings already seeded by TOC. The fields are left
                   exactly as they were on the existing row. */
                mapping = await manager.save(ProjectMapping, existing);
                updated++;
              } else {
                const fresh = manager.create(ProjectMapping, {
                  projectId: pr.project.id,
                  programId: pr.program.id,
                  allocationPercentage: finalAllocation,
                  status: mappingStatus,
                  centerAgreed,
                  programAgreed,
                  initiatedById: systemUser.id,
                  initiatedAt,
                  needsAssistance: false,
                  flaggedAt: null,
                  removalRequested: false,
                  removalRequestedById: null,
                  removalRequestedAt: null,
                  removalJustification: null,
                  complementarityRating: null,
                  efficiencyRating: null,
                });
                mapping = await manager.save(ProjectMapping, fresh);
                created++;
              }

              /* Wipe any existing negotiation thread for this mapping
                 and replay the canonical seed thread. Safe because
                 the rows are an audit trail and hold no other state. */
              await manager.delete(MappingNegotiation, {
                mappingId: mapping.id,
              });

              for (const ev of events) {
                const event = new MappingNegotiation();
                event.mappingId = mapping.id;
                event.actorId = systemUser.id;
                /* The DB enum on mapping_negotiations.actor_role does
                   NOT include `system`; the system import user is an
                   admin, so log moves as `admin`. */
                event.actorRole = ActorRole.ADMIN;
                event.eventType = ev.eventType;
                event.proposedAllocation = ev.proposedAllocation;
                event.justification = ev.justification;
                event.createdAt = nextEventTimestamp();
                await manager.save(MappingNegotiation, event);
              }

              writtenProjectIds.add(pr.project.id);
            } catch (error) {
              /* Re-throw so the transaction rolls back — we cannot
                 leave half a project written. Wrap with row context
                 so the caller's catch records a useful message. */
              const message =
                error instanceof Error ? error.message : String(error);
              throw new Error(
                `row ${pr.rowNumber} (code=${pr.code}, ` +
                  `program=${pr.programAcronym}): ${message}`,
              );
            }
          }
        }

        /* Signalling is the closing pass — TOC + Signalling together
           represent the final, workflow-admin-approved round, so we
           lock every touched project in a single statement. PRMS
           users can still reopen via the regular reopen endpoint if
           a correction is needed after import. */
        if (writtenProjectIds.size > 0) {
          await manager
            .createQueryBuilder()
            .update(Project)
            .set({ negotiationLocked: true })
            .whereInIds(Array.from(writtenProjectIds))
            .execute();
        }
      });
    } catch (error) {
      /* A transaction-level failure rolls back every project. Surface
         it as a single error row so the admin sees why nothing
         landed; per-row errors collected above are still returned. */
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Signalling import transaction failed for ${originalName}: ${message}`,
      );
      errors.push({
        row: 0,
        reason: `transaction failed — no mappings written: ${message}`,
      });
      /* Reset the counters; nothing actually committed. */
      created = 0;
      updated = 0;
    }

    /* ---------- Phase 4 — allocation-sum warnings (informational) ---------- */

    /* Only warn for projects whose write succeeded. A project whose
       transaction was rolled back already has a row-0 error above. */
    if (writtenProjectIds.size > 0) {
      for (const [code, parsedRows] of projectsToWrite.entries()) {
        if (!parsedRows.length) continue;
        const projectId = parsedRows[0].project.id;
        if (!writtenProjectIds.has(projectId)) continue;
        /* Sum of allocations across non-removed mappings only —
           removed mappings carry the baseline for audit but should
           not count toward the 100% portfolio target. */
        const sum = parsedRows
          .filter((r) => r.status !== 'removed')
          .reduce((acc, r) => {
            const alloc =
              r.status === 'increased' || r.status === 'decreased'
                ? (r.proposed as number)
                : r.baseline;
            return acc + alloc;
          }, 0);
        /* Compare with a small tolerance — allocations are decimal(5,2)
           and the file's two-decimal precision means an exact 100.00
           sum is normal, but rounding noise can still produce
           99.99 / 100.01. */
        if (Math.abs(sum - 100) > 0.01) {
          errors.push({
            row: 0,
            code,
            reason: `project ${code}: allocation sum is ${sum} (expected 100)`,
          });
        }
      }
    }

    this.logger.log(
      `Signalling import complete: created=${created}, ` +
        `updated=${updated}, skipped=${skipped}, errors=${errors.length}`,
    );

    await this.recordImportRun(originalName, {
      created,
      updated,
      skipped,
      errors: errors.length,
    });

    return { created, updated, skipped, errors };
  }

  /* ================================================================== */
  /* TOC importer — seeds center-side mappings + ratings from           */
  /* TOC_Projects.csv. Runs AFTER 4.1 (so projects exist) and BEFORE    */
  /* signalling (so signalling can layer per-mapping deltas on top).    */
  /* TOC must never create or modify projects — Anaplan is the source  */
  /* of truth for project metadata.                                     */
  /* ================================================================== */

  /**
   * Parses a TOC rating cell ("High" / "Medium" / "Med" / "Low" / blank).
   *
   * Returns:
   * - `null` for blank input.
   * - The matching {@link Rating} enum for recognized values.
   * - `null` for any other non-empty value AND pushes a row-level
   *   WARNING into `errors` so the admin can spot bad data without
   *   the row being rejected.
   */
  private parseTocRating(
    raw: string | null | undefined,
    fieldName: string,
    rowNumber: number,
    code: string | undefined,
    errors: { row: number; code?: string; reason: string }[],
  ): Rating | null {
    const trimmed = (raw || '').trim();
    if (trimmed === '') return null;
    const normalized = trimmed.toLowerCase();
    if (normalized === 'high') return Rating.HIGH;
    if (normalized === 'med' || normalized === 'medium') return Rating.MEDIUM;
    if (normalized === 'low') return Rating.LOW;
    /* Non-empty but unrecognized — warning, not a fatal row error. The
       row continues with a null rating, matching the legacy behaviour
       where ratings can be filled later by a center-side edit. */
    errors.push({
      row: rowNumber,
      code,
      reason: `unknown rating value "${trimmed}" in ${fieldName}`,
    });
    return null;
  }

  /**
   * Runs the TOC importer against an in-memory CSV / XLSX buffer.
   *
   * TOC is the source of truth for **center-side mappings + ratings**:
   *   - allocation_percentage      (= "Budget allocation from Project to Program" * 100)
   *   - complementarity_rating     (= "Complementarity of Results SI")
   *   - efficiency_rating          (= "Efficiencies/Strategic Benefit SI")
   *
   * Strict invariants:
   *   - NEVER creates or modifies a project. Unknown project codes are
   *     skipped with a row-level error.
   *   - Rows whose `Center` column does not resolve are SILENTLY
   *     skipped (different-center rows are not in scope and must not
   *     pollute the error list).
   *   - When `Center` resolves to a different center than the
   *     project's owning center (Anaplan), the row is rejected with a
   *     row-level error — the file is internally inconsistent.
   *
   * Phases (mirrors signalling):
   *  1. Parse + validate every row, bucket by project code.
   *  2. Reject whole projects that have duplicate (project, program)
   *     pairs.
   *  3. Write surviving mappings in one transaction: upsert mapping,
   *     wipe + replay a single `initiated` event, batch-clear
   *     `negotiation_locked` on every touched project.
   *  4. Push an informational row-0 entry for any project whose
   *     allocation sum != 100 (± 0.01).
   *  5. Record the import.run audit row.
   */
  async importTocFromBuffer(
    buffer: Buffer,
    originalName: string,
  ): Promise<RowImportSummary> {
    this.logger.log(`Starting TOC import (upload): ${originalName}`);

    const rows = this.parseTabularBuffer(buffer, originalName);
    this.logger.log(`Parsed ${rows.length} rows from ${originalName}`);

    /* Pre-load reference data for O(1) lookups */
    const allProjects = await this.projectRepo.find();
    const projectsByCode = new Map<string, Project>(
      allProjects.map((p) => [p.code, p]),
    );
    /* Secondary lookup by normalized name. TOC's Name cell starts with
       the project code (e.g. "D-200440-Long title…") but new exports
       sometimes ship rows whose code has drifted between Anaplan
       revisions. Match-by-name acts as a fallback when the code lookup
       misses, so a known project is not skipped just because its code
       shifted.

       Normalization: strip non-breaking spaces, collapse whitespace,
       lowercase, trim. Duplicate normalized names from different
       projects are dropped from the index so we never resolve to an
       ambiguous match — better to error than to write the wrong
       mapping. */
    const projectsByNormalizedName = new Map<string, Project>();
    const ambiguousNameKeys = new Set<string>();
    for (const p of allProjects) {
      const key = (p.name || '')
        .replace(/ /g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      if (!key) continue;
      if (projectsByNormalizedName.has(key)) {
        ambiguousNameKeys.add(key);
        projectsByNormalizedName.delete(key);
      } else if (!ambiguousNameKeys.has(key)) {
        projectsByNormalizedName.set(key, p);
      }
    }
    const allCenters = await this.centerRepo.find();
    const allPrograms = await this.programRepo.find();
    const programsByOfficialCode = new Map<string, Program>();
    for (const p of allPrograms) {
      const key = (p.officialCode || '').toLowerCase().trim();
      if (key) programsByOfficialCode.set(key, p);
    }
    const systemUser = await this.getOrCreateSystemUser();

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors: { row: number; code?: string; reason: string }[] = [];

    /* ---------- Phase 1 — parse every row into a typed payload ---------- */

    interface ParsedRow {
      rowNumber: number;
      code: string;
      project: Project;
      program: Program;
      allocationPercentage: number;
      complementarityRating: Rating | null;
      efficiencyRating: Rating | null;
    }

    const perProject = new Map<string, ParsedRow[]>();

    /* The same regex shape the legacy TOC `extractCodeAndName` helper
       uses, but tightened to the spec's requirement: a single alpha
       prefix + optional `-` + digits at the very start of the cell.
       We only need the code here — name belongs to Anaplan. */
    const codeFromName = /^([A-Z]-?\d+)\b/i;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNumber = i + 2; /* header + 0-index */

      try {
        const rawName = (row.Name || '').trim();
        if (!rawName) {
          skipped++;
          errors.push({
            row: rowNumber,
            reason: 'row missing Name — cannot extract project code',
          });
          continue;
        }

        const codeMatch = rawName.match(codeFromName);
        const code = codeMatch ? codeMatch[1].toUpperCase() : null;

        let project = code ? projectsByCode.get(code) : undefined;
        let resolvedBy: 'code' | 'name' | null = project ? 'code' : null;

        /* Code lookup missed (or no code could be extracted). Fall back
           to matching against the project's `name` column. We try two
           normalizations: the raw TOC Name cell, and the same cell with
           the leading "<code>-" prefix stripped — Anaplan's project.name
           is usually the title alone, but some legacy rows keep the
           "<code>-<title>" form so we accept either. */
        if (!project) {
          const titleAfterCode = codeMatch
            ? rawName.slice(codeMatch[0].length).replace(/^[\s-]+/, '')
            : rawName;
          const candidates = [rawName, titleAfterCode].filter(Boolean);
          for (const cand of candidates) {
            const key = cand
              .replace(/ /g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .toLowerCase();
            if (!key) continue;
            const hit = projectsByNormalizedName.get(key);
            if (hit) {
              project = hit;
              resolvedBy = 'name';
              break;
            }
          }
        }

        if (!project) {
          skipped++;
          const isAmbiguous =
            !code &&
            ambiguousNameKeys.has(
              rawName
                .replace(/ /g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase(),
            );
          errors.push({
            row: rowNumber,
            code: code ?? undefined,
            reason: isAmbiguous
              ? `name "${rawName}" matches multiple projects — refusing to guess`
              : code
                ? `unknown project code "${code}" and no project matches Name "${rawName}" — import the corresponding 4.1 Anaplan first`
                : `cannot extract project code from Name "${rawName}" and no project matches by name`,
          });
          continue;
        }

        /* When we fell back to name resolution, the project's actual
           code may differ from whatever we extracted from the Name
           cell. Use the resolved project's real code for all
           downstream bookkeeping. */
        const resolvedCode = project.code;
        void resolvedBy; /* reserved for future logging if needed */

        /* Center resolution — different-center rows are NOT in scope
           and must not be logged as errors. A row whose Center cell
           does not resolve to any known center is silently skipped. */
        const centerCell = (row.Center || '').trim();
        const resolvedCenter = centerCell
          ? this.resolveCenter(centerCell, allCenters)
          : null;
        if (!resolvedCenter) {
          /* Silent skip — does not count as a skipped error row. */
          continue;
        }

        /* Project / center disagreement is a real data error — the
           file says one center, Anaplan says another. We reject the
           row and let the admin sort out the inconsistency. */
        if (project.centerId !== resolvedCenter.id) {
          skipped++;
          errors.push({
            row: rowNumber,
            code: resolvedCode,
            reason:
              `project ${resolvedCode} belongs to center ${project.centerId} ` +
              `but TOC row says ${resolvedCenter.name} ` +
              `(id=${resolvedCenter.id})`,
          });
          continue;
        }

        /* Program name normalization: strip non-breaking spaces, trim,
           lower-case — then look up an official_code in the static
           map, and finally resolve the program row by official_code. */
        const programCellRaw = (row.Program || '').toString();
        const programKey = programCellRaw
          .replace(/ /g, ' ')
          .trim()
          .toLowerCase();
        if (!programKey) {
          skipped++;
          errors.push({
            row: rowNumber,
            code: resolvedCode,
            reason: 'row missing Program name',
          });
          continue;
        }
        const officialCode = TOC_PROGRAM_NAME_TO_OFFICIAL_CODE[programKey];
        if (!officialCode) {
          skipped++;
          errors.push({
            row: rowNumber,
            code: resolvedCode,
            reason: `unknown program name "${programCellRaw.trim()}"`,
          });
          continue;
        }
        const program = programsByOfficialCode.get(officialCode.toLowerCase());
        if (!program) {
          skipped++;
          errors.push({
            row: rowNumber,
            code: resolvedCode,
            reason:
              `program "${programCellRaw.trim()}" maps to official_code ` +
              `"${officialCode}" but no program with that code exists ` +
              'in the database',
          });
          continue;
        }

        /* Allocation must be a fraction in (0, 1]. Anything else is a
           row-level error — we don't silently coerce 0 / null because
           that would create a meaningless 0% mapping. */
        const allocationRaw = row['Budget allocation from Project to Program'];
        const allocationCell = (allocationRaw ?? '').toString().trim();
        const allocationNum = parseFloat(allocationCell);
        if (
          allocationCell === '' ||
          isNaN(allocationNum) ||
          allocationNum <= 0 ||
          allocationNum > 1
        ) {
          skipped++;
          errors.push({
            row: rowNumber,
            code: resolvedCode,
            reason:
              `invalid allocation "${allocationCell}" — must be a ` +
              'fraction between 0 and 1',
          });
          continue;
        }
        const allocationPercentage =
          Math.round(allocationNum * 100 * 100) / 100;

        /* Ratings — warnings only on unknown values; null is allowed. */
        const complementarityRating = this.parseTocRating(
          row['Complementarity of Results SI'],
          'Complementarity of Results SI',
          rowNumber,
          resolvedCode,
          errors,
        );
        const efficiencyRating = this.parseTocRating(
          row['Efficiencies/Strategic Benefit SI'],
          'Efficiencies/Strategic Benefit SI',
          rowNumber,
          resolvedCode,
          errors,
        );

        const parsed: ParsedRow = {
          rowNumber,
          code: resolvedCode,
          project,
          program,
          allocationPercentage,
          complementarityRating,
          efficiencyRating,
        };
        const bucket = perProject.get(resolvedCode) ?? [];
        bucket.push(parsed);
        perProject.set(resolvedCode, bucket);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `TOC import parse error on row ${rowNumber}: ${message}`,
        );
        errors.push({
          row: rowNumber,
          reason: message,
        });
      }
    }

    /* ---------- Phase 2 — duplicate detection per project ---------- */

    const projectsToWrite = new Map<string, ParsedRow[]>();
    for (const [code, parsedRows] of perProject.entries()) {
      const seen = new Map<number, ParsedRow>();
      const dupes = new Set<number>();
      for (const pr of parsedRows) {
        if (seen.has(pr.program.id)) {
          dupes.add(pr.program.id);
        } else {
          seen.set(pr.program.id, pr);
        }
      }
      if (dupes.size > 0) {
        for (const pr of parsedRows) {
          if (dupes.has(pr.program.id)) {
            skipped++;
            errors.push({
              row: pr.rowNumber,
              code,
              reason:
                `duplicate (project=${code}, ` +
                `program=${pr.program.officialCode}) — project skipped`,
            });
          }
        }
        continue;
      }
      projectsToWrite.set(code, parsedRows);
    }

    /* ---------- Phase 3 — write phase (single transaction) ---------- */

    const writtenProjectIds = new Set<number>();

    try {
      await this.dataSource.transaction(async (manager: EntityManager) => {
        const now = Date.now();
        let eventTickOffset = 0;
        const nextEventTimestamp = (): Date => {
          const ts = new Date(now + eventTickOffset);
          eventTickOffset += 1;
          return ts;
        };

        for (const [code, parsedRows] of projectsToWrite.entries()) {
          for (const pr of parsedRows) {
            try {
              const initiatedAt = new Date(now);

              const existing = await manager.findOne(ProjectMapping, {
                where: {
                  projectId: pr.project.id,
                  programId: pr.program.id,
                },
              });

              let mapping: ProjectMapping;
              if (existing) {
                existing.allocationPercentage = pr.allocationPercentage;
                /* TOC represents the final, workflow-admin-approved
                   state of the round — historical mappings landed
                   here are already agreed by both sides offline. */
                existing.status = MappingStatus.AGREED;
                existing.centerAgreed = true;
                existing.programAgreed = true;
                existing.complementarityRating = pr.complementarityRating;
                existing.efficiencyRating = pr.efficiencyRating;
                existing.initiatedById = systemUser.id;
                existing.initiatedAt = initiatedAt;
                /* TOC seeds a clean negotiation state. */
                existing.needsAssistance = false;
                existing.flaggedAt = null;
                existing.removalRequested = false;
                existing.removalRequestedById = null;
                existing.removalRequestedAt = null;
                existing.removalJustification = null;
                mapping = await manager.save(ProjectMapping, existing);
                updated++;
              } else {
                const fresh = manager.create(ProjectMapping, {
                  projectId: pr.project.id,
                  programId: pr.program.id,
                  allocationPercentage: pr.allocationPercentage,
                  /* TOC represents the final, workflow-admin-approved
                     state of the round — historical mappings landed
                     here are already agreed by both sides offline. */
                  status: MappingStatus.AGREED,
                  centerAgreed: true,
                  programAgreed: true,
                  complementarityRating: pr.complementarityRating,
                  efficiencyRating: pr.efficiencyRating,
                  initiatedById: systemUser.id,
                  initiatedAt,
                  needsAssistance: false,
                  flaggedAt: null,
                  removalRequested: false,
                  removalRequestedById: null,
                  removalRequestedAt: null,
                  removalJustification: null,
                });
                mapping = await manager.save(ProjectMapping, fresh);
                created++;
              }

              /* Wipe any prior negotiation thread and replay the
                 canonical seed: one `initiated` event with the
                 allocation snapshot. No justification. */
              await manager.delete(MappingNegotiation, {
                mappingId: mapping.id,
              });

              const event = new MappingNegotiation();
              event.mappingId = mapping.id;
              event.actorId = systemUser.id;
              event.actorRole = ActorRole.ADMIN;
              event.eventType = NegotiationEventType.INITIATED;
              event.proposedAllocation = pr.allocationPercentage;
              event.justification = null;
              event.createdAt = nextEventTimestamp();
              await manager.save(MappingNegotiation, event);

              writtenProjectIds.add(pr.project.id);
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              throw new Error(
                `row ${pr.rowNumber} (code=${pr.code}, ` +
                  `program=${pr.program.officialCode}): ${message}`,
              );
            }
          }
        }

        /* Single batched unlock — every touched project starts
           unlocked so PRMS users can continue negotiation. */
        if (writtenProjectIds.size > 0) {
          await manager
            .createQueryBuilder()
            .update(Project)
            .set({ negotiationLocked: false })
            .whereInIds(Array.from(writtenProjectIds))
            .execute();
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `TOC import transaction failed for ${originalName}: ${message}`,
      );
      errors.push({
        row: 0,
        reason: `transaction failed — no mappings written: ${message}`,
      });
      created = 0;
      updated = 0;
    }

    /* ---------- Phase 4 — allocation-sum warnings (informational) ---------- */

    if (writtenProjectIds.size > 0) {
      for (const [code, parsedRows] of projectsToWrite.entries()) {
        if (!parsedRows.length) continue;
        const projectId = parsedRows[0].project.id;
        if (!writtenProjectIds.has(projectId)) continue;
        const sum = parsedRows.reduce(
          (acc, r) => acc + r.allocationPercentage,
          0,
        );
        if (Math.abs(sum - 100) > 0.01) {
          errors.push({
            row: 0,
            code,
            reason: `project ${code}: allocation sum is ${sum} (expected 100)`,
          });
        }
      }
    }

    this.logger.log(
      `TOC import complete: created=${created}, ` +
        `updated=${updated}, skipped=${skipped}, errors=${errors.length}`,
    );

    await this.recordImportRun(originalName, {
      created,
      updated,
      skipped,
      errors: errors.length,
    });

    return { created, updated, skipped, errors };
  }

  /* ================================================================== */
  /* Helpers for the 4.1 / 4.3 importers                                  */
  /* ================================================================== */

  /**
   * Writes (or updates) the synthetic FY26 "TotalBudgetAnaplan" budget
   * line for a project, mirroring the canonical 2026 Anaplan figure
   * into the `project_budgets` fiscal-year breakdown.
   *
   * Idempotent across re-imports: the row is keyed by
   * `external_code = 'anaplan-fy26:<code>'`, so re-running the importer
   * with a changed simulation value overwrites the same row instead of
   * piling on duplicates. The shared in-memory map is updated in place
   * so a duplicate project code later in the same upload also hits the
   * update path.
   *
   * The amount is required (callers must skip null inputs) — emitting
   * a zero-amount synthetic row would inflate the dashboard's
   * "projects with FY26 budget" count.
   */
  private async upsertAnaplanBudget2026(
    projectId: number,
    projectCode: string,
    amount: number,
    cache: Map<number, ProjectBudget>,
  ): Promise<void> {
    const externalCode = `${ANAPLAN_BUDGET_EXTERNAL_PREFIX}${projectCode}`;
    const existing = cache.get(projectId);

    if (existing) {
      existing.amount = amount;
      existing.year = ANAPLAN_BUDGET_YEAR;
      existing.version = ANAPLAN_BUDGET_VERSION;
      existing.account = ANAPLAN_BUDGET_ACCOUNT;
      existing.externalCode = externalCode;
      await this.budgetRepo.save(existing);
      return;
    }

    const fresh = this.budgetRepo.create({
      projectId,
      year: ANAPLAN_BUDGET_YEAR,
      version: ANAPLAN_BUDGET_VERSION,
      account: ANAPLAN_BUDGET_ACCOUNT,
      amount,
      externalCode,
    });
    const saved = await this.budgetRepo.save(fresh);
    cache.set(projectId, saved);
  }

  /**
   * Parses a decimal/money value safely.
   *
   * - Trims whitespace and strips thousands-separator commas.
   * - Returns `null` for empty/whitespace-only input.
   * - Returns `0` for literal `"0"`.
   * - Rounds to 2 decimals to match the `decimal(14,2)` column.
   * - Returns `null` on NaN to avoid poisoning the DB with bad values.
   */
  private parseDecimal(val: string | number | null | undefined): number | null {
    if (val === null || val === undefined) return null;
    const raw = typeof val === 'number' ? String(val) : val;
    const trimmed = raw.trim();
    if (trimmed === '') return null;

    const cleaned = trimmed.replace(/,/g, '');
    const num = parseFloat(cleaned);
    if (isNaN(num)) return null;

    /* Round to 2 decimals — money rule */
    return Math.round(num * 100) / 100;
  }

  /**
   * Validates that a CSV value matches one of the allowed enum values.
   *
   * Returns the value as-is when it matches, `null` when the cell is
   * empty, and `null` + a warning log entry when the value is present
   * but unrecognized.
   */
  private validateEnum<T extends string>(
    val: string | null | undefined,
    allowed: string[],
    fieldName: string,
    projectCode: string,
  ): T | null {
    const trimmed = (val || '').trim();
    if (trimmed === '') return null;

    if (allowed.includes(trimmed)) {
      return trimmed as T;
    }

    this.logger.warn(
      `Unknown ${fieldName} value "${trimmed}" for project ${projectCode} — ignored`,
    );
    return null;
  }

  /**
   * Caps a string to fit a varchar column. When truncation happens, a
   * warning is appended to the import-level errors array so the admin
   * can spot which rows had over-length values (typically caused by a
   * malformed multi-line quoted CSV cell that swallowed adjacent rows).
   */
  private capString(
    val: string | null,
    max: number,
    field: string,
    rowNumber: number,
    code: string | undefined,
    errors: { row: number; code?: string; reason: string }[],
  ): string | null {
    if (val === null) return null;
    if (val.length <= max) return val;

    errors.push({
      row: rowNumber,
      code,
      reason: `${field} exceeded ${max} chars (was ${val.length}) — value truncated. Likely caused by a malformed quoted cell in the CSV.`,
    });
    this.logger.warn(
      `Row ${rowNumber} (${code ?? 'unknown'}): ${field} truncated from ${val.length} to ${max} chars`,
    );
    return val.slice(0, max);
  }

  /* ================================================================== */
  /* Bulk import — accepts N files, runs 4.1s before 4.3s                 */
  /* ================================================================== */

  /**
   * Detects whether an uploaded file is a 4.1 Project Info or a 4.3
   * Project Budget file.
   *
   * Detection order (first match wins):
   *  1. Filename pattern (e.g. "4.1 Project Info.xlsx" or "project_data.csv").
   *  2. Header signature — peek at the first row's column names.
   *
   * If neither matches, returns 'unknown' so the caller can record the
   * file as a non-fatal error rather than guess and corrupt data.
   */
  private detectFileType(
    originalName: string,
    headerKeys: string[] | null,
  ): ImportFileType {
    const name = originalName || '';

    /* Step 1 — filename pattern. Signalling is checked first because
       "mapping export" could overlap with the broader 4.3 patterns
       (project data / project budget). TOC is checked next because
       "toc_projects" is a very specific signal that pre-dates the
       Anaplan filename conventions. 4.1 is checked after that because
       "project info" is a stricter signal than the 4.3 patterns. */
    if (/signalling|signaling|mapping[\s_-]*export/i.test(name))
      return 'signalling';
    if (/toc[\s_-]*projects?|^toc\.csv$/i.test(name)) return 'toc';
    if (/4\.1|project[\s_-]*info/i.test(name)) return '4.1';
    if (/4\.3|project[\s_-]*data|project[\s_-]*budget/i.test(name))
      return '4.3';

    /* Step 2 — header signature. Compare case-insensitively but treat
       multiple internal spaces as a single space (Anaplan exports
       sometimes contain double spaces in column headers). */
    if (headerKeys && headerKeys.length > 0) {
      const normalized = headerKeys.map((k) =>
        (k || '').toLowerCase().replace(/\s+/g, ' ').trim(),
      );
      const has = (needle: string): boolean =>
        normalized.includes(needle.toLowerCase());

      /* Signalling signature: project code (anaplan) + baseline
         mapping 2025 % + status all present. Checked before 4.1 / 4.3
         in case a Signalling file is renamed without a recognizable
         filename hint. */
      if (
        has('project code (anaplan)') &&
        has('baseline mapping 2025 %') &&
        has('status')
      ) {
        return 'signalling';
      }

      /* TOC signature: Program + ID + Name + Center + complementarity
         rating + efficiencies rating + budget allocation columns all
         present. Checked before 4.1 / 4.3 because the TOC file uses a
         bare "Name" column that is unique to it. */
      if (
        has('program') &&
        has('id') &&
        has('name') &&
        has('center') &&
        has('complementarity of results si') &&
        has('efficiencies/strategic benefit si') &&
        has('budget allocation from project to program')
      ) {
        return 'toc';
      }

      /* 4.1 signature: Code + Entity + Funder all present. */
      if (has('code') && has('entity') && has('funder')) return '4.1';

      /* 4.3 signature: Code project + Account + Amount all present. */
      if (has('code project') && has('account') && has('amount')) return '4.3';
    }

    return 'unknown';
  }

  /**
   * Cheaply reads only the header row from an uploaded buffer so we can
   * sniff its file type without materializing the whole sheet. Returns
   * `null` when the file is unparseable — the caller treats that as
   * "unknown type" and records a single error row.
   */
  private peekHeaderKeys(
    buffer: Buffer,
    originalName: string,
  ): string[] | null {
    const ext = (path.extname(originalName) || '').toLowerCase();
    const isExcel = ext === '.xlsx' || ext === '.xls';

    try {
      if (isExcel) {
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        if (!workbook.SheetNames.length) return null;
        /* Same sheet-selection rule as parseTabularBuffer — prefer the
           "update" revision when an Anaplan file carries multiple sheets. */
        const sheetName =
          workbook.SheetNames.find((n) => /update/i.test(n)) ||
          workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
          header: 1,
          defval: '',
          raw: false,
        });
        const header = aoa[0];
        if (!Array.isArray(header)) return null;
        return header.map((c) => (c == null ? '' : String(c)));
      }

      /* CSV — parse just the first row. */
      const csvContent = buffer.toString('utf-8');
      const rows = parse(csvContent, {
        columns: false,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        to_line: 1,
      });
      return rows[0] || null;
    } catch {
      /* Header sniff is best-effort. A parse failure here is not fatal —
         we fall back to filename-only detection (and ultimately to
         'unknown'), and the full importer call will surface a richer
         error if the file is genuinely corrupt. */
      return null;
    }
  }

  /**
   * Runs a multi-file import. Files are processed in dependency order —
   * all detected 4.1 (Project Info) files first, then all 4.3 (Project
   * Data) files — so newly-created project codes from a 4.1 are
   * available when the corresponding 4.3 is processed. Within a type,
   * files are processed in the order the user uploaded them.
   *
   * Per-file failures (corrupt xlsx, parser exception, …) are caught
   * and recorded as a single error row in that file's result; they
   * never abort the rest of the batch. Files whose type cannot be
   * detected are returned with `type: 'unknown'` and a single
   * actionable error explaining the requirement.
   *
   * The aggregate `totals` block sums every file's counters so the
   * admin can see the overall outcome at a glance.
   */
  async runBulkImport(
    files: BulkImportFileInput[],
  ): Promise<BulkImportSummary> {
    this.logger.log(
      `Bulk import triggered with ${files.length} file(s): ` +
        files.map((f) => f.originalName).join(', '),
    );

    /* Step 1 — classify every file up front so we can sort them by type
       while preserving the original upload order within each type. */
    type Classified = BulkImportFileInput & {
      type: ImportFileType;
      uploadIndex: number;
    };
    const classified: Classified[] = files.map((f, idx) => {
      const headerKeys = this.peekHeaderKeys(f.buffer, f.originalName);
      const type = this.detectFileType(f.originalName, headerKeys);
      return { ...f, type, uploadIndex: idx };
    });

    /* Step 2 — order: 4.1 first (so new project codes exist), then
       TOC (seeds center-side mappings + ratings against those
       projects), then signalling (layers per-mapping deltas on top of
       TOC), then 4.3 (budget lines need projects), then unknown (so
       the unknown errors land at the end of the report and don't
       visually interrupt the success cases). Within each group,
       preserve the upload order. */
    const groupOrder: Record<ImportFileType, number> = {
      '4.1': 0,
      toc: 1,
      signalling: 2,
      '4.3': 3,
      unknown: 4,
    };
    classified.sort((a, b) => {
      const groupDiff = groupOrder[a.type] - groupOrder[b.type];
      if (groupDiff !== 0) return groupDiff;
      return a.uploadIndex - b.uploadIndex;
    });

    /* Step 3 — dispatch each file to the right importer. Wrap every
       call in try/catch so a single corrupt file cannot abort the
       whole bulk run. */
    const results: BulkFileResult[] = [];

    for (const file of classified) {
      if (file.type === 'unknown') {
        this.logger.warn(
          `Bulk import: could not detect type of "${file.originalName}"`,
        );
        results.push({
          filename: file.originalName,
          type: 'unknown',
          created: 0,
          updated: 0,
          skipped: 0,
          errors: [
            {
              row: 0,
              reason:
                'Could not detect file type — expected 4.1 (Project ' +
                'Info), TOC (TOC_Projects), 4.3 (Project Data), or ' +
                'Signalling format',
            },
          ],
        });
        continue;
      }

      try {
        /* Dispatch by detected type — the order in which the loop
           reaches each file is enforced by the earlier groupOrder
           sort, not by the order of the cases here. */
        let summary;
        if (file.type === '4.1') {
          summary = await this.importProjectInfoFromBuffer(
            file.buffer,
            file.originalName,
          );
        } else if (file.type === 'toc') {
          summary = await this.importTocFromBuffer(
            file.buffer,
            file.originalName,
          );
        } else if (file.type === 'signalling') {
          summary = await this.importSignallingFromBuffer(
            file.buffer,
            file.originalName,
          );
        } else {
          summary = await this.importProjectBudgetsFromBuffer(
            file.buffer,
            file.originalName,
          );
        }

        results.push({
          filename: file.originalName,
          type: file.type,
          created: summary.created,
          updated: summary.updated,
          skipped: summary.skipped,
          errors: summary.errors,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Bulk import: file "${file.originalName}" failed entirely: ${message}`,
        );
        /* Record the whole-file failure as a single error row — row 0
           signals "before any data row" so the UI can render it as a
           file-level problem rather than attaching it to a CSV line. */
        results.push({
          filename: file.originalName,
          type: file.type,
          created: 0,
          updated: 0,
          skipped: 0,
          errors: [
            {
              row: 0,
              reason: `failed to process file: ${message}`,
            },
          ],
        });
      }
    }

    /* Step 4 — roll-up totals across every file in the run. */
    const totals = results.reduce(
      (acc, r) => {
        acc.filesProcessed += 1;
        acc.created += r.created;
        acc.updated += r.updated;
        acc.skipped += r.skipped;
        acc.errors += r.errors.length;
        return acc;
      },
      { filesProcessed: 0, created: 0, updated: 0, skipped: 0, errors: 0 },
    );

    this.logger.log(
      `Bulk import complete: files=${totals.filesProcessed}, ` +
        `created=${totals.created}, updated=${totals.updated}, ` +
        `skipped=${totals.skipped}, errors=${totals.errors}`,
    );

    return { files: results, totals };
  }
}
