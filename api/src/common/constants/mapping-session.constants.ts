/**
 * Shared constants for the annual mapping-session kill switch
 * (`system_settings.mapping_session_closed`).
 *
 * Both the guard that blocks mutations and any caller that needs to
 * explain the refusal use these, so the wording the user sees is
 * identical everywhere (API error toast, negotiation-page banner).
 */

/** Machine-readable discriminator on the 403 body, for front-end branching. */
export const MAPPING_SESSION_CLOSED_CODE = 'MAPPING_SESSION_CLOSED';

/**
 * The exact notice shown to center and program representatives when the
 * session is closed. Kept verbatim (wording approved by the PRMS team) —
 * the web app renders the same string in its negotiation-page banner.
 */
export const MAPPING_SESSION_CLOSED_MESSAGE =
  'Dear Center and P/A representatives, the mapping session for this year ' +
  'has been concluded and currently no further action can be performed on ' +
  'the module. Please contact PRMS support team if you have any questions.';
