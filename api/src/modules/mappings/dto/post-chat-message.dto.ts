import {
  IsString,
  IsNotEmpty,
  MinLength,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO for posting a free-text chat message on a project's consolidated
 * negotiation thread.
 *
 * The message is trimmed before validation so that whitespace-only
 * payloads are rejected by the `@IsNotEmpty` / `@MinLength(1)` checks.
 */
export class PostChatMessageDto {
  /** Free-text chat content (1–2000 chars, trimmed). */
  @ApiProperty({
    example: 'Let us align on the 40/60 split before the Friday review.',
    description: 'Chat message body (1–2000 chars, trimmed)',
    minLength: 1,
    maxLength: 2000,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(2000)
  message: string;
}
