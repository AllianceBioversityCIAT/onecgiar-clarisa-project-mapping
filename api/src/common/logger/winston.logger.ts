import { LoggerService } from '@nestjs/common';
import * as winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import * as path from 'path';

/**
 * Custom NestJS LoggerService implementation that wraps Winston.
 *
 * Reads LOG_LEVEL and LOG_FORMAT from process.env to configure behavior:
 * - Dev format (LOG_FORMAT !== 'json'): colorized, pretty-printed output.
 * - Prod format (LOG_FORMAT === 'json'): structured JSON for log aggregation.
 *
 * File transports use daily rotation (retained 30 days, max 20 MB per file):
 * - combined-*.log  — all log levels
 * - error-*.log     — error level only
 * - http-*.log      — http level only
 */
export class WinstonLogger implements LoggerService {
  private readonly logger: winston.Logger;

  constructor() {
    const logLevel = process.env.LOG_LEVEL || 'info';
    const logFormat = process.env.LOG_FORMAT || 'pretty';
    const logsDir = path.join(process.cwd(), 'logs');

    /** Shared timestamp format for all transports. */
    const timestampFormat = winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss',
    });

    /** Pretty-print format for development console output. */
    const devFormat = winston.format.combine(
      timestampFormat,
      winston.format.colorize({ all: true }),
      winston.format.printf(
        ({ timestamp, level, message, context, ...meta }) => {
          const ctx = context ? `[${context}]` : '';
          const metaStr = Object.keys(meta).length
            ? ` ${JSON.stringify(meta)}`
            : '';
          return `${timestamp} ${level} ${ctx} ${message}${metaStr}`;
        },
      ),
    );

    /** JSON format for production log aggregation. */
    const prodFormat = winston.format.combine(
      timestampFormat,
      winston.format.json(),
    );

    const isJsonFormat = logFormat === 'json';

    /** Daily-rotate transport factory to reduce repetition. */
    const createRotateTransport = (
      filename: string,
      level?: string,
    ): DailyRotateFile =>
      new DailyRotateFile({
        dirname: logsDir,
        filename: `${filename}-%DATE%.log`,
        datePattern: 'YYYY-MM-DD',
        maxSize: '20m',
        maxFiles: '30d',
        level,
        format: winston.format.combine(timestampFormat, winston.format.json()),
      });

    this.logger = winston.createLogger({
      level: logLevel,
      transports: [
        /** Console transport — always enabled. */
        new winston.transports.Console({
          format: isJsonFormat ? prodFormat : devFormat,
        }),

        /** Combined log — all levels. */
        createRotateTransport('combined'),

        /** Error-only log. */
        createRotateTransport('error', 'error'),

        /** HTTP-level log. */
        createRotateTransport('http', 'http'),
      ],
    });
  }

  /**
   * Log at the default (info) level.
   * @param message - The log message.
   * @param optionalParams - Additional context parameters.
   */
  log(message: string, ...optionalParams: unknown[]): void {
    this.logger.info(message, { context: optionalParams[0] });
  }

  /**
   * Log at the error level.
   * @param message - The error message.
   * @param optionalParams - Stack trace or additional context.
   */
  error(message: string, ...optionalParams: unknown[]): void {
    const trace = optionalParams[0];
    const context = optionalParams[1];
    this.logger.error(message, { trace, context });
  }

  /**
   * Log at the warn level.
   * @param message - The warning message.
   * @param optionalParams - Additional context parameters.
   */
  warn(message: string, ...optionalParams: unknown[]): void {
    this.logger.warn(message, { context: optionalParams[0] });
  }

  /**
   * Log at the debug level.
   * @param message - The debug message.
   * @param optionalParams - Additional context parameters.
   */
  debug(message: string, ...optionalParams: unknown[]): void {
    this.logger.debug(message, { context: optionalParams[0] });
  }

  /**
   * Log at the verbose level.
   * @param message - The verbose message.
   * @param optionalParams - Additional context parameters.
   */
  verbose(message: string, ...optionalParams: unknown[]): void {
    this.logger.verbose(message, { context: optionalParams[0] });
  }

  /**
   * Log an HTTP-level entry (used by the HTTP logging interceptor).
   * @param message - The HTTP log message.
   * @param meta - Metadata such as method, path, status, duration.
   */
  http(message: string, meta?: Record<string, unknown>): void {
    this.logger.log('http', message, meta);
  }
}
