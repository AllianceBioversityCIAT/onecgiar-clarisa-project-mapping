/**
 * Funding source categories for a project.
 *
 * - `window3`   – CGIAR Window 3 pooled funding.
 * - `bilateral` – Direct bilateral donor funding.
 * - `srv`       – System-level revenue (SRV).
 * - `other`     – Any other funding mechanism.
 */
export enum FundingSource {
  WINDOW3 = 'window3',
  BILATERAL = 'bilateral',
  SRV = 'srv',
  OTHER = 'other',
}
