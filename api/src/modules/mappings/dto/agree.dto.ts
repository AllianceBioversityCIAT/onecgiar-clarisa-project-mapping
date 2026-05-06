/**
 * DTO for marking agreement on a mapping's current terms.
 *
 * Body is empty by design. Either side (center or program) calls
 * `POST /mappings/:id/agree` without a payload; ratings are a
 * center-side responsibility set at create + allocation edit only,
 * and they are intentionally NOT collected here.
 */
export class AgreeDto {}
