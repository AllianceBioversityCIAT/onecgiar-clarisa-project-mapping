import type ExcelJS from 'exceljs';

/**
 * Shared style constants and helper functions for PRMS Excel exports.
 *
 * Centralising these here keeps both export orchestrators (list and detail)
 * visually consistent without copy-pasting hex codes and font specs.
 */

/** PRMS navy — used for header row backgrounds across every data sheet. */
export const NAVY = '0F212F';

/**
 * Status cell fill colors in ExcelJS ARGB format (FF prefix = fully opaque).
 * Applied per-row to the status cell based on the project or mapping status.
 */
export const STATUS_FILLS = {
  project: {
    active: 'FFE7F5EC',
    archived: 'FFEDEDED',
    draft: 'FFE7EEFB',
  },
  mapping: {
    agreed: 'FFE7F5EC',
    negotiating: 'FFFFF4D9',
    removed: 'FFFBE7E7',
    draft: 'FFEDEDED',
  },
} as const;

/** Excel number format for monetary values (USD-style thousands separator). */
export const FMT_CURRENCY = '#,##0.00';

/**
 * Excel number format for allocation percentages.
 * Values are stored as 0–100 in the database; we display them with the
 * percent symbol appended — do NOT divide by 100 before writing to a cell.
 */
export const FMT_PERCENT = '0.00"%"';

/** ISO-style date format for all date cells. */
export const FMT_DATE = 'yyyy-mm-dd';

/**
 * Tab color constants keyed by sheet name theme.
 * These are ARGB hex strings supplied to `worksheet.properties.tabColor`.
 */
export const TAB_COLORS = {
  navy: 'FF0F212F',
  green: 'FF2E7D32',
  blue: 'FF1565C0',
  orange: 'FFE65100',
  purple: 'FF6A1B9A',
  teal: 'FF00838F',
  red: 'FFB71C1C',
} as const;

/**
 * Applies the standard PRMS header row style to an ExcelJS row.
 *
 * Produces: navy background, white bold text at 11pt, row height 28,
 * centered alignment, and a thin white bottom border for visual separation.
 *
 * @param row - The ExcelJS Row to style (should be the first row of the sheet).
 */
export function applyHeaderStyle(row: ExcelJS.Row): void {
  row.height = 28;
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = {
      bold: true,
      color: { argb: 'FFFFFFFF' },
      size: 11,
    };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: `FF${NAVY}` },
    };
    cell.alignment = {
      vertical: 'middle',
      horizontal: 'center',
      wrapText: false,
    };
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } },
    };
  });
}

/**
 * Sets auto-sized column widths on a worksheet.
 *
 * Inspects header label length and the first `sampleCount` data rows,
 * then sets each column's width to the longest value clamped between
 * 12 and 60 characters + 2 padding.
 *
 * @param worksheet  - The ExcelJS Worksheet to resize.
 * @param sampleCount - Number of data rows to sample (default 20).
 */
export function autoSizeColumns(
  worksheet: ExcelJS.Worksheet,
  sampleCount = 20,
): void {
  worksheet.columns.forEach((col) => {
    if (!col || !col.header) return;
    let maxLen = String(col.header).length;
    let rowIdx = 0;
    if (col.eachCell) {
      col.eachCell({ includeEmpty: false }, (cell) => {
        if (rowIdx++ > sampleCount) return;
        const len = cell.text ? String(cell.text).length : 0;
        if (len > maxLen) maxLen = len;
      });
    }
    col.width = Math.min(60, Math.max(12, maxLen + 2));
  });
}

/**
 * Returns the ARGB fill color for a project status string.
 * Falls back to the `draft` color for any unrecognised value.
 */
export function projectStatusFill(status: string): string {
  return (
    STATUS_FILLS.project[status as keyof typeof STATUS_FILLS.project] ??
    STATUS_FILLS.project.draft
  );
}

/**
 * Returns the ARGB fill color for a mapping status string.
 * Falls back to the `draft` color for any unrecognised value.
 */
export function mappingStatusFill(status: string): string {
  return (
    STATUS_FILLS.mapping[status as keyof typeof STATUS_FILLS.mapping] ??
    STATUS_FILLS.mapping.draft
  );
}

/**
 * Builds the timestamp suffix used in export filenames.
 * Format: YYYYMMdd-HHmm  (e.g. 20260428-1430)
 */
export function buildTimestamp(): string {
  const now = new Date();
  const Y = now.getFullYear();
  const M = String(now.getMonth() + 1).padStart(2, '0');
  const D = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  return `${Y}${M}${D}-${h}${m}`;
}
