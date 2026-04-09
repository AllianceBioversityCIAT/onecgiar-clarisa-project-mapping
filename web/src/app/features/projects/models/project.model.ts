/**
 * Core project entity as returned by the API.
 */
export interface Project {
  id: string;
  code: string;
  name: string;
  description: string;
  summary: string;
  results: string;
  startDate: string;
  endDate: string;
  totalBudget: number;
  remainingBudget: number;
  fundingSource: 'window3' | 'bilateral' | 'srv' | 'other';
  funder: string;
  status: 'draft' | 'active' | 'archived';
  center: { id: string; name: string; acronym: string };
  countries: { id: string; name: string; isoAlpha2: string }[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Paginated response envelope for the project list endpoint.
 */
export interface ProjectListResponse {
  data: Project[];
  total: number;
  page: number;
  limit: number;
}

/**
 * DTO for creating or updating a project.
 * remainingBudget and optional text fields may be omitted.
 */
export interface CreateProjectDto {
  code: string;
  name: string;
  description?: string;
  summary?: string;
  results?: string;
  startDate: string;
  endDate: string;
  totalBudget: number;
  remainingBudget?: number;
  fundingSource: string;
  funder?: string;
  centerId: string;
  countryIds: string[];
}

/**
 * Query parameters accepted by GET /api/projects.
 */
export interface ProjectQuery {
  search?: string;
  centerId?: string;
  status?: string;
  fundingSource?: string;
  page?: number;
  limit?: number;
}
