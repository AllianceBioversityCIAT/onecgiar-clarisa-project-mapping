import { Component, OnInit, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { SkeletonModule } from 'primeng/skeleton';
import { TagModule } from 'primeng/tag';
import { ChipModule } from 'primeng/chip';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';

import { HeaderComponent } from '../../../layout/header/header.component';
import { PublicHomeService } from '../services/public-home.service';
import { PublishedProjectItem } from '../models/public-home.model';

/**
 * Public project detail page — shows all information for a single
 * published project from the latest active snapshot.
 *
 * Rendered at /home/project/:id outside the authenticated shell.
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

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (!id || isNaN(id)) {
      this.loading.set(false);
      this.error.set(true);
      return;
    }
    this.loadProject(id);
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

  /** Format funding source enum value for display. */
  formatFundingSource(value: string | null): string {
    if (!value) return '—';
    return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Format country list as comma-separated names. */
  getCountryNames(countries: { name: string }[]): string {
    if (!countries?.length) return '—';
    return countries.map((c) => c.name).join(', ');
  }
}
