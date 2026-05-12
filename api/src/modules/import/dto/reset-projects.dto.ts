import { Equals, IsString } from 'class-validator';

/**
 * Body payload for `POST /admin/danger-zone/reset-projects`.
 *
 * This endpoint wipes every project-scoped table in the database. To
 * prevent accidental invocation (e.g. a curl mistake or a stale Swagger
 * tab), the admin must explicitly type the literal confirmation phrase
 * `RESET PROJECTS` in the request body. Anything else — wrong casing,
 * extra whitespace, missing field — is rejected with a 400 before any
 * destructive code runs.
 *
 * The phrase is intentionally a value-equals check rather than a regex
 * or boolean flag so it cannot be satisfied by a default form value or
 * an auto-filled JSON template.
 */
export class ResetProjectsDto {
  /**
   * Must equal the literal string `RESET PROJECTS` (case-sensitive,
   * no surrounding whitespace). Any other value fails validation with
   * a clear, copy-pasteable error message so the admin can retry.
   */
  @IsString()
  @Equals('RESET PROJECTS', {
    message: "confirmation phrase mismatch — expected 'RESET PROJECTS'",
  })
  confirmation!: string;
}
