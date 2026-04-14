import {
  Component,
  OnInit,
  inject,
  signal,
  computed,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';
import {
  ReactiveFormsModule,
  FormBuilder,
  FormGroup,
  Validators,
} from '@angular/forms';
import { firstValueFrom } from 'rxjs';

// PrimeNG imports
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { InputNumberModule } from 'primeng/inputnumber';
import { SelectModule } from 'primeng/select';
import { ToastModule } from 'primeng/toast';
import { DividerModule } from 'primeng/divider';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageService } from 'primeng/api';

import { MappingsService } from '../services/mappings.service';
import { ProjectsService } from '../../projects/services/projects.service';
import { ReferenceDataService } from '../../../core/services/reference-data.service';
import { AuthService } from '../../../core/services/auth.service';
import { CreateMappingDto } from '../models/mapping.model';
import { Project } from '../../projects/models/project.model';

/**
 * MappingFormComponent — create form for project-program mappings.
 *
 * Route: /mappings/new?projectId=X  (center_rep only)
 *
 * Center reps select a project (filtered to their center) and a program,
 * set an initial allocation %, and save as a draft mapping.
 */
@Component({
  selector: 'app-mapping-form',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    RouterLink,
    CardModule,
    ButtonModule,
    InputNumberModule,
    SelectModule,
    ToastModule,
    DividerModule,
    ProgressSpinnerModule,
    SkeletonModule,
  ],
  providers: [MessageService],
  templateUrl: './mapping-form.component.html',
  styleUrl: './mapping-form.component.scss',
})
export class MappingFormComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly mappingsService = inject(MappingsService);
  private readonly projectsService = inject(ProjectsService);
  private readonly refData = inject(ReferenceDataService);
  private readonly authService = inject(AuthService);
  private readonly messageService = inject(MessageService);

  // -----------------------------------------------------------------------
  // State signals
  // -----------------------------------------------------------------------

  /** True while the form is being submitted. */
  readonly submitting = signal(false);

  /** All active projects (filtered to user's center). */
  readonly projects = signal<Project[]>([]);

  /** True while loading projects for the dropdown. */
  readonly loadingProjects = signal(false);

  /** All programs from reference data. */
  readonly programs = computed(() => this.refData.programs());

  /** True while loading programs. */
  readonly loadingPrograms = computed(() => this.refData.programs().length === 0);

  // -----------------------------------------------------------------------
  // Form
  // -----------------------------------------------------------------------

  readonly form: FormGroup = this.fb.group({
    projectId: [null, Validators.required],
    programId: [null, Validators.required],
    allocationPercentage: [null, [Validators.required, Validators.min(1), Validators.max(100)]],
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async ngOnInit(): Promise<void> {
    // Load reference data
    this.refData.loadPrograms();
    await this.loadProjects();

    // Pre-fill project from query param
    const rawProjectId = this.route.snapshot.queryParamMap.get('projectId');
    if (rawProjectId) {
      this.form.patchValue({ projectId: Number(rawProjectId) });
    }
  }

  // -----------------------------------------------------------------------
  // Data loading
  // -----------------------------------------------------------------------

  /** Loads projects filtered to the current user's center. */
  private async loadProjects(): Promise<void> {
    this.loadingProjects.set(true);
    try {
      const user = this.authService.currentUser();
      const all: Project[] = [];
      let page = 1;
      const limit = 100;
      let total = 0;

      do {
        const response = await firstValueFrom(
          this.projectsService.getProjects({ limit, page }),
        );
        all.push(...response.data);
        total = response.total;
        page++;
      } while (all.length < total);

      // Filter to user's center
      const filtered = user?.centerId
        ? all.filter((p) => p.center?.id === user.centerId)
        : all;

      this.projects.set(filtered);
    } catch {
      this.projects.set([]);
    } finally {
      this.loadingProjects.set(false);
    }
  }

  // -----------------------------------------------------------------------
  // Submission
  // -----------------------------------------------------------------------

  onSubmit(): void {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.submitting()) return;

    this.submitting.set(true);
    const raw = this.form.getRawValue();

    const dto: CreateMappingDto = {
      projectId: raw.projectId,
      programId: raw.programId,
      allocationPercentage: raw.allocationPercentage,
    };

    this.mappingsService.createMapping(dto).subscribe({
      next: () => {
        this.submitting.set(false);
        this.messageService.add({
          severity: 'success',
          summary: 'Created',
          detail: 'Mapping created as draft.',
        });
        setTimeout(() => this.router.navigate(['/mappings']), 1200);
      },
      error: (err) => {
        this.submitting.set(false);
        const detail =
          err?.error?.message || 'Failed to create mapping. Please try again.';
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail,
        });
      },
    });
  }

  onCancel(): void {
    this.router.navigate(['/mappings']);
  }

  // -----------------------------------------------------------------------
  // Validation helpers
  // -----------------------------------------------------------------------

  isInvalid(controlName: string): boolean {
    const c = this.form.get(controlName);
    return !!(c?.invalid && c.touched);
  }
}
