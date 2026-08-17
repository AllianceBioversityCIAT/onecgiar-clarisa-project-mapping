/**
 * Constants for the annual mapping-session kill switch
 * (`system_settings.mappingSessionClosed`).
 *
 * The API rejects every mapping mutation with this same wording while the
 * session is closed (`api/src/common/constants/mapping-session.constants.ts`);
 * keep the two in sync so the banner and any error toast read identically.
 */

/** Discriminator on the API's 403 body when the session is closed. */
export const MAPPING_SESSION_CLOSED_CODE = 'MAPPING_SESSION_CLOSED';

/** Approved notice shown to center and program representatives. */
export const MAPPING_SESSION_CLOSED_NOTICE =
  'Dear Center and P/A representatives, the mapping session for this year ' +
  'has been concluded and currently no further action can be performed on ' +
  'the module. Please contact PRMS support team if you have any questions.';
