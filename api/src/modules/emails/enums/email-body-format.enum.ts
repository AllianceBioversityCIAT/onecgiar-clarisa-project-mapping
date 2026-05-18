/**
 * MIME-style format of an email body.
 *
 * The migration stores a single `body` column (MEDIUMTEXT) plus a
 * `body_format` enum so a future plain-text fallback only requires
 * an additive `body_text` ALTER, not a column rename.
 *
 * - `html` – The body is HTML and should be delivered with a
 *            `Content-Type: text/html` MIME part. Default for all
 *            transactional PRMS emails.
 * - `text` – The body is plain text; delivered as `text/plain`.
 *
 * Enum values match the MySQL ENUM declared in the
 * `1781000000000-AddEmailsTable` migration, verbatim and case-sensitive.
 */
export enum EmailBodyFormat {
  TEXT = 'text',
  HTML = 'html',
}
