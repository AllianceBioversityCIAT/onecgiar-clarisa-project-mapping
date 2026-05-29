/**
 * Typed shape of the TOC API response (GET /api/toc/{officialCode}).
 *
 * Only the fields actually consumed by `TocSyncService` are typed.
 * The TOC API returns ~3MB of nested objects per program — the
 * unused payload is intentionally left as `unknown` so we don't
 * drift if the upstream schema changes.
 */

/** Optional `ost_wp` block on AOW (category=WP, wp_type=AOW) nodes. */
export interface TocOstWp {
  /** CLARISA-side stable id for cross-system reference. */
  toc_id?: string | null;
  acronym?: string | null;
  wp_official_code?: string | null;
  name?: string | null;
  source?: string | null;
  initiativeId?: string | null;
}

/**
 * A single node from the TOC `data[]` array.
 *
 * `data[]` is heterogeneous: categories include `OUTPUT`, `EOI`,
 * `OUTCOME`, `WP`, `SDG`, `IA`, `PROJECT`. We only consume
 * `WP` (filtered to `wp_type === "AOW"`), `OUTPUT`, `OUTCOME`,
 * and `EOI`.
 */
export interface TocDataNode {
  /** Graph node id — what `OUTPUT.group` / `OUTCOME.group` references. */
  id: string;

  /** Discriminator: `WP` | `OUTPUT` | `OUTCOME` | `EOI` | `SDG` | `IA` | `PROJECT`. */
  category: string;

  /** Only present on `WP` nodes; we ingest those with `"AOW"`. */
  wp_type?: string | null;

  /** Display title. Often empty on AOW nodes (use `ost_wp.name`). */
  title?: string | null;

  /** Free-text description, OUTPUT / OUTCOME / EOI only. */
  description?: string | null;

  /** OUTPUT-only categorization (e.g. "Knowledge product"). */
  type_of_output?: string | null;

  /** Cross-link to whatever this node feeds into. */
  related_node_id?: string | null;

  /**
   * AOW (WP node) graph id this output/outcome belongs to.
   * May be empty string or null on outcomes — treat as nullable.
   */
  group?: string | null;

  /** AOW metadata block — only populated on `WP` / AOW nodes. */
  ost_wp?: TocOstWp | null;

  /** Catch-all for fields we don't model (~30+). Keeps the type honest. */
  [extra: string]: unknown;
}

/**
 * Top-level shape of the TOC API response.
 *
 * The real response has many more fields (`meta`, `narrative`,
 * `partners`, etc.); none are consumed here, so they are widened
 * to `unknown` rather than typed.
 */
export interface TocApiResponse {
  data: TocDataNode[];

  /**
   * MEL TOC graph UUID for this program. Present in the published
   * snapshot returned by `/api/toc/{officialCode}` and re-used by
   * `TocSyncService` to fetch the richer working-draft payload via
   * `/api/toc/{UUID}` on subsequent syncs.
   */
  original_id?: string | null;

  [extra: string]: unknown;
}
