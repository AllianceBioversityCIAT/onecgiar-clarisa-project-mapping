import { PartialType } from '@nestjs/swagger';
import { CreateProjectDto } from './create-project.dto';

/**
 * DTO for updating an existing project.
 *
 * All fields from {@link CreateProjectDto} are optional, allowing
 * partial updates via PATCH requests.
 */
export class UpdateProjectDto extends PartialType(CreateProjectDto) {}
