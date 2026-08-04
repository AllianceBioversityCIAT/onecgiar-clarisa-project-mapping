import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TableModule } from 'primeng/table';
import { SkeletonModule } from 'primeng/skeleton';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { firstValueFrom } from 'rxjs';
import { DashboardService, AssignmentsMatrix } from '../dashboard/services/dashboard.service';

/** One rendered row for any of the 4 matrix tables: a program plus one formatted cell per center. */
interface MatrixDisplayRow {
  programId: number;
  officialCode: string;
  name: string;
  cells: { centerId: number; display: string }[];
  /** Row total, pre-formatted. Null when a total isn't meaningful for this table (Tables 3 & 4). */
  total: string | null;
}

/**
 * Assignments — admin-only live Program x Center $ allocation matrix,
 * scoped to the W3-Bilateral funding pool (WINDOW3 + BILATERAL projects).
 *
 * Renders the 4 stacked tables from the "W3-Bilateral" sheet of the source
 * spreadsheet (GitHub #107), traced directly from the sheet's formulas:
 *
 * 1. Program x Center Amount — raw agreed FY26 $ per program/center pair.
 * 2. Center as % of Program / Accelerator — cell / row (program) total.
 * 3. Program / Accelerator as % of Center — cell / column (center) total.
 * 4. Combined Concentration (A x B) — Table 2's cell x Table 3's cell at
 *    the same coordinate. Not a % and doesn't sum to 100% in either
 *    direction — it's a mutual-concentration index: only large when a
 *    Center is a major funder of that specific Program AND that Program
 *    is a major recipient within that Center's own portfolio.
 *
 * Scope is deliberately narrow (per the issue's clarified requirements):
 * W1-W2, "All funding", and the "Final (Manual)" manual-override layer are
 * explicitly out for this page — separate future work.
 */
@Component({
  selector: 'app-assignments',
  standalone: true,
  imports: [CommonModule, TableModule, SkeletonModule, ButtonModule, ToastModule],
  providers: [MessageService],
  templateUrl: './assignments.component.html',
  styleUrl: './assignments.component.scss',
})
export class AssignmentsComponent implements OnInit {
  private readonly dashboardService = inject(DashboardService);
  private readonly messageService = inject(MessageService);

  readonly loading = signal(true);
  readonly matrix = signal<AssignmentsMatrix | null>(null);

  /** True while the Excel workbook is being generated and downloaded. */
  readonly exporting = signal(false);

  /** Placeholder rows so the tables render skeletons while loading. */
  readonly skeletonRows = Array(6).fill(null);

  /** Table 1: Program x Center Amount ($). */
  readonly amountRows = computed<MatrixDisplayRow[]>(() => {
    const m = this.matrix();
    if (!m) return [];
    const amountByKey = this.cellMap(m);
    const totalByProgram = new Map<number, number>(
      m.programTotals.map((t) => [t.programId, t.total]),
    );
    return m.programs.map((p) => ({
      programId: p.programId,
      officialCode: p.officialCode,
      name: p.name,
      cells: m.centers.map((c) => ({
        centerId: c.centerId,
        display: this.money(amountByKey.get(`${p.programId}-${c.centerId}`) ?? 0),
      })),
      total: this.money(totalByProgram.get(p.programId) ?? 0),
    }));
  });

  /** Table 2: Center as % of Program / Accelerator — cell / row total. Each row sums to ~100%. */
  readonly centerShareOfProgramRows = computed<MatrixDisplayRow[]>(() => {
    const m = this.matrix();
    if (!m) return [];
    const amountByKey = this.cellMap(m);
    const totalByProgram = new Map<number, number>(
      m.programTotals.map((t) => [t.programId, t.total]),
    );
    return m.programs.map((p) => {
      const programTotal = totalByProgram.get(p.programId) ?? 0;
      return {
        programId: p.programId,
        officialCode: p.officialCode,
        name: p.name,
        cells: m.centers.map((c) => {
          const amount = amountByKey.get(`${p.programId}-${c.centerId}`) ?? 0;
          const share = programTotal > 0 ? amount / programTotal : 0;
          return { centerId: c.centerId, display: this.percent(share) };
        }),
        total: programTotal > 0 ? this.percent(1) : '—',
      };
    });
  });

