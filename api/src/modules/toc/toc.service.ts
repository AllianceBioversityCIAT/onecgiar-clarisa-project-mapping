import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { TocApiResponse } from './interfaces';

/**
 * HTTP client for the TOC (Theory of Change) external API.
 *
 * Wraps the single `GET /api/toc/{idOrCode}` endpoint with a
 * typed method that handles Observable-to-Promise conversion and
 * differentiates between two error modes:
 *
 *  - **404 not found** — return `null`. Some CGIAR programs do not
 *    have a TOC graph published yet, and the caller should count
 *    these as "missing" rather than abort the whole sync.
 *  - **Any other network / 5xx error** — throw
 *    {@link ServiceUnavailableException} so the admin-triggered
 *    sync surfaces a clean 503.
 *
 * The path segment accepts either an official code (e.g. "SP01") or
 * a MEL TOC graph UUID (the `original_id` field from a prior response).
 * The published-snapshot payload returned by the official-code form
 * is intentionally frozen at the last publish event; the working-draft
 * payload returned by the UUID form is what the sync service prefers
 * based on whether `programs.original_id` is populated.
 */
@Injectable()
export class TocService {
  private readonly logger = new Logger(TocService.name);

  /** Base URL for all TOC API calls (no trailing slash). */
  private readonly baseUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.baseUrl = (
      this.configService.get<string>('toc.url') ?? 'https://toc.mel.cgiar.org'
    ).replace(/\/$/, '');
  }

  /**
   * Fetch a single program's TOC graph by either its official code
   * (e.g. "SP01") or its MEL TOC graph UUID (the `original_id`
   * loaded into `programs.original_id`). Both forms are
   * URL-encoded and inserted into the path verbatim — the upstream
   * MEL TOC API resolves either against the same endpoint.
   *
   * Returns `null` on 404 so the caller can treat missing programs as
   * a recoverable case. Any other failure throws
   * {@link ServiceUnavailableException}.
   */
  async fetchProgram(idOrCode: string): Promise<TocApiResponse | null> {
    const path = `/api/toc/${encodeURIComponent(idOrCode)}`;
    try {
      const { data } = await firstValueFrom(
        this.httpService.get<TocApiResponse>(`${this.baseUrl}${path}`),
      );
      return data;
    } catch (error) {
      const axiosError = error as AxiosError;
      /* 404 is an expected outcome for programs that lack a published
       * TOC graph. Log a warning and return null so the sync can move
       * on without marking the whole run as failed. */
      if (axiosError?.response?.status === 404) {
        this.logger.warn(`TOC graph not found for ${idOrCode} (404)`);
        return null;
      }
      this.logger.error(
        `Failed to fetch TOC graph for ${idOrCode}: ${axiosError.message}`,
        axiosError.stack,
      );
      throw new ServiceUnavailableException(`TOC API is unavailable (${path})`);
    }
  }
}
