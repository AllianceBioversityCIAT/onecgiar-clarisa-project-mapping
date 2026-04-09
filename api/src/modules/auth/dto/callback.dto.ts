import { IsString, IsNotEmpty } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO for the Cognito OAuth2 callback endpoint.
 *
 * Contains the authorization code returned by Cognito after the user
 * successfully authenticates. This code is exchanged for tokens via
 * the token endpoint.
 */
export class CallbackDto {
  /** The authorization code from the Cognito redirect. */
  @ApiProperty({
    description: 'Authorization code returned by Cognito after user login',
    example: 'abc123-auth-code',
  })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @IsNotEmpty()
  code: string;
}
