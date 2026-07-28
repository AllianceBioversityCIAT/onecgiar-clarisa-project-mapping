import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TableModule } from 'primeng/table';
import { SkeletonModule } from 'primeng/skeleton';
import { ButtonModule } from 'primeng/button';
import { firstValueFrom } from 'rxjs';
import { DashboardService, AssignmentsMatrix } from '../dashboard/services/dashboard.service';

/** One rendered row: a program plus its per-center cell values and row total. */
interface AssignmentsRow {
  programId: number;
  officialCode: string;
  name: string;
  cells: { centerId: number; amount: number }[];
  total: number;
}

/**
 * Assignments — admin-only live Program x Center $ allocation matrix,
 * scoped to the W3-Bilateral funding pool (WINDOW3 + BILATERAL projects).
 *
 * Mirrors the "W3-Bilateral" sheet of the source spreadsheet (GitHub #107):
 * rows = Programs/Accelerators, columns = Centers, cell = agreed FY26 $
 * allocated from that center to that program. A toggle switches the cell
 * display between $ amount and "% of program row total" — the sheet's
 * derived "Center as % of Program" sub-table.
 *
 * Scope is deliberately narrow (per the issue's clarified requirements):
 * W1-W2, "All funding", and the "Final (Manual)" manual-override layer are
 * explicitly out for this page — separate future work.
 */
@Component({
  selector: 'app-assignments',
  standalone: true,
  imports: [CommonModule, TableModule, SkeletonModule, ButtonModule],
  templateUrl: './assignments.component.html',
  styleUrl: './assignments.component.scss',
})
export class AssignmentsComponent implements OnInit {
  private readonly dashboardService = inject(DashboardService);

  readonly loading = signal(true);
  readonly matrix = signal<AssignmentsMatrix | null>(null);
  /** false = show $ amounts, true = show each cell as % of its program row total. */
  readonly showPercent = signal(false);

  /** Placeholder rows so the table renders skeletons while loading. */
  readonly skeletonRows = Array(6).fill(null);

  /** One row per program, with an amount per center (0 for empty cells). */
  readonly rows = computed<AssignmentsRow[]>(() => {
    const m = this.matrix();
    if (!m) return [];

    const amountByKey = new Map<string, number>(
      m.cells.map((c) => [`${c.programId}-${c.centerId}`, c.amount]),
    );
    const totalByProgram = new Map<number, number>(
      m.programTotals.map((t) => [t.programId, t.total]),
    );

    return m.programs.map((p) => ({
      programId: p.programId,
      officialCode: p.officialCode,
      name: p.name,
      cells: m.centers.map((c) => ({
        centerId: c.centerId,
        amount: amountByKey.get(`${p.programId}-${c.centerId}`) ?? 0,
      })),
      total: totalByProgram.get(p.programId) ?? 0,
    }));
  });

  ngOnInit(): void {
    this.loading.set(true);
    this.fetchMatrix().finally(() => this.loading.set(false));
  }

  private async fetchMatrix(): Promise<void> {
    try {
      this.matrix.set(await firstValueFrom(this.dashboardService.getAssignmentsMatrix()));
    } catch {
      // Non-critical — the table shows its empty state when null.
    }
  }

  togglePercent(): void {
    this.showPercent.update((v) => !v);
  }

  /** Formats a cell for display: $ amount, or % of the row's program total. */
  cellDisplay(row: AssignmentsRow, amount: number): string {
    if (!this.showPercent()) {
      return this.money(amount);
    }
    return row.total > 0 ? `${((amount / row.total) * 100).toFixed(1)}%` : '—';
  }

  money(n: number): string {
    return '$' + Math.round(n).toLocaleString('en-US');
  }
}
