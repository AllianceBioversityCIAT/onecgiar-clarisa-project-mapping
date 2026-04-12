import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager, DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

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

/**
 * Represents a single parsed CSV row with typed column names.
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
 * Summary object returned after an import run.
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
 * Handles bulk CSV import of projects and their program mappings.
 *
 * Reads a CSV file, groups rows by project name, resolves reference
 * data (centers, programs, countries), and upserts projects and
 * mappings using per-project transactions for atomicity.
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
  ) {}

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
   * Runs the full CSV import process.
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
              csvId, code, name, description, projectSummary, projectResults,
              startDate, endDate, totalBudget, remainingBudget,
              fundingSource, funder, ProjectStatus.ACTIVE,
              center.id, systemUser.id,
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
     *
     * Examples:
     *   "S0003 -Piloting..." → code="S0003", rest="Piloting..."
     *   "N-344002- BIOTECH..." → code="N-344002", rest="BIOTECH..."
     *   "T-PJ-004023-VACS-Breeding: TARO" → code="T-PJ-004023", rest="VACS-Breeding: TARO"
     *   "P-1520-GOO0-Sustainable..." → code="P-1520-GOO0", rest="Sustainable..."
     *
     * Strategy: look for a code prefix that is a letter followed by
     * optional groups of hyphen+alphanumerics, then a separator before
     * the actual name text.
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
   * Parses a date string in "DD-MMM-YY" format (e.g., "21-Nov-24")
   * to a JavaScript Date object.
   *
   * @returns Parsed Date or null if the input is empty/unparseable.
   */
  private parseDate(dateStr: string): Date | null {
    if (!dateStr || !dateStr.trim()) return null;

    const trimmed = dateStr.trim();

    /* Parse "DD-MMM-YY" format */
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

    if (normalized === 'agree') return MappingStatus.APPROVED;
    if (normalized === 'disagree') return MappingStatus.REJECTED;
    return MappingStatus.PENDING;
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

      if (
        status === MappingStatus.APPROVED ||
        status === MappingStatus.REJECTED
      ) {
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
        submittedById: systemUser.id,
        submittedAt: now,
        reviewedAt:
          status === MappingStatus.APPROVED || status === MappingStatus.REJECTED
            ? now
            : null,
        reviewedById: null,
        rejectionReason: null,
      });

      await manager.save(ProjectMapping, mapping);
      summary.mappingsCreated++;
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

  /* ------------------------------------------------------------------ */
  /* 4.1 Project Info importer                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Imports optional project metadata from the 4.1 Project Info CSV.
   *
   * Only updates projects that already exist (matched by `code`). Rows
   * whose code does not match an existing project are counted as
   * skipped. Per-row errors are collected and returned; they do not
   * abort the batch.
   *
   * Never touches `project_mappings` — the allocation invariant is
   * strictly preserved.
   *
   * @param filePath - Absolute path to the 4.1 Project Info CSV.
   */
  async importProjectInfo(filePath: string): Promise<{
    matched: number;
    updated: number;
    skipped: number;
    errors: { row: number; reason: string }[];
  }> {
    this.logger.log(`Starting 4.1 Project Info import from: ${filePath}`);

    /* Read and parse the CSV — same options as the TOC importer */
    const csvContent = fs.readFileSync(filePath, 'utf-8');
    const rows: Record<string, string>[] = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });

    this.logger.log(`Parsed ${rows.length} rows from 4.1 Project Info CSV`);

    /* Pre-load all projects into a Map for O(1) lookup by code */
    const allProjects = await this.projectRepo.find();
    const projectsByCode = new Map<string, Project>(
      allProjects.map((p) => [p.code, p]),
    );

    let matched = 0;
    let updated = 0;
    let skipped = 0;
    const errors: { row: number; reason: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNumber = i + 2; /* +2 for header + 0-index */

      try {
        const code = (row.Code || '').trim();
        if (!code) {
          skipped++;
          continue;
        }

        const project = projectsByCode.get(code);
        if (!project) {
          skipped++;
          continue;
        }

        matched++;

        /* Map CSV fields to entity fields */
        const funder = (row.Funder || '').trim() || null;
        const funderPrimaryCenter =
          (row['Funder of the Primary Center'] || '').trim() || null;
        const natureOfFunder = this.validateEnum<NatureOfFunder>(
          row['Nature of Funder'],
          Object.values(NatureOfFunder) as string[],
          'Nature of Funder',
          code,
        ) as NatureOfFunder | null;
        const category = this.validateEnum<ProjectCategory>(
          row.Category,
          Object.values(ProjectCategory) as string[],
          'Category',
          code,
        ) as ProjectCategory | null;
        const cspRaw = (row.CSP || '').trim().toUpperCase();
        const csp: CspFlag | null =
          cspRaw === 'YES' ? CspFlag.YES : cspRaw === 'NO' ? CspFlag.NO : null;
        const cspNonCollectionReason =
          (row['Reason for Non-collection of CSP'] || '').trim() || null;
        const totalPledge = this.parseDecimal(row['Total Pledge']);
        const principalInvestigator =
          (row['Principal investigator'] || '').trim() || null;
        const signedContractTitle =
          (row['Signed Contract Title'] || '').trim() || null;

        /* Lifecycle status — CSV uses true/false, map to active/archived */
        const statusRaw = (row.Status || '').trim().toLowerCase();
        const status: ProjectStatus =
          statusRaw === 'true'
            ? ProjectStatus.ACTIVE
            : statusRaw === 'false'
              ? ProjectStatus.ARCHIVED
              : project.status;

        /* Apply updates — only overwrite when the CSV has a value, so
           that blank cells don't erase existing data. */
        if (funder !== null) project.funder = funder;
        project.funderPrimaryCenter = funderPrimaryCenter;
        project.natureOfFunder = natureOfFunder;
        project.category = category;
        project.csp = csp;
        project.cspNonCollectionReason = cspNonCollectionReason;
        project.totalPledge = totalPledge;
        project.principalInvestigator = principalInvestigator;
        project.signedContractTitle = signedContractTitle;
        project.status = status;

        await this.projectRepo.save(project);
        updated++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `4.1 import error on row ${rowNumber} (code=${row.Code}): ${message}`,
        );
        errors.push({ row: rowNumber, reason: message });
      }
    }

    this.logger.log(
      `4.1 Project Info import complete: matched=${matched}, updated=${updated}, ` +
        `skipped=${skipped}, errors=${errors.length}`,
    );

    return { matched, updated, skipped, errors };
  }

  /* ------------------------------------------------------------------ */
  /* 4.3 Project Budget importer                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Imports fiscal-year budget lines from the 4.3 Project Budget CSV.
   *
   * Each CSV row is keyed by a unique `external_code` in the first
   * (unnamed) column. Re-running the importer is idempotent: rows with
   * a matching `external_code` are updated in place, and the UNIQUE
   * constraint on the column prevents duplicate inserts.
   *
   * Rows whose `Code project` does not match an existing project are
   * counted as skipped. Never touches `project_mappings`.
   *
   * @param filePath - Absolute path to the 4.3 Project Budget CSV.
   */
  async importProjectBudgets(filePath: string): Promise<{
    budgetLinesInserted: number;
    budgetLinesUpdated: number;
    skipped: number;
    errors: { row: number; reason: string }[];
  }> {
    this.logger.log(`Starting 4.3 Project Budget import from: ${filePath}`);

    const csvContent = fs.readFileSync(filePath, 'utf-8');
    const rows: Record<string, string>[] = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });

    this.logger.log(`Parsed ${rows.length} rows from 4.3 Project Budget CSV`);

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

    let budgetLinesInserted = 0;
    let budgetLinesUpdated = 0;
    let skipped = 0;
    const errors: { row: number; reason: string }[] = [];

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
           key '' (empty string). Fall back to a couple of alternates. */
        const externalCode = (
          row[''] ||
          (row as Record<string, string>)['__EMPTY'] ||
          ''
        ).trim();
        const projectCode = (row['Code project'] || '').trim();

        if (!externalCode || !projectCode) {
          skipped++;
          continue;
        }

        const project = projectsByCode.get(projectCode);
        if (!project) {
          skipped++;
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
          budgetLinesUpdated++;
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
          budgetLinesInserted++;
        }

        if (pendingSaves.length >= BATCH_SIZE) {
          await flush();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`4.3 import error on row ${rowNumber}: ${message}`);
        errors.push({ row: rowNumber, reason: message });
      }
    }

    /* Flush any remaining rows */
    await flush();

    this.logger.log(
      `4.3 Project Budget import complete: inserted=${budgetLinesInserted}, ` +
        `updated=${budgetLinesUpdated}, skipped=${skipped}, errors=${errors.length}`,
    );

    return { budgetLinesInserted, budgetLinesUpdated, skipped, errors };
  }

  /* ------------------------------------------------------------------ */
  /* Helpers for the 4.1 / 4.3 importers                                  */
  /* ------------------------------------------------------------------ */

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
   * but unrecognized. The caller should log the field name and project
   * code so bad values are traceable.
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
}
