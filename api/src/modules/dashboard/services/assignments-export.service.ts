import { Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import ExcelJS from 'exceljs';

import { DashboardService, AssignmentsMatrix } from '../dashboard.service';
import { User } from '../../users/entities/user.entity';
import {
  applyHeaderStyle,
  buildTimestamp,
  FMT_CURRENCY,
  TAB_COLORS,
} from '../../projects/services/excel-styles.helper';

/** Excel percent format for values stored as fractions (0.42 renders "42.0%"). */
const FMT_SHARE = '0.0%';

/**
 * Excel format for the combined-concentration index. Values are typically
 * tiny (~1e-5), so six decimals keeps them from rounding to zero on screen.
 */
const FMT_INDEX = '0.000000';

/** Blank rows left between two stacked tables. */
const BLOCK_GAP = 1;

/**
 * One table's definition: what it's called, what it means, and how to derive
 * each cell from the raw amount grid.
 */
interface TableSpec {
  title: string;
  subtitle: string;
  numFmt: string;
  /** Cell value for a program/center pair, given the raw amount and both totals. */
  value: (amount: number, programTotal: number, centerTotal: number) => number;
  /** Row total column, or null when a row total isn't meaningful for this table. */
  rowTotal: ((programTotal: number) => number) | null;
  /**
   * Whether to append a bottom row of per-center totals. Only the Amounts
   * table gets one: on the share tables a column sum is either a different
   * metric than the table's own cells (Table A) or a trivial 100% (Table B),
   * and on Combined it means nothing at all.
   */
  columnTotals: boolean;
}

/**
 * AssignmentsExportService — streams the admin Assignments report as an
 * Excel workbook.
 *
 * One worksheet holding the four tables stacked vertically, matching both
 * the Assignments page and the "W3-Bilateral" sheet of the source
 * spreadsheet (GitHub #107): raw dollars, each of the two share views, and
 * the combined concentration index. Derivations live in `TABLES` below
 * rather than being duplicated per table.
 *
 * The matrix is small (a dozen centers x a dozen programs), so this builds
 * the workbook in memory and writes it in one shot — unlike the projects
 * export, which streams because its row count is unbounded. Building first
 * also means a failure surfaces as a normal JSON error instead of a
 * truncated download.
 */
@Injectable()
export class AssignmentsExportService {
  private readonly logger = new Logger(AssignmentsExportService.name);

  constructor(private readonly dashboardService: DashboardService) {}

  /** The four tables, in sheet order, each with its own cell derivation. */
  private static readonly TABLES: TableSpec[] = [
    {
      title: 'Program x Center Amount',
      subtitle:
        'Agreed FY26 allocation in USD per Program/Center pair (agreed and admin-decision mappings).',
      numFmt: FMT_CURRENCY,
      value: (amount) => amount,
      rowTotal: (programTotal) => programTotal,
      columnTotals: true,
    },
    {
      title: 'A. Center as % of Program / Accelerator',
      subtitle:
        "Each cell is that Center's share of the Program's total agreed allocation. Rows sum to ~100%.",
      numFmt: FMT_SHARE,
      value: (amount, programTotal) =>
        programTotal > 0 ? amount / programTotal : 0,
      rowTotal: (programTotal) => (programTotal > 0 ? 1 : 0),
      columnTotals: false,
    },
    {
      title: 'B. Program / Accelerator as % of Center',
      subtitle:
        "Each cell is that Program's share of the Center's total agreed allocation. Columns sum to ~100%.",
      numFmt: FMT_SHARE,
      value: (amount, _programTotal, centerTotal) =>
        centerTotal > 0 ? amount / centerTotal : 0,
      rowTotal: null,
      columnTotals: false,
    },
    {
      title: 'Combined Concentration (A x B)',
      subtitle:
        "Table A's cell x Table B's cell at the same coordinate — highlights Program/Center pairs that are mutually significant to each other, not just large in dollar terms. Not a percentage; does not sum to 100% in either direction.",
      numFmt: FMT_INDEX,
      value: (amount, programTotal, centerTotal) => {
        const shareOfProgram = programTotal > 0 ? amount / programTotal : 0;
        const shareOfCenter = centerTotal > 0 ? amount / centerTotal : 0;
        return shareOfProgram * shareOfCenter;
      },
      rowTotal: null,
      columnTotals: false,
    },
  ];

  /**
   * Builds the Assignments workbook and writes it to the response.
   *
   * @param user - Authenticated admin; used for the Winston log only.
   * @param res  - Express response.
   */
  async streamExport(user: User, res: Response): Promise<void> {
    const startMs = Date.now();
    const matrix = await this.dashboardService.getAssignmentsMatrix();

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'PRMS Projects Registry';
    workbook.created = new Date();

    this.writeAssignmentsSheet(workbook, matrix);

    /* Buffer the workbook before touching the response so any failure above
     * still produces a normal error response rather than a partial file. */
    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `prms-assignments-${buildTimestamp()}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.byteLength));
    res.end(Buffer.from(buffer));

    this.logger.log(
      `Export assignments: user=${user.email} programs=${matrix.programs.length} ` +
        `centers=${matrix.centers.length} ms=${Date.now() - startMs}`,
    );
  }

  /**
   * Writes the single worksheet: a page banner, then the four tables
   * stacked with a blank-row gap between them.
   */
  private writeAssignmentsSheet(
    workbook: ExcelJS.Workbook,
    matrix: AssignmentsMatrix,
  ): void {
    /* Widest table wins the column count — the Total column belongs to the
     * tables that have one, and stays empty on the rows of those that don't. */
    const hasAnyRowTotal = AssignmentsExportService.TABLES.some(
      (t) => t.rowTotal,
    );
    const lastCol = 2 + matrix.centers.length + (hasAnyRowTotal ? 1 : 0);
    const lastColLetter = this.columnLetter(lastCol);

    const sheet = workbook.addWorksheet('Assignments', {
      properties: { tabColor: { argb: TAB_COLORS.navy } },
      /* Freeze the identity columns only — headers repeat per table, so
       * freezing a header row would pin the wrong one once you scroll. */
      views: [{ state: 'frozen', xSplit: 2, ySplit: 0 }],
    });

    /* Row 1 — navy page banner. Row 2 — generation stamp. Row 3 — spacer. */
    sheet.mergeCells(`A1:${lastColLetter}1`);
    const banner = sheet.getCell('A1');
    banner.value = `Assignments — ${matrix.fundingScope}, ${matrix.budgetYear}`;
    banner.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 14 };
    banner.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: TAB_COLORS.navy },
    };
    banner.alignment = { horizontal: 'left', vertical: 'middle' };
    sheet.getRow(1).height = 30;

    sheet.mergeCells(`A2:${lastColLetter}2`);
    const stamp = sheet.getCell('A2');
    stamp.value = `Generated: ${new Date().toISOString()}`;
    stamp.font = { italic: true, color: { argb: 'FF555555' }, size: 10 };

    /* Lookups shared by all four tables. */
    const amountByKey = new Map(
      matrix.cells.map((c) => [`${c.programId}-${c.centerId}`, c.amount]),
    );
    const totalByProgram = new Map(
      matrix.programTotals.map((t) => [t.programId, t.total]),
    );
    const totalByCenter = new Map(
      matrix.centerTotals.map((t) => [t.centerId, t.total]),
    );

    let nextRow = 4;
    for (const spec of AssignmentsExportService.TABLES) {
      const lastRowOfBlock = this.writeTableBlock(
        sheet,
        spec,
        matrix,
        nextRow,
        lastCol,
        { amountByKey, totalByProgram, totalByCenter },
      );
      nextRow = lastRowOfBlock + 1 + BLOCK_GAP;
    }

    /* Column widths: identity columns wide enough to read, data columns
     * uniform so the grid stays scannable. Sized for the currency table —
     * the widest content on the sheet. */
    sheet.getColumn(1).width = 16;
    sheet.getColumn(2).width = 46;
    for (let col = 3; col <= lastCol; col++) {
      sheet.getColumn(col).width = 16;
    }
  }

  /**
   * Writes one table block starting at `startRow`: title, subtitle, header
   * row, one row per program, and (where meaningful) a bottom totals row.
   *
   * @returns the last row number this block occupies.
   */
  private writeTableBlock(
    sheet: ExcelJS.Worksheet,
    spec: TableSpec,
    matrix: AssignmentsMatrix,
    startRow: number,
    lastCol: number,
    lookups: {
      amountByKey: Map<string, number>;
      totalByProgram: Map<number, number>;
      totalByCenter: Map<number, number>;
    },
  ): number {
    const lastColLetter = this.columnLetter(lastCol);
    const { amountByKey, totalByProgram, totalByCenter } = lookups;

    /* Title row — bold on a light fill so each block is findable when
     * scrolling a long sheet. */
    sheet.mergeCells(`A${startRow}:${lastColLetter}${startRow}`);
    const titleCell = sheet.getCell(`A${startRow}`);
    titleCell.value = spec.title;
    titleCell.font = { bold: true, size: 12, color: { argb: 'FF0F212F' } };
    titleCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFEDF0F7' },
    };
    titleCell.alignment = { horizontal: 'left', vertical: 'middle' };
    sheet.getRow(startRow).height = 22;

    /* Subtitle row — what the numbers in this block mean. */
    const subtitleRowNum = startRow + 1;
    sheet.mergeCells(`A${subtitleRowNum}:${lastColLetter}${subtitleRowNum}`);
    const subtitleCell = sheet.getCell(`A${subtitleRowNum}`);
    subtitleCell.value = spec.subtitle;
    subtitleCell.font = { italic: true, color: { argb: 'FF555555' }, size: 10 };
    subtitleCell.alignment = { horizontal: 'left', vertical: 'middle' };

    /* Header row — program identity columns, one column per center, plus
     * the row-total column on tables that have one. */
    const headerRow = sheet.getRow(subtitleRowNum + 1);
    headerRow.values = [
      'Program Code',
      'Program',
      ...matrix.centers.map((c) => c.acronym),
      ...(spec.rowTotal ? ['Total'] : []),
    ];
    applyHeaderStyle(headerRow);
    headerRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
    headerRow.getCell(2).alignment = { vertical: 'middle', horizontal: 'left' };

    const dataLastCol = 2 + matrix.centers.length + (spec.rowTotal ? 1 : 0);
    let rowNum = headerRow.number;

    for (const program of matrix.programs) {
      const programTotal = totalByProgram.get(program.programId) ?? 0;
      const cells = matrix.centers.map((center) =>
        spec.value(
          amountByKey.get(`${program.programId}-${center.centerId}`) ?? 0,
          programTotal,
          totalByCenter.get(center.centerId) ?? 0,
        ),
      );
      const row = sheet.getRow(++rowNum);
      row.values = [
        program.officialCode,
        program.name,
        ...cells,
        ...(spec.rowTotal ? [spec.rowTotal(programTotal)] : []),
      ];
      for (let col = 3; col <= dataLastCol; col++) {
        row.getCell(col).numFmt = spec.numFmt;
      }
      if (spec.rowTotal) row.getCell(dataLastCol).font = { bold: true };
    }

    /* Bottom totals row — the per-center column totals plus the grand total.
     * Amounts table only; see `columnTotals` on TableSpec for why. */
    if (spec.columnTotals) {
      const grandTotal = matrix.centerTotals.reduce(
        (sum, t) => sum + t.total,
        0,
      );
      const totalsRow = sheet.getRow(++rowNum);
      totalsRow.values = [
        'Total',
        '',
        ...matrix.centers.map(
          (center) => totalByCenter.get(center.centerId) ?? 0,
        ),
        ...(spec.rowTotal ? [grandTotal] : []),
      ];
      totalsRow.font = { bold: true };
      for (let col = 3; col <= dataLastCol; col++) {
        totalsRow.getCell(col).numFmt = spec.numFmt;
      }
      for (let col = 1; col <= dataLastCol; col++) {
        totalsRow.getCell(col).border = {
          top: { style: 'thin', color: { argb: 'FF999999' } },
        };
      }
    }

    return rowNum;
  }

  /**
   * Converts a 1-based column index to its Excel letter (1 → A, 27 → AA).
   * Needed for the merged title/banner ranges, whose width depends on how
   * many centers exist.
   */
  private columnLetter(index: number): string {
    let letter = '';
    let n = index;
    while (n > 0) {
      const remainder = (n - 1) % 26;
      letter = String.fromCharCode(65 + remainder) + letter;
      n = Math.floor((n - 1) / 26);
    }
    return letter;
  }
}
