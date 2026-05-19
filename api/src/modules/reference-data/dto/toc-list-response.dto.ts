import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TocOutcomeType } from '../entities/toc-outcome.entity';

/**
 * Compact program reference embedded on every TOC list row.
 *
 * Only the three fields the admin viewer actually renders are
 * exposed — the rest of the `Program` entity (clarisaId, syncedAt,
 * audit columns) is intentionally stripped to keep payloads lean
 * and to avoid leaking unrelated metadata.
 */
export class TocProgramRefDto {
  @ApiProperty({ description: 'Program id' })
  id: number;

  @ApiProperty({ description: 'Program official code (e.g. "SP01")' })
  officialCode: string;

  @ApiProperty({ description: 'Program display name' })
  name: string;
}

/**
 * Compact AOW reference embedded on outcome / output list rows.
 *
 * Only id + acronym + name are exposed — the consumer never needs
 * the full AOW row when it's just a join hint on an outcome/output.
 */
export class TocAowRefDto {
  @ApiProperty({ description: 'AOW id' })
  id: number;

  @ApiPropertyOptional({ description: 'AOW short acronym (e.g. "AOW03")' })
  acronym: string | null;

  @ApiPropertyOptional({ description: 'AOW display name' })
  name: string | null;
}

/**
 * Response row for `GET /admin/toc/aows`.
 *
 * camelCase field names mirror the entity TS properties. The
 * service shapes responses via a manual mapper rather than
 * relying on TypeORM's default serialization so the response
 * stays narrow even when the underlying entity grows.
 */
export class TocAowListItemDto {
  @ApiProperty({ description: 'AOW id (numeric PK)' })
  id: number;

  @ApiProperty({ description: 'Stable per-program graph node id' })
  nodeId: string;

  @ApiPropertyOptional({
    description: 'CLARISA-side stable id from ost_wp.toc_id',
  })
  clarisaTocId: string | null;

  @ApiPropertyOptional({ description: 'Short code (e.g. "AOW03")' })
  acronym: string | null;

  @ApiPropertyOptional({
    description: 'Full official code (e.g. "SP01-AOW03")',
  })
  wpOfficialCode: string | null;

  @ApiPropertyOptional({ description: 'Display name' })
  name: string | null;

  @ApiProperty({ description: 'Program FK' })
  programId: number;

  @ApiProperty({
    type: TocProgramRefDto,
    description: 'Embedded program reference',
  })
  program: TocProgramRefDto;

  @ApiProperty({ description: 'Last successful sync timestamp', type: String })
  syncedAt: Date;
}

/**
 * Response row for `GET /admin/toc/outcomes`.
 *
 * Carries the {@link TocOutcomeType} discriminator so the UI can
 * keep intermediate vs. portfolio outcomes visually distinct
 * without a follow-up call.
 */
export class TocOutcomeListItemDto {
  @ApiProperty({ description: 'Outcome id (numeric PK)' })
  id: number;

  @ApiProperty({ description: 'Stable per-program graph node id' })
  nodeId: string;

  @ApiPropertyOptional({ description: 'Outcome title' })
  title: string | null;

  @ApiPropertyOptional({ description: 'Long-form description' })
  description: string | null;

  @ApiProperty({
    enum: TocOutcomeType,
    description: 'intermediate (OUTCOME) or portfolio (EOI)',
  })
  outcomeType: TocOutcomeType;

  @ApiPropertyOptional({ description: 'Cross-link to feeding node' })
  relatedNodeId: string | null;

  @ApiPropertyOptional({ description: 'Parent AOW FK (nullable)' })
  aowId: number | null;

  @ApiPropertyOptional({
    type: TocAowRefDto,
    description: 'Embedded parent AOW reference (null when aowId is null)',
  })
  aow: TocAowRefDto | null;

  @ApiProperty({ description: 'Program FK' })
  programId: number;

  @ApiProperty({
    type: TocProgramRefDto,
    description: 'Embedded program reference',
  })
  program: TocProgramRefDto;

  @ApiProperty({ description: 'Last successful sync timestamp', type: String })
  syncedAt: Date;
}

/**
 * Response row for `GET /admin/toc/outputs`.
 *
 * Shape-parallel to {@link TocOutcomeListItemDto} but with
 * `typeOfOutput` instead of `outcomeType` (different column,
 * different semantics — kept as separate DTOs for clarity).
 */
export class TocOutputListItemDto {
  @ApiProperty({ description: 'Output id (numeric PK)' })
  id: number;

  @ApiProperty({ description: 'Stable per-program graph node id' })
  nodeId: string;

  @ApiPropertyOptional({ description: 'Output title' })
  title: string | null;

  @ApiPropertyOptional({ description: 'Long-form description' })
  description: string | null;

  @ApiPropertyOptional({
    description: 'OUTPUT categorization (e.g. "Knowledge product")',
  })
  typeOfOutput: string | null;

  @ApiPropertyOptional({ description: 'Cross-link to feeding node' })
  relatedNodeId: string | null;

  @ApiPropertyOptional({ description: 'Parent AOW FK (nullable)' })
  aowId: number | null;

  @ApiPropertyOptional({
    type: TocAowRefDto,
    description: 'Embedded parent AOW reference (null when aowId is null)',
  })
  aow: TocAowRefDto | null;

  @ApiProperty({ description: 'Program FK' })
  programId: number;

  @ApiProperty({
    type: TocProgramRefDto,
    description: 'Embedded program reference',
  })
  program: TocProgramRefDto;

  @ApiProperty({ description: 'Last successful sync timestamp', type: String })
  syncedAt: Date;
}

/**
 * Generic `{ data, total, page, limit }` envelope for the three TOC
 * list endpoints.
 *
 * Parameterised on the row type so each endpoint preserves its
 * narrow response shape in OpenAPI / TS consumers. Used as the
 * service return type and the controller's typed response.
 */
export class TocListResponseDto<T> {
  @ApiProperty({ description: 'Page of rows', isArray: true })
  data: T[];

  @ApiProperty({ description: 'Total rows matching the filter' })
  total: number;

  @ApiProperty({ description: 'Current page (1-based)' })
  page: number;

  @ApiProperty({ description: 'Page size used for this response' })
  limit: number;
}