  /** Table 3: Program / Accelerator as % of Center — cell / column total. Each column sums to ~100%. */
  readonly programShareOfCenterRows = computed<MatrixDisplayRow[]>(() => {
    const m = this.matrix();
    if (!m) return [];
    const amountByKey = this.cellMap(m);
    const totalByCenter = new Map<number, number>(m.centerTotals.map((t) => [t.centerId, t.total]));
    return m.programs.map((p) => ({
      programId: p.programId,
      officialCode: p.officialCode,
      name: p.name,
      cells: m.centers.map((c) => {
        const amount = amountByKey.get(`${p.programId}-${c.centerId}`) ?? 0;
        const centerTotal = totalByCenter.get(c.centerId) ?? 0;
        const share = centerTotal > 0 ? amount / centerTotal : 0;
        return { centerId: c.centerId, display: this.percent(share) };
      }),
      total: null,
    }));
  });

  /**
   * Table 4: Combined Concentration (A x B) — centerShareOfProgramRows cell
   * multiplied by programShareOfCenterRows cell at the same coordinate.
   * Plain decimal (not %) since values are often tiny (~1e-5) and don't sum
   * to anything meaningful.
   */
  readonly combinedIndexRows = computed<MatrixDisplayRow[]>(() => {
    const m = this.matrix();
    if (!m) return [];
    const amountByKey = this.cellMap(m);
    const totalByProgram = new Map<number, number>(
      m.programTotals.map((t) => [t.programId, t.total]),
    );
    const totalByCenter = new Map<number, number>(m.centerTotals.map((t) => [t.centerId, t.total]));
    return m.programs.map((p) => {
      const programTotal = totalByProgram.get(p.programId) ?? 0;
      return {
        programId: p.programId,
        officialCode: p.officialCode,
        name: p.name,
        cells: m.centers.map((c) => {
          const amount = amountByKey.get(`${p.programId}-${c.centerId}`) ?? 0;
          const centerTotal = totalByCenter.get(c.centerId) ?? 0;
          const shareOfProgram = programTotal > 0 ? amount / programTotal : 0;
          const shareOfCenter = centerTotal > 0 ? amount / centerTotal : 0;
          return { centerId: c.centerId, display: this.decimal(shareOfProgram * shareOfCenter) };
        }),
        total: null,
      };
    });
  });

  ngOnInit(): void {
    this.loading.set(true);
    this.fetchMatrix().finally(() => this.loading.set(false));
  }

  /**
   * Downloads all four matrix tables as a single Excel sheet, stacked in
   * the same order as this page. The workbook is built server-side from the
   * same query that feeds this page, so the file and the screen always agree.
   */
  exportExcel(): void {
    if (this.exporting()) return;
    this.exporting.set(true);

    this.dashboardService.exportAssignmentsMatrix().subscribe({
      next: (filename) => {
        this.exporting.set(false);
        this.messageService.add({
          severity: 'success',
          summary: 'Export ready',
          detail: `Downloaded ${filename}`,
        });
      },
      error: (err: Error) => {
        this.exporting.set(false);
        this.messageService.add({
          severity: 'error',
          summary: 'Export failed',
          detail: err.message,
        });
      },
    });
  }

  private async fetchMatrix(): Promise<void> {
    try {
      this.matrix.set(await firstValueFrom(this.dashboardService.getAssignmentsMatrix()));
    } catch {
      // Non-critical — the tables show their empty state when null.
    }
  }

  /** Builds a `programId-centerId` → amount lookup from the matrix's flat cell list. */
  private cellMap(m: AssignmentsMatrix): Map<string, number> {
    return new Map(m.cells.map((c) => [`${c.programId}-${c.centerId}`, c.amount]));
  }

  money(n: number): string {
    return '$' + Math.round(n).toLocaleString('en-US');
  }

  private percent(fraction: number): string {
    return `${(fraction * 100).toFixed(1)}%`;
  }

  /** Plain decimal formatter for Table 4 — extra precision for very small values so they don't round to 0. */
  private decimal(n: number): string {
    if (n === 0) return '0';
    return Math.abs(n) < 0.0001 ? n.toFixed(6) : n.toFixed(4);
  }
}
