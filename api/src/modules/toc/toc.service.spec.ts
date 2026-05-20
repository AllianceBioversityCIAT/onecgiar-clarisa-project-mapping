/**
 * Unit tests for TocService.
 *
 * All HTTP calls are mocked via jest — no real network traffic.
 * Tests pin:
 *  - correct URL construction from config + official code
 *  - successful response passthrough
 *  - 404 → null (non-throwing)
 *  - 5xx / network errors → ServiceUnavailableException
 *  - Logger.error is called on failures
 */
import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException, Logger } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { AxiosResponse } from 'axios';

import { TocService } from './toc.service';
import { TocApiResponse } from './interfaces';

/* ───────────────────────── Helpers ───────────────────────── */

/** Minimal fixture that satisfies TocApiResponse. */
const FIXTURE_RESPONSE: TocApiResponse = {
  data: [
    {
      id: 'NODE-1',
      category: 'WP',
      wp_type: 'AOW',
      title: 'AOW 1',
      ost_wp: { name: 'Area of Work 1', acronym: 'AOW1' },
    },
    {
      id: 'NODE-2',
      category: 'OUTPUT',
      title: 'Output 1',
      group: 'NODE-1',
    },
  ],
};

/**
 * Wraps a value in a minimal Axios-compatible observable so the
 * `firstValueFrom(this.httpService.get(...))` call inside TocService
 * receives the right shape.
 */
function axiosOf(body: TocApiResponse): ReturnType<HttpService['get']> {
  const response: AxiosResponse<TocApiResponse> = {
    data: body,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: {} } as any,
  };
  return of(response) as any;
}

/**
 * Builds an Axios error with an optional HTTP response status so we
 * can simulate 404 / 500 responses from the remote server.
 */
function axiosError(status?: number, message = 'Request failed'): Error {
  const err: any = new Error(message);
  err.isAxiosError = true;
  if (status !== undefined) {
    err.response = { status, data: {} };
  }
  return err;
}

/* ───────────────────────── Suite ───────────────────────── */

describe('TocService', () => {
  let service: TocService;
  let httpService: { get: jest.Mock };

  const BASE_URL = 'https://toc.test.example.com';

  beforeEach(async () => {
    httpService = { get: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TocService,
        { provide: HttpService, useValue: httpService },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'toc.url') return BASE_URL;
              return undefined;
            },
          },
        },
      ],
    }).compile();

    service = module.get(TocService);

    /* Silence logger output during tests — we spy on it selectively. */
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  /* ── URL construction ──────────────────────────────────── */

  it('builds the correct URL from base URL + official code', async () => {
    httpService.get.mockReturnValue(axiosOf(FIXTURE_RESPONSE));

    await service.fetchProgram('SP01');

    expect(httpService.get).toHaveBeenCalledWith(`${BASE_URL}/api/toc/SP01`);
  });

  it('URL-encodes the official code', async () => {
    httpService.get.mockReturnValue(axiosOf(FIXTURE_RESPONSE));

    await service.fetchProgram('SP 01/special');

    expect(httpService.get).toHaveBeenCalledWith(
      `${BASE_URL}/api/toc/SP%2001%2Fspecial`,
    );
  });

  it('strips a trailing slash from the configured base URL', async () => {
    /* Re-instantiate with a base URL that has a trailing slash. */
    const moduleWithSlash: TestingModule = await Test.createTestingModule({
      providers: [
        TocService,
        { provide: HttpService, useValue: httpService },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'toc.url' ? `${BASE_URL}/` : undefined,
          },
        },
      ],
    }).compile();

    const svcWithSlash = moduleWithSlash.get(TocService);
    httpService.get.mockReturnValue(axiosOf(FIXTURE_RESPONSE));

    await svcWithSlash.fetchProgram('SP01');

    /* Should NOT produce double-slash. */
    expect(httpService.get).toHaveBeenCalledWith(`${BASE_URL}/api/toc/SP01`);
  });

  /* ── Success path ──────────────────────────────────────── */

  it('returns the parsed response body on a 200 response', async () => {
    httpService.get.mockReturnValue(axiosOf(FIXTURE_RESPONSE));

    const result = await service.fetchProgram('SP01');

    expect(result).toStrictEqual(FIXTURE_RESPONSE);
  });

  /* ── 404 path ──────────────────────────────────────────── */

  it('returns null on 404 without throwing', async () => {
    httpService.get.mockReturnValue(
      throwError(() => axiosError(404, 'Not Found')),
    );

    const result = await service.fetchProgram('MISSING');

    expect(result).toBeNull();
  });

  it('does NOT call Logger.error on 404', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error');
    httpService.get.mockReturnValue(
      throwError(() => axiosError(404, 'Not Found')),
    );

    await service.fetchProgram('MISSING');

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('calls Logger.warn on 404', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');
    httpService.get.mockReturnValue(
      throwError(() => axiosError(404, 'Not Found')),
    );

    await service.fetchProgram('MISSING');

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MISSING'));
  });

  /* ── 5xx / server error path ───────────────────────────── */

  it('throws ServiceUnavailableException on a 500 response', async () => {
    httpService.get.mockReturnValue(
      throwError(() => axiosError(500, 'Internal Server Error')),
    );

    await expect(service.fetchProgram('SP01')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('throws ServiceUnavailableException on a 502 response', async () => {
    httpService.get.mockReturnValue(
      throwError(() => axiosError(502, 'Bad Gateway')),
    );

    await expect(service.fetchProgram('SP01')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  /* ── Network error (no response) path ─────────────────── */

  it('throws ServiceUnavailableException on a network-level error (no response)', async () => {
    /* Simulate a connection refused / timeout — no `response` property. */
    httpService.get.mockReturnValue(
      throwError(() => axiosError(undefined, 'connect ECONNREFUSED')),
    );

    await expect(service.fetchProgram('SP01')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('calls Logger.error on any non-404 failure', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error');
    httpService.get.mockReturnValue(
      throwError(() => axiosError(500, 'Internal Server Error')),
    );

    await expect(service.fetchProgram('SP01')).rejects.toThrow(
      ServiceUnavailableException,
    );

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('SP01'),
      expect.anything(),
    );
  });

  it('calls Logger.error on network error (no response)', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error');
    httpService.get.mockReturnValue(
      throwError(() => axiosError(undefined, 'ETIMEDOUT')),
    );

    await expect(service.fetchProgram('SP01')).rejects.toThrow(
      ServiceUnavailableException,
    );

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('SP01'),
      expect.anything(),
    );
  });

  /* ── Fallback base URL ────────────────────────────────── */

  it('defaults to https://toc.mel.cgiar.org when config key is absent', async () => {
    const moduleDefault: TestingModule = await Test.createTestingModule({
      providers: [
        TocService,
        { provide: HttpService, useValue: httpService },
        {
          provide: ConfigService,
          useValue: { get: () => undefined },
        },
      ],
    }).compile();

    const svcDefault = moduleDefault.get(TocService);
    httpService.get.mockReturnValue(axiosOf(FIXTURE_RESPONSE));

    await svcDefault.fetchProgram('SP01');

    expect(httpService.get).toHaveBeenCalledWith(
      'https://toc.mel.cgiar.org/api/toc/SP01',
    );
  });
});
