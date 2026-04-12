import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiService } from '../../../core/services/api.service';
import { SnapshotListItem, CreateSnapshotRequest } from './snapshots.model';

/**
 * SnapshotsService — handles all HTTP interactions for the published snapshots
 * admin page. Delegates to ApiService for transport so the base URL and
 * withCredentials option are applied automatically.
 */
@Injectable({ providedIn: 'root' })
export class SnapshotsService {
  private readonly api = inject(ApiService);

  /**
   * Fetches the full list of published snapshots, ordered by publishedAt
   * descending on the backend.
   */
  listSnapshots(): Observable<SnapshotListItem[]> {
    return this.api.get<SnapshotListItem[]>('/api/published/snapshots');
  }

  /**
   * Creates a new published snapshot from the current live project data.
   * Returns the newly created snapshot item so the caller can prepend it
   * to the local list without a full re-fetch.
   */
  createSnapshot(dto: CreateSnapshotRequest): Observable<SnapshotListItem> {
    return this.api.post<SnapshotListItem>('/api/published/snapshots', dto);
  }
}
