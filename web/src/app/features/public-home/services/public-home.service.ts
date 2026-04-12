import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '../../../core/services/api.service';
import {
  SnapshotSummary,
  PaginatedPublishedProjects,
  PublishedProjectsParams,
  PublishedProjectItem,
} from '../models/public-home.model';

/**
 * PublicHomeService — fetches publicly accessible snapshot and project data.
 *
 * Both endpoints are unauthenticated; the ApiService still includes
 * withCredentials so any existing session cookie is forwarded, but it is
 * not required by the server for these routes.
 */
@Injectable({ providedIn: 'root' })
export class PublicHomeService {
  private readonly api = inject(ApiService);

  /**
   * Returns the latest active published snapshot summary, or null when no
   * snapshot has been published yet. The snapshot includes aggregate stats
   * (project count, total budget, breakdown by center and program).
   */
  getLatestSnapshot(): Observable<SnapshotSummary | null> {
    return this.api.get<SnapshotSummary | null>('/published/latest');
  }

  /**
   * Returns a paginated list of published project items for the latest
   * snapshot. Supports server-side search by name/code and filtering by
   * center acronym.
   *
   * Query params are appended directly to the path string because ApiService
   * exposes a plain `get(path)` without a separate params argument.
   */
  getPublishedProjects(
    params: PublishedProjectsParams = {},
  ): Observable<PaginatedPublishedProjects> {
    const { page = 1, limit = 20, search = '', center = '' } = params;

    // Build query string — omit empty values to keep URLs clean
    const parts: string[] = [`page=${page}`, `limit=${limit}`];
    if (search) parts.push(`search=${encodeURIComponent(search)}`);
    if (center) parts.push(`center=${encodeURIComponent(center)}`);

    const qs = parts.join('&');
    return this.api.get<PaginatedPublishedProjects>(`/published/latest/projects?${qs}`);
  }

  /**
   * Returns a single published project by ID from the active snapshot.
   */
  getPublishedProject(id: number): Observable<PublishedProjectItem> {
    return this.api.get<PublishedProjectItem>(`/published/latest/projects/${id}`);
  }
}
