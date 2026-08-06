import { Component, OnInit, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { SkeletonModule } from 'primeng/skeleton';
import { TagModule } from 'primeng/tag';
import { ChipModule } from 'primeng/chip';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';

import { HeaderComponent } from '../../../layout/header/header.component';
import { PublicHomeService } from '../services/public-home.service';
import {
  PublishedProjectItem,
  PublishedProjectMapping,
  PublishedProjectCountry,
  SnapshotSummary,
} from '../models/public-home.model';

/**
 * Public project detail page — shows all information for a single
 * published project from the latest active snapshot.
 *
 * Rendered at /home/project/:id outside the authenticated shell.
 *
 * Everything the snapshot froze is rendered here: the project metadata,
 * both country scopes (benefit and implementation, each with a global flag),
 * and every settled mapping with its allocation, budget share, ratings and
 * the Theory of Change nodes the program committed to. Fields added to the
 * payload after the first snapshots were published are absent on older
 * versions, so each block guards on presence rather than assuming it.
 */
@Component({
  selector: 'app-public-project-detail',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    SkeletonModule,
    TagModule,
    ChipModule,
    CardModule,
    TableModule,
    ButtonModule,
    TooltipModule,
    HeaderComponent,
  ],
  templateUrl: './public-project-detail.component.html',
  styleUrl: './public-project-detail.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PublicProjectDetailComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly publicHomeService = inject(PublicHomeService);

  readonly project = signal<PublishedProjectItem | null>(null);
  readonly loading = signal<boolean>(true);
  readonly error = signal<boolean>(false);

  /**
   * Version this page's data was frozen from. Fetched separately because the
   * single-project endpoint returns the row alone — the list endpoint is the
   * one that stamps its pages with a snapshot reference.
   */
  readonly snapshot = signal<SnapshotSummary | null>(null);

  /** Mapping rows whose TOC contribution is expanded, keyed by program code. */
  readonly expandedMappings = signal<Record<string, boolean>>({});

  /** Σ of the agreed allocations — normally 100, but old rounds could stop short. */
  readonly totalAllocation = computed<number>(() =>
    (this.project()?.mappings ?? []).reduce((sum, m) => sum + Number(m.allocationPercentage), 0),
  );

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (!id || isNaN(id)) {
      this.loading.set(false);
      this.error.set(true);
      return;
    }
    this.loadProject(id);
    this.loadSnapshot();
  }

  private loadProject(id: number): void {
    this.publicHomeService.getPublishedProject(id).subscribe({
      next: (project) => {
        this.project.set(project);
        this.loading.set(false);
      },
      error: () => {
        this.error.set(true);
        this.loading.set(false);
      },
    });
  }

  /** Version stamp is supplementary — a failure here never blocks the page. */
  private loadSnapshot(): void {
    this.publicHomeService.getLatestSnapshot().subscribe({
      next: (snapshot) => this.snapshot.set(snapshot),
      error: () => this.snapshot.set(null),
    });
  }

  /** Format funding source enum value for display (`window3` → `Window 3`). */
  formatFundingSource(value: string | null): string {
    if (!value) return '—';
    return value
      .replace(/_/g, ' ')
      .replace(/([a-z])(\d)/g, '$1 $2')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Definition of a funding source type, surfaced as a tooltip ('' if none defined). */
  fundingDefinition(value: string | null): string {
    const map: Record<string, string> = {
      bilateral:
        'Funding that flows directly (not through the CGIAR Trust Fund) from a Funder to a Center in support of CGIAR Research.',
      window3: 'Funding that flows from the Trust Fund through Window 3 to a Center.',
      other: 'Funding provided by the Center from its own resources.',
    };
    return map[value ?? ''] ?? '';
  }

  /** Generic snake_case → Title Case for enum-ish values (category, nature of funder). */
  formatEnum(value: string | null | undefined): string {
    if (!value) return '—';
    return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Format country list as comma-separated names. */
  getCountryNames(countries: { name: string }[]): string {
    if (!countries?.length) return '—';
    return countries.map((c) => c.name).join(', ');
  }

  /** Country chip label — appends the share when the snapshot recorded one. */
  countryLabel(country: PublishedProjectCountry): string {
    return country.allocationPercentage
      ? `${country.name} (${country.allocationPercentage}%)`
      : country.name;
  }

  /**
   * How the mapping reached its final state. `admin_decision` is the
   * workflow-admin arbitration path — agreed-equivalent, but the public
   * record should not present it as a mutual agreement.
   */
  statusLabel(status: string | undefined): string {
    if (status === 'admin_decision') return 'Admin Decision';
    if (status === 'agreed') return 'Agreed';
    return this.formatEnum(status);
  }

  /** Both terminal states are settled outcomes, so both render green. */
  statusSeverity(status: string | undefined): 'success' | 'info' {
    return status === 'agreed' || status === 'admin_decision' ? 'success' : 'info';
  }

  /** Number of TOC nodes attached to a mapping (0 on pre-TOC snapshots). */
  tocCount(mapping: PublishedProjectMapping): number {
    const toc = mapping.toc;
    if (!toc) return 0;
    return (toc.aows?.length ?? 0) + (toc.outputs?.length ?? 0) + (toc.outcomes?.length ?? 0);
  }

  /** Whether the TOC contribution panel for a mapping is open. */
  isTocExpanded(mapping: PublishedProjectMapping): boolean {
    return !!this.expandedMappings()[mapping.programCode];
  }

  /** Toggles a mapping's TOC contribution panel. */
  toggleToc(mapping: PublishedProjectMapping): void {
    this.expandedMappings.update((state) => ({
      ...state,
      [mapping.programCode]: !state[mapping.programCode],
    }));
  }
}
