import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Select } from 'primeng/select';
import { AuthService } from '../../core/services/auth.service';

/**
 * CenterSwitcherComponent
 *
 * Renders a pill-styled p-select in the header that lets multi-center reps
 * switch between their assigned centers. Only visible when the authenticated
 * user has more than one center assigned (centerIds.length > 1).
 *
 * Selecting a center delegates to AuthService.setActiveCenter(), which updates
 * the activeCenterId signal and persists the selection to localStorage.
 * The actual page data reload is handled by B-4 (an effect in each feature
 * component) — this component only manages the selection.
 */
@Component({
  selector: 'app-center-switcher',
  standalone: true,
  imports: [FormsModule, Select],
  templateUrl: './center-switcher.component.html',
  styleUrl: './center-switcher.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CenterSwitcherComponent {
  protected readonly authService = inject(AuthService);

  /** Only render when the user has more than one center assigned. */
  readonly showSwitcher = computed(
    () => (this.authService.currentUser()?.centerIds.length ?? 0) > 1,
  );

  /**
   * Ordered list of Center objects for the p-select options.
   * Already sorted by sort_order (primary first) by the backend.
   */
  readonly centerOptions = computed(() => this.authService.currentUser()?.centers ?? []);

  /**
   * Currently active center ID, falling back to the user's primary centerId
   * when no explicit selection has been persisted yet.
   */
  readonly activeId = computed(
    () => this.authService.activeCenterId() ?? this.authService.currentUser()?.centerId ?? null,
  );

  /**
   * Called when the user selects a different center from the dropdown.
   * Guards against no-op selections before delegating to the service.
   */
  onCenterChange(newId: number): void {
    if (newId === this.activeId()) {
      return;
    }
    this.authService.setActiveCenter(newId);
  }
}
