import { Global, Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TocService } from './toc.service';

/**
 * Global module that exposes the TOC (Theory of Change) HTTP client.
 *
 * Mirrors the CLARISA module pattern — registers {@link TocService}
 * as a global provider backed by `@nestjs/axios` so any module can
 * inject it without explicitly importing this module.
 */
@Global()
@Module({
  imports: [
    HttpModule.register({
      timeout: 30_000,
      maxRedirects: 3,
    }),
  ],
  providers: [TocService],
  exports: [TocService],
})
export class TocModule {}
