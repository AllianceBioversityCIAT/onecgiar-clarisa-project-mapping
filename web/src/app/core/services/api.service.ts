import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * ApiService — thin wrapper around Angular's HttpClient.
 *
 * All path arguments are relative (e.g. '/auth/login'). The service
 * automatically prepends the configured API base URL so callers never
 * deal with absolute URLs directly.
 *
 * Credentials are included on every request so the browser forwards the
 * httpOnly refresh cookie that the API sets on login.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  /** Base URL loaded from the environment file (e.g. http://localhost:3000). */
  private readonly baseUrl = environment.apiUrl;

  /**
   * Builds an absolute URL by joining baseUrl with the given path.
   * Ensures there is exactly one slash between segments.
   */
  private url(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? path : '/' + path}`;
  }

  /** Performs a GET request and returns an observable of the typed response. */
  get<T>(path: string): Observable<T> {
    return this.http.get<T>(this.url(path), { withCredentials: true });
  }

  /** Performs a POST request with a JSON body and returns an observable of the typed response. */
  post<T>(path: string, body: unknown = {}): Observable<T> {
    return this.http.post<T>(this.url(path), body, { withCredentials: true });
  }

  /** Performs a PATCH request with a JSON body and returns an observable of the typed response. */
  patch<T>(path: string, body: unknown = {}): Observable<T> {
    return this.http.patch<T>(this.url(path), body, { withCredentials: true });
  }

  /** Performs a DELETE request and returns an observable of the typed response. */
  delete<T>(path: string): Observable<T> {
    return this.http.delete<T>(this.url(path), { withCredentials: true });
  }
}
