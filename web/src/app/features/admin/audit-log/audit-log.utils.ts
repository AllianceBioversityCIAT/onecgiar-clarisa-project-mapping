/**
 * audit-log.utils.ts
 *
 * Pure utility functions shared by the audit-log page (AuditLogComponent) and
 * the per-entity history tabs (e.g. UserAuditTabComponent).
 *
 * Extracted so both consumers import from a single source of truth rather than
 * duplicating the helpers inline. The functions here have no Angular DI
 * dependencies — they are plain TypeScript functions that can be called from
 * any component.
 */

import { AuditEvent } from './audit-event.model';

// ---------------------------------------------------------------------------
// Action label map
// ---------------------------------------------------------------------------

/**
 * Maps raw action strings (from the API) to friendly display labels.
 * Unknown actions fall back to the raw string via `actionLabel()`.
 */
export const ACTION_LABELS: Record<string, string> = {
  'project.update': 'Updated project',
  'project.metadata_update': 'Edited project metadata',
  'project.create': 'Created project',
  'project.archive': 'Archived project',
  'project.locked': 'Locked project',
  'project.reopened': 'Reopened project',
  'project.snapshot_republished': 'Republished snapshot',
  'mapping.create': 'Created mapping',
  'mapping.counter_proposed': 'Counter-proposed mapping',
  'mapping.agreed': 'Agreed to mapping',
  'mapping.removed': 'Removed mapping',
  'user.create': 'Created user',
  'user.role_changed': 'Changed user role',
  'user.deactivated': 'Deactivated user',
  'user.reactivated': 'Reactivated user',
  'user.reassigned': 'Reassigned user',
  'user.update': 'Updated user',
  'snapshot.create': 'Published snapshot',
  'import.run': 'Imported data',
  'clarisa.sync': 'Synced CLARISA',
  'auth.dev_login': 'Dev-login impersonation',
};

// ---------------------------------------------------------------------------
// Field label map (used in diff tables)
// ---------------------------------------------------------------------------

const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  description: 'Description',
  summary: 'Summary',
  funder: 'Funder',
  fundingSource: 'Funding Source',
  startDate: 'Start Date',
  endDate: 'End Date',
  totalBudget: 'Total Budget',
  remainingBudget: 'Remaining Budget',
  role: 'Role',
  isActive: 'Active',
  centerId: 'Center',
  programId: 'Program',
  status: 'Status',
  allocationPercentage: 'Allocation %',
};

/** Fields whose values should be rendered as USD amounts. */
const CURRENCY_FIELDS = new Set(['totalBudget', 'remainingBudget']);

/** Fields whose values should be rendered as dates. */
const DATE_FIELDS = new Set(['startDate', 'endDate']);

// ---------------------------------------------------------------------------
// Exported helper functions
// ---------------------------------------------------------------------------

/**
 * Returns a human-readable label for an action string.
 * Falls back to stripping the entity prefix and title-casing if not in the map.
 */
export function actionLabel(action: string): string {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  const bare = action.includes('.') ? action.split('.').slice(1).join('.') : action;
  return bare.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Formats an ISO datetime string as "03 May 2026, 17:41".
 * Uses Intl.DateTimeFormat for locale-aware formatting with no Angular DI deps.
 */
export function formatAuditTimestamp(isoString: string): string {
  try {
    const date = new Date(isoString);
    const day = date.getDate().toString().padStart(2, '0');
    const month = date.toLocaleString('en-US', { month: 'short' });
    const year = date.getFullYear();
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${day} ${month} ${year}, ${hours}:${minutes}`;
  } catch {
    return isoString;
  }
}

/**
 * Formats an audit field value for display in a diff table.
 *
 * Handles:
 * - null / undefined / '' → "—"
 * - '<truncated>' sentinel → "(value too large)"
 * - Currency fields → USD notation
 * - Date fields → "dd MMM yyyy"
 * - Arrays → comma-joined string
 * - All other → String()
 */
export function formatAuditValue(fieldName: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (value === '<truncated>') return '(value too large)';

  if (CURRENCY_FIELDS.has(fieldName)) {
    const num = Number(value);
    if (!isNaN(num)) {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
      }).format(num);
    }
  }

  if (DATE_FIELDS.has(fieldName)) {
    try {
      const date = new Date(String(value));
      const day = date.getDate().toString().padStart(2, '0');
      const month = date.toLocaleString('en-US', { month: 'short' });
      const year = date.getFullYear();
      return `${day} ${month} ${year}`;
    } catch {
      return String(value);
    }
  }

  if (Array.isArray(value)) {
    return (value as unknown[]).map((v) => String(v)).join(', ');
  }

  return String(value);
}

/**
 * Returns a human-readable label for a camelCase field name.
 * Falls back to splitting on capital letters.
 */
export function fieldLabel(fieldName: string): string {
  return FIELD_LABELS[fieldName] ?? fieldName.replace(/([A-Z])/g, ' $1').trim();
}

/**
 * Returns the CSS class name for a role badge.
 * Used in templates as `[styleClass]="roleBadgeClass(event.actorRole)"`.
 */
export function roleBadgeClass(role: AuditEvent['actorRole']): string {
  return `role-badge role-badge--${role}`;
}

/**
 * Returns a human-readable label for an actor role.
 */
export function roleLabel(role: AuditEvent['actorRole']): string {
  const labels: Record<string, string> = {
    admin: 'Admin',
    unit_admin: 'Unit Admin',
    workflow_admin: 'Workflow Admin',
    center_rep: 'Center Rep',
    program_rep: 'Program Rep',
    system: 'System',
  };
  return labels[role] ?? role;
}

/**
 * Returns the PrimeIcons class for a given entity type.
 */
export function entityIcon(entityType: AuditEvent['entityType']): string {
  const icons: Record<string, string> = {
    project: 'pi pi-folder',
    project_mapping: 'pi pi-arrow-right-arrow-left',
    user: 'pi pi-user',
    published_snapshot: 'pi pi-camera',
    import_run: 'pi pi-file-import',
    clarisa_sync: 'pi pi-refresh',
    system: 'pi pi-cog',
  };
  return icons[entityType] ?? 'pi pi-circle';
}

/**
 * Returns a human-readable label for an entity type.
 */
export function entityTypeLabel(entityType: AuditEvent['entityType']): string {
  const labels: Record<string, string> = {
    project: 'Project',
    project_mapping: 'Mapping',
    user: 'User',
    published_snapshot: 'Snapshot',
    import_run: 'Import',
    clarisa_sync: 'CLARISA Sync',
    system: 'System',
  };
  return labels[entityType] ?? entityType;
}
