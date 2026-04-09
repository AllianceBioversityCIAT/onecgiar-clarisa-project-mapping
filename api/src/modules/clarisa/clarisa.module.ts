import { Global, Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ClarisaService } from './clarisa.service';

/**
 * Global module that exposes the CLARISA HTTP client.
 *
 * Imports {@link HttpModule} from `@nestjs/axios` and registers
 * {@link ClarisaService} as a global provider so any module can
 * inject it without adding an explicit import.
 */
@Global()
@Module({
  imports: [
    HttpModule.register({
      timeout: 30_000,
      maxRedirects: 3,
    }),
  ],
  providers: [ClarisaService],
  exports: [ClarisaService],
})
export class ClarisaModule {}
