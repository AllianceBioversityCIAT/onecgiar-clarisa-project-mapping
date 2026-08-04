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

/** Frozen-header row number — every matrix sheet uses the same layout. */
const HEADER_ROW = 4;

/**
 * One matrix sheet's definition: what it's called, what it means, and how
 * to derive each cell from the raw amount grid.
 */
interface SheetSpec {
  name: string;
  tabColor: string;
  title: string;
  subtitle: string;
  numFmt: string;
  /** Cell value for a program/center pair, given the raw amount and both totals. */
  value: (amount: number, programTotal: number, centerTotal: number) => number;
  /** Row total column, or null when a row total isn't meaningful for this sheet. */
  rowTotal: ((programTotal: number) => number) | null;
  /**
   * Whether to append a bottom row of per-center totals. Only the Amounts
   * sheet gets one: on the share sheets a column sum is either a different
   * metric than the sheet's own cells (Sheet A) or a trivial 100% (Sheet B),
   * and on Combined it means nothing at all.
   */
  columnTotals: boolean;
}

/**
 * AssignmentsExportService — streams the admin Assignments report as a
 * 4-sheet Excel workbook.
 *
 * Sheets mirror the four stacked tables on the Assignments page (and the
 * "W3-Bilateral" sheet of the source spreadsheet, GitHub #107) so the
 * download and the screen never disagree: raw dollars, each of the two
 * share views, and the combined concentration index. Derivations live in
 * `SHEETS` below rather than being duplicated per sheet.
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

  /** The four sheets, in workbook order, each with its own cell derivation. */
  private static readonly SHEETS: SheetSpec[] = [
    {
      name: 'Amounts',
      tabColor: TAB_COLORS.navy,
      title: 'Program x Center Amount',
      subtitle:
        'Agreed FY26 allocation in USD per Program/Center pair (agreed and admin-decision mappings).',
      numFmt: FMT_CURRENCY,
      value: (amount) => amount,
      rowTotal: (programTotal) => programTotal,
      columnTotals: true,
    },
    {
      name: 'A. Center pct of Program',
      tabColor: TAB_COLORS.blue,
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
      name: 'B. Program pct of Center',
      tabColor: TAB_COLORS.teal,
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
      name: 'Combined (A x B)',
      tabColor: TAB_COLORS.purple,
      title: 'Combined Concentration (A x B)',
      subtitle:
        "Sheet A's cell x Sheet B's cell at the same coordinate — highlights Program/Center pairs that are mutually significant to each other, not just large in dollar terms. Not a percentage; does not sum to 100% in either direction.",
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

    for (const spec of AssignmentsExportService.SHEETS) {
      this.writeMatrixSheet(workbook, spec, matrix);
    }

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
   * Writes one matrix sheet: banner, subtitle, header row, one row per
   * program, and (on sheets that carry totals) a bottom totals row.
   */
  private writeMatrixSheet(
    workbook: ExcelJS.Workbook,
    spec: SheetSpec,
    matrix: AssignmentsMatrix,
  ): void {
    const sheet = workbook.addWorksheet(spec.name, {
      properties: { tabColor: { argb: spec.tabColor } },
      views: [{ state: 'frozen', xSplit: 2, ySplit: HEADER_ROW }],
    });

    const lastCol = 2 + matrix.centers.length + (spec.rowTotal ? 1 : 0);
    const lastColLetter = this.columnLetter(lastCol);

    /* Row 1 — navy banner with the table title. */
    sheet.mergeCells(`A1:${lastColLetter}1`);
    const banner = sheet.getCell('A1');
    banner.value = `${spec.title} — ${matrix.fundingScope}, ${matrix.budgetYear}`;
    banner.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 14 };
    banner.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: TAB_COLORS.navy },
    };
    banner.alignment = { horizontal: 'left', vertical: 'middle' };
    sheet.getRow(1).height = 30;

    /* Row 2 — what the numbers mean. Row 3 stays blank as a spacer. */
    sheet.mergeCells(`A2:${lastColLetter}2`);
    const subtitle = sheet.getCell('A2');
    subtitle.value = spec.subtitle;
    subtitle.font = { italic: true, color: { argb: 'FF555555' }, size: 10 };
    subtitle.alignment = { horizontal: 'left', vertical: 'middle' };

    /* Row 4 — header: program identity columns, one column per center,
     * plus the row-total column on sheets that have one. */
    const headerRow = sheet.getRow(HEADER_ROW);
    headerRow.values = [
      'Program Code',
      'Program',
      ...matrix.centers.map((c) => c.acronym),
      ...(spec.rowTotal ? ['Total'] : []),
    ];
    applyHeaderStyle(headerRow);
    headerRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
    headerRow.getCell(2).alignment = { vertical: 'middle', horizontal: 'left' };

    const amountByKey = new Map(
      matrix.cells.map((c) => [`${c.programId}-${c.centerId}`, c.amount]),
    );
    const totalByProgram = new Map(
      matrix.programTotals.map((t) => [t.programId, t.total]),
    );
    const totalByCenter = new Map(
      matrix.centerTotals.map((t) => [t.centerId, t.total]),
    );

    for (const program of matrix.programs) {
      const programTotal = totalByProgram.get(program.programId) ?? 0;
      const cells = matrix.centers.map((center) =>
        spec.value(
          amountByKey.get(`${program.programId}-${center.centerId}`) ?? 0,
          programTotal,
          totalByCenter.get(center.centerId) ?? 0,
        ),
      );
      const row = sheet.addRow([
        program.officialCode,
        program.name,
        ...cells,
        ...(spec.rowTotal ? [spec.rowTotal(programTotal)] : []),
      ]);
      for (let col = 3; col <= lastCol; col++) {
        row.getCell(col).numFmt = spec.numFmt;
      }
      if (spec.rowTotal) row.getCell(lastCol).font = { bold: true };
    }

    /* Bottom totals row — the per-center column totals plus the grand total.
     * Amounts sheet only; see `columnTotals` on SheetSpec for why. */
    if (spec.columnTotals) {
      const grandTotal = matrix.centerTotals.reduce(
        (sum, t) => sum + t.total,
        0,
      );
      const totalsRow = sheet.addRow([
        'Total',
        '',
        ...matrix.centers.map(
          (center) => totalByCenter.get(center.centerId) ?? 0,
        ),
        ...(spec.rowTotal ? [grandTotal] : []),
      ]);
      totalsRow.font = { bold: true };
      for (let col = 3; col <= lastCol; col++) {
        totalsRow.getCell(col).numFmt = spec.numFmt;
      }
      totalsRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.border = { top: { style: 'thin', color: { argb: 'FF999999' } } };
      });
    }

    /* Column widths: identity columns wide enough to read, data columns
     * uniform so the grid stays scannable. */
    sheet.getColumn(1).width = 16;
    sheet.getColumn(2).width = 46;
    for (let col = 3; col <= lastCol; col++) {
      sheet.getColumn(col).width = spec.numFmt === FMT_CURRENCY ? 16 : 13;
    }
  }

  /**
   * Converts a 1-based column index to its Excel letter (1 → A, 27 → AA).
   * Needed for the merged banner ranges, whose width depends on how many
   * centers exist.
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
