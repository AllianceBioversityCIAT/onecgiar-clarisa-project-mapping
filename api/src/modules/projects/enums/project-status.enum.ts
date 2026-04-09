/**
 * Lifecycle status of a project.
 *
 * - `draft`    – Project is being prepared and is not yet active.
 * - `active`   – Project is currently in progress.
 * - `archived` – Project has been archived and is no longer active.
 */
export enum ProjectStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  ARCHIVED = 'archived',
}
