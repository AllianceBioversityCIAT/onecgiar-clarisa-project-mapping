import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Select } from 'primeng/select';
import { AuthService } from '../../core/services/auth.service';

/**
 * ProgramSwitcherComponent
 *
 * Renders a pill-styled p-select in the header that lets multi-program reps
 * switch between their assigned programs. Only visible when the authenticated
 * user has more than one program assigned (programIds.length > 1).
 *
 * Selecting a program delegates to AuthService.setActiveProgram(), which updates
 * the activeProgramId signal and persists the selection to localStorage.
 * Mirrors CenterSwitcherComponent — see that component for full pattern notes.
 */
@Component({
  selector: 'app-program-switcher',
  standalone: true,
  imports: [FormsModule, Select],
  templateUrl: './program-switcher.component.html',
  styleUrl: './program-switcher.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProgramSwitcherComponent {
  protected readonly authService = inject(AuthService);

  /** Only render when the user has more than one program assigned. */
  readonly showSwitcher = computed(
    () => (this.authService.currentUser()?.programIds.length ?? 0) > 1,
  );

  /**
   * Ordered list of Program objects for the p-select options.
   * Already sorted by sort_order (primary first) by the backend.
   */
  readonly programOptions = computed(() => this.authService.currentUser()?.programs ?? []);

  /**
   * Currently active program ID, falling back to the user's primary programId
   * when no explicit selection has been persisted yet.
   */
  readonly activeId = computed(
    () => this.authService.activeProgramId() ?? this.authService.currentUser()?.programId ?? null,
  );

  /**
   * Called when the user selects a different program from the dropdown.
   * Guards against no-op selections before delegating to the service.
   */
  onProgramChange(newId: number): void {
    if (newId === this.activeId()) {
      return;
    }
    this.authService.setActiveProgram(newId);
  }
}
