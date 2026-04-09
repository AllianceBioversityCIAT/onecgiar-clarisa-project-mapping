import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import {
  ClarisaCenter,
  ClarisaInitiative,
  ClarisaCountry,
  ClarisaActionArea,
} from './interfaces';

/**
 * HTTP client for the CLARISA external API.
 *
 * Wraps each CLARISA endpoint with typed methods that handle
 * Basic-auth headers, Observable-to-Promise conversion, and
 * error logging. If CLARISA is unreachable the service throws
 * a {@link ServiceUnavailableException} so callers get a clear 503.
 */
@Injectable()
export class ClarisaService {
  private readonly logger = new Logger(ClarisaService.name);

  /** Base URL for all CLARISA API calls. */
  private readonly baseUrl: string;

  /** Pre-built Authorization header value (Basic auth). */
  private readonly authHeader: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.baseUrl = this.configService.get<string>('clarisa.url', '');
    const username = this.configService.get<string>('clarisa.username');
    const password = this.configService.get<string>('clarisa.password');
    this.authHeader =
      'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  }

  /** Fetch all CGIAR centers from CLARISA. */
  async getCenters(): Promise<ClarisaCenter[]> {
    return this.get<ClarisaCenter[]>('/api/centers');
  }

  /** Fetch all initiatives (programs) from CLARISA. */
  async getPrograms(): Promise<ClarisaInitiative[]> {
    return this.get<ClarisaInitiative[]>('/api/initiatives');
  }

  /** Fetch all countries from CLARISA. */
  async getCountries(): Promise<ClarisaCountry[]> {
    return this.get<ClarisaCountry[]>('/api/countries');
  }

  /** Fetch all action areas from CLARISA. */
  async getActionAreas(): Promise<ClarisaActionArea[]> {
    return this.get<ClarisaActionArea[]>('/api/action-areas');
  }

  /**
   * Generic GET helper that adds auth headers, converts the RxJS
   * Observable to a Promise, and wraps errors in a 503 response.
   */
  private async get<T>(path: string): Promise<T> {
    try {
      const { data } = await firstValueFrom(
        this.httpService.get<T>(`${this.baseUrl}${path}`, {
          headers: { Authorization: this.authHeader },
        }),
      );
      return data;
    } catch (error) {
      this.logger.error(
        `Failed to fetch from CLARISA ${path}: ${error.message}`,
        error.stack,
      );
      throw new ServiceUnavailableException(
        `CLARISA API is unavailable (${path})`,
      );
    }
  }
}
