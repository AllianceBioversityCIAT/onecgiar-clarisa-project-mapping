import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Caller-facing options for {@link NotificationsService.send}.
 *
 * Mirrors the documented Notification Microservice payload but excludes
 * fields the service fills in automatically (auth credentials, default
 * sender, Buffer-wrapping of the HTML body).
 *
 * Either `text` or `html` must be provided — the microservice tolerates
 * messages with only a plain-text fallback, but we still require *some*
 * body content so we never publish an empty email.
 */
export class SendEmailOptions {
  /** List of primary recipient email addresses. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsEmail({}, { each: true })
  to!: string[];

  /** Optional CC recipients. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsEmail({}, { each: true })
  cc?: string[];

  /** Optional BCC recipients. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsEmail({}, { each: true })
  bcc?: string[];

  /** Email subject line (1..255 chars). */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  subject!: string;

  /** Optional plain-text fallback body. */
  @IsOptional()
  @IsString()
  text?: string;

  /**
   * Optional HTML body. The service wraps this in a Node Buffer
   * and assigns it to `data.emailBody.message.socketFile` before
   * publishing. The downstream consumer reads the wire-form
   * `{ type: 'Buffer', data: [...bytes] }` directly.
   */
  @IsOptional()
  @IsString()
  html?: string;

  /** Override the default sender for a single message (rare). */
  @IsOptional()
  from?: { email: string; name?: string };
}

/**
 * Wire-format payload published onto the `send` routing key.
 *
 * Exactly mirrors the schema in the Notification Microservice docs:
 *   { auth: { username, password }, data: { from?, emailBody: { … } } }
 *
 * Kept as plain interfaces (not class-validator classes) because the
 * payload is built internally and goes straight onto the wire — the
 * inbound surface is validated via {@link SendEmailOptions} above.
 */
export interface SendEmailPayload {
  auth: { username: string; password: string };
  data: {
    from?: { email: string; name?: string };
    emailBody: {
      subject: string;
      /**
       * Comma-separated recipient string(s). The Notification Microservice
       * calls `.split(',')` on these fields, so they MUST be strings — passing
       * arrays throws `TypeError: emails.split is not a function` there.
       */
      to: string;
      cc: string;
      bcc: string;
      message: {
        text?: string;
        /**
         * HTML body, sent as a raw Node Buffer. NestJS's RMQ transport
         * JSON-stringifies it on the wire as `{ type: 'Buffer', data:
         * [...bytes] }` — the Notification Microservice (CLARISA's
         * reference implementation) ingests that shape directly. Do
         * NOT base64-encode this field: the consumer expects the
         * Buffer wire-form, not a string.
         */
        socketFile?: Buffer;
      };
    };
  };
}
