import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '../../../core/services/api.service';
import { UserWithRelations, UpdateUserDto } from '../models/user-management.model';

/**
 * UsersService — admin-only service for listing and updating system users.
 *
 * All endpoints are enforced server-side to require the 'admin' role.
 * The route-level roleGuard in app.routes.ts provides an additional
 * client-side guard.
 */
@Injectable({ providedIn: 'root' })
export class UsersService {
  private readonly api = inject(ApiService);

  /**
   * Returns the full list of system users with their program and center
   * relations eagerly loaded. Admin only.
   */
  getUsers(): Observable<UserWithRelations[]> {
    return this.api.get<UserWithRelations[]>('/api/users');
  }

  /**
   * Partially updates a user's role, linked program/center, or active status.
   * Admin only. Returns the updated user record.
   */
  updateUser(id: number, data: UpdateUserDto): Observable<UserWithRelations> {
    return this.api.patch<UserWithRelations>(`/api/users/${id}`, data);
  }
}
