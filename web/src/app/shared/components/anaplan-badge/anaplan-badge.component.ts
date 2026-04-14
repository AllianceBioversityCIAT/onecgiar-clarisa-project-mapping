import { Component, input } from '@angular/core';
import { TooltipModule } from 'primeng/tooltip';

/**
 * Small pill badge indicating a field is sourced from Anaplan.
 * Shows a tooltip on hover with a contextual message.
 */
@Component({
  selector: 'app-anaplan-badge',
  standalone: true,
  imports: [TooltipModule],
  template: `
    <span
      class="anaplan-badge"
      [pTooltip]="tooltip()"
      tooltipPosition="top"
    >
      <i class="pi pi-database"></i>
      Anaplan
    </span>
  `,
  styles: [
    `
      .anaplan-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        background: #f4f2f2;
        border: 1px solid #d0cece;
        color: #555;
        border-radius: 4px;
        font-size: 0.7rem;
        padding: 2px 7px;
        font-weight: 500;
        cursor: help;

        i {
          font-size: 0.65rem;
        }
      }
    `,
  ],
})
export class AnaplanBadgeComponent {
  /** Tooltip text. Defaults to a simple source label; pass a custom message for edit contexts. */
  readonly tooltip = input('This field is sourced from Anaplan');
}
