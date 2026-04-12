import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '../../../core/services/api.service';
import { UserWithRelations, UpdateUserDto, CreateUserDto } from '../models/user-management.model';

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

  /**
   * Pre-provisions a new user by email. The user record is created with
   * cognito_sub = NULL; on first Cognito login the sub will be backfilled.
   * Admin only. Returns the newly created user with relations.
   */
  createUser(dto: CreateUserDto): Observable<UserWithRelations> {
    return this.api.post<UserWithRelations>('/api/users', dto);
  }

  /**
   * Soft-deletes a user by setting isActive = false.
   * Preserves all foreign-key references (created_by, submitted_by, etc.).
   * Admin only. Cannot be called on the currently authenticated user.
   */
  deleteUser(id: number): Observable<void> {
    return this.api.delete<void>(`/api/users/${id}`);
  }
}
