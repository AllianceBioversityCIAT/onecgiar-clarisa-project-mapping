import { IsString, Length, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateSnapshotDto {
  @ApiProperty({
    description: 'Human-readable version label',
    example: 'April 2026 Release',
  })
  @IsString()
  @Length(1, 100)
  versionLabel: string;

  @ApiPropertyOptional({ description: 'Optional notes about this snapshot' })
  @IsOptional()
  @IsString()
  description?: string;
}
