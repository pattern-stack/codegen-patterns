
import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '@shared/openapi';
import { DatabaseModule } from '@shared/database/database.module';

import { ShelfRepository } from './shelf.repository';
import { ShelfService } from './shelf.service';
import { ShelfController } from './shelf.controller';
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
import { CreateShelfSchema } from './dto/create-shelf.dto';
import { UpdateShelfSchema } from './dto/update-shelf.dto';
import { ShelfOutputSchema } from './dto/shelf-output.dto';
import { FindShelfByIdUseCase } from './use-cases/find-shelf-by-id.use-case';
import { ListShelvesUseCase } from './use-cases/list-shelves.use-case';
import { CreateShelfUseCase } from './use-cases/create-shelf.use-case';
import { UpdateShelfUseCase } from './use-cases/update-shelf.use-case';
import { DeleteShelfUseCase } from './use-cases/delete-shelf.use-case';

@Module({
  imports: [
    DatabaseModule,
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
  ],
  controllers: [ShelfController],
  providers: [
    ShelfRepository,
    ShelfService,
    FindShelfByIdUseCase,
    ListShelvesUseCase,
    CreateShelfUseCase,
    UpdateShelfUseCase,
    DeleteShelfUseCase,
  ],
  // ADR-002 (revised): the service is the public API; the repository is ALSO
  // exported so sibling modules that compose this entity cross-module (junction
  // `.list()`, EAV value→definition resolution) inject the home-module instance
  // — the only place the repo's own deps are wired (e.g. an EAV entity's repo
  // injects FieldValueService for the #374 integration dual-write tx). Local-providing
  // such a repo elsewhere can't satisfy those deps. Use-case internals stay unexported.
  exports: [ShelfService, ShelfRepository],
})
export class ShelvesModule implements OnModuleInit {
  // OPENAPI-2: register this entity's Zod schemas with the shared
  // OpenApiRegistry at module init. OPENAPI-4 awaits `build()` at boot
  // to emit the full /docs-json document.
  constructor(
    @Inject(OPENAPI_REGISTRY) private readonly openApi: OpenApiRegistry,
  ) {}

  onModuleInit(): void {
    this.openApi.registerSchema('CreateShelfDto', CreateShelfSchema);
    this.openApi.registerSchema('UpdateShelfDto', UpdateShelfSchema);
    // The response schema is named <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but the generated code publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    this.openApi.registerSchema('ShelfOutputDto', ShelfOutputSchema);
  }
}
