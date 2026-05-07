import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager, DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';

import { Project } from '../projects/entities/project.entity';
import { ProjectBudget } from '../projects/entities/project-budget.entity';
import { ProjectMapping } from '../mappings/entities/project-mapping.entity';
import { Center } from '../reference-data/entities/center.entity';
import { Program } from '../reference-data/entities/program.entity';
import { Country } from '../reference-data/entities/country.entity';
import { User } from '../users/entities/user.entity';
import { FundingSource } from '../projects/enums/funding-source.enum';
import { ProjectStatus } from '../projects/enums/project-status.enum';
import { NatureOfFunder } from '../projects/enums/nature-of-funder.enum';
import { ProjectCategory } from '../projects/enums/project-category.enum';
import { CspFlag } from '../projects/enums/csp-flag.enum';
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
export type ImportFileType = '4.1' | '4.3' | 'unknown';

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
   * - "D/M/YYYY" or "DD/MM/YYYY" (locale slash format used by Anaplan exports)
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

    /* D/M/YYYY or DD/MM/YYYY */
    const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slashMatch) {
      const [, d, m, y] = slashMatch;
      return new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10));
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
        const sheetName = workbook.SheetNames[0];
        if (!sheetName) {
          throw new Error('workbook contains no sheets');
        }
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
   * dropping `null` / `undefined` to ''. Keeps the same column keys.
   */
  private normalizeRow(row: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of Object.keys(row)) {
      const v = row[key];
      if (v === null || v === undefined) {
        out[key] = '';
      } else if (typeof v === 'string') {
        out[key] = v.trim();
      } else {
        out[key] = String(v).trim();
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

        /* Lifecycle status — CSV uses true/false (case-insensitive) */
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

        const project = projectsByCode.get(code);

        if (project) {
          /* ----- UPDATE PATH ----- */
          if (funder !== null) project.funder = funder;
          project.funderPrimaryCenter = funderPrimaryCenter;
          project.natureOfFunder = natureOfFunder;
          project.category = category;
          project.csp = csp;
          project.cspNonCollectionReason = cspNonCollectionReason;
          project.totalPledge = totalPledge;
          project.principalInvestigator = principalInvestigator;
          project.signedContractTitle = signedContractTitle;
          if (explicitStatus !== null) project.status = explicitStatus;
          if (fundingSource) project.fundingSource = fundingSource;
          if (startDate) project.startDate = startDate;
          if (endDate) project.endDate = endDate;

          await this.projectRepo.save(project);
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
            totalBudget: 0,
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
          });

          const saved = await this.projectRepo.save(fresh);
          /* Track in the in-memory map so a duplicate `code` later in the
             same upload is treated as an update on the second hit. */
          projectsByCode.set(code, saved);
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
        const externalCode = (
          row[''] ||
          (row as Record<string, string>)['__EMPTY'] ||
          ''
        ).trim();
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
  /* Helpers for the 4.1 / 4.3 importers                                  */
  /* ================================================================== */

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

    /* Step 1 — filename pattern. The 4.1 check runs first because
       "project info" is a stricter signal than the broader 4.3 patterns. */
    if (/4\.1|project[\s_-]*info/i.test(name)) return '4.1';
    if (/4\.3|project[\s_-]*data|project[\s_-]*budget/i.test(name)) return '4.3';

    /* Step 2 — header signature. Compare case-insensitively but treat
       multiple internal spaces as a single space (Anaplan exports
       sometimes contain double spaces in column headers). */
    if (headerKeys && headerKeys.length > 0) {
      const normalized = headerKeys.map((k) =>
        (k || '').toLowerCase().replace(/\s+/g, ' ').trim(),
      );
      const has = (needle: string): boolean =>
        normalized.includes(needle.toLowerCase());

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
        const sheetName = workbook.SheetNames[0];
        if (!sheetName) return null;
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
      }) as string[][];
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

    /* Step 2 — order: 4.1 first (so new project codes exist), then 4.3,
       then unknown (so the unknown errors land at the end of the report
       and don't visually interrupt the success cases). Within each
       group, preserve the upload order. */
    const groupOrder: Record<ImportFileType, number> = {
      '4.1': 0,
      '4.3': 1,
      unknown: 2,
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
                'Info) or 4.3 (Project Data) format',
            },
          ],
        });
        continue;
      }

      try {
        const summary =
          file.type === '4.1'
            ? await this.importProjectInfoFromBuffer(
                file.buffer,
                file.originalName,
              )
            : await this.importProjectBudgetsFromBuffer(
                file.buffer,
                file.originalName,
              );

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
