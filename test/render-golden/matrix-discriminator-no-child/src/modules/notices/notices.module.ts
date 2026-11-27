
import { Inject, Module } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '@shared/openapi';
import { DatabaseModule } from '@shared/database/database.module';

import { NoticeRepository } from './notice.repository';
import { NoticeService } from './notice.service';
import { NoticeController } from './notice.controller';
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
import { CreateNoticeSchema } from './dto/create-notice.dto';
import { UpdateNoticeSchema } from './dto/update-notice.dto';
import { NoticeOutputSchema } from './dto/notice-output.dto';
import { FindNoticeByIdUseCase } from './use-cases/find-notice-by-id.use-case';
import { ListNoticesUseCase } from './use-cases/list-notices.use-case';
import { CreateNoticeUseCase } from './use-cases/create-notice.use-case';
import { UpdateNoticeUseCase } from './use-cases/update-notice.use-case';
import { DeleteNoticeUseCase } from './use-cases/delete-notice.use-case';

@Module({
  imports: [
    DatabaseModule,
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
  ],
  controllers: [NoticeController],
  providers: [
    NoticeRepository,
    NoticeService,
    FindNoticeByIdUseCase,
    ListNoticesUseCase,
    CreateNoticeUseCase,
    UpdateNoticeUseCase,
    DeleteNoticeUseCase,
  ],
  // ADR-002 (revised): the service is the public API; the repository is ALSO
  // exported so sibling modules that compose this entity cross-module (junction
  // `.list()`, EAV value→definition resolution) inject the home-module instance
  // — the only place the repo's own deps are wired (e.g. an EAV entity's repo
  // injects FieldValueService for the #374 integration dual-write tx). Local-providing
  // such a repo elsewhere can't satisfy those deps. Use-case internals stay unexported.
  exports: [NoticeService, NoticeRepository],
})
export class NoticesModule {
  // OPENAPI-2: register this entity's Zod schemas when Nest constructs the
  // module (in `NestFactory.create`), so they are in the registry before
  // main.ts builds /docs-json. A lifecycle hook (`onModuleInit`) runs too late.
  constructor(@Inject(OPENAPI_REGISTRY) openApi: OpenApiRegistry) {
    openApi.registerSchema('CreateNoticeDto', CreateNoticeSchema);
    openApi.registerSchema('UpdateNoticeDto', UpdateNoticeSchema);
    // The response schema is named <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but the generated code publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    openApi.registerSchema('NoticeOutputDto', NoticeOutputSchema);
  }
}
