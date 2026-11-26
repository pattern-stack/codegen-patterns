
import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '@shared/openapi';
import { DatabaseModule } from '@shared/database/database.module';

import { ToteRepository } from './tote.repository';
import { ToteService } from './tote.service';
import { ToteController } from './tote.controller';
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
import { CreateToteSchema } from './dto/create-tote.dto';
import { UpdateToteSchema } from './dto/update-tote.dto';
import { ToteOutputSchema } from './dto/tote-output.dto';
import { FindToteByIdUseCase } from './use-cases/find-tote-by-id.use-case';
import { ListTotesUseCase } from './use-cases/list-totes.use-case';
import { CreateToteUseCase } from './use-cases/create-tote.use-case';
import { UpdateToteUseCase } from './use-cases/update-tote.use-case';
import { DeleteToteUseCase } from './use-cases/delete-tote.use-case';

@Module({
  imports: [
    DatabaseModule,
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
  ],
  controllers: [ToteController],
  providers: [
    ToteRepository,
    ToteService,
    FindToteByIdUseCase,
    ListTotesUseCase,
    CreateToteUseCase,
    UpdateToteUseCase,
    DeleteToteUseCase,
  ],
  // ADR-002 (revised): the service is the public API; the repository is ALSO
  // exported so sibling modules that compose this entity cross-module (junction
  // `.list()`, EAV value→definition resolution) inject the home-module instance
  // — the only place the repo's own deps are wired (e.g. an EAV entity's repo
  // injects FieldValueService for the #374 integration dual-write tx). Local-providing
  // such a repo elsewhere can't satisfy those deps. Use-case internals stay unexported.
  exports: [ToteService, ToteRepository],
})
export class TotesModule implements OnModuleInit {
  // OPENAPI-2: register this entity's Zod schemas with the shared
  // OpenApiRegistry at module init. OPENAPI-4 awaits `build()` at boot
  // to emit the full /docs-json document.
  constructor(
    @Inject(OPENAPI_REGISTRY) private readonly openApi: OpenApiRegistry,
  ) {}

  onModuleInit(): void {
    this.openApi.registerSchema('CreateToteDto', CreateToteSchema);
    this.openApi.registerSchema('UpdateToteDto', UpdateToteSchema);
    // The response schema is named <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but the generated code publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    this.openApi.registerSchema('ToteOutputDto', ToteOutputSchema);
  }
}
