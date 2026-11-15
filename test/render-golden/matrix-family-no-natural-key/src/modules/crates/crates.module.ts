
import { Inject, Module, forwardRef, type OnModuleInit } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '@shared/openapi';
import { DatabaseModule } from '@shared/database/database.module';
import { ParcelsModule } from '../parcels/parcels.module';

import { CrateRepository } from './crate.repository';
import { CrateService } from './crate.service';
import { CrateController } from './crate.controller';
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
import { CreateCrateSchema } from './dto/create-crate.dto';
import { UpdateCrateSchema } from './dto/update-crate.dto';
import { CrateOutputSchema } from './dto/crate-output.dto';
import { FindCrateByIdUseCase } from './use-cases/find-crate-by-id.use-case';
import { ListCratesUseCase } from './use-cases/list-crates.use-case';
import { CreateCrateUseCase } from './use-cases/create-crate.use-case';
import { UpdateCrateUseCase } from './use-cases/update-crate.use-case';
import { DeleteCrateUseCase } from './use-cases/delete-crate.use-case';

@Module({
  imports: [
    DatabaseModule,
    // A crate is a kind of parcel: its repository injects the base's, which that module exports.
    forwardRef(() => ParcelsModule),
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
  ],
  controllers: [CrateController],
  providers: [
    CrateRepository,
    CrateService,
    FindCrateByIdUseCase,
    ListCratesUseCase,
    CreateCrateUseCase,
    UpdateCrateUseCase,
    DeleteCrateUseCase,
  ],
  // ADR-002 (revised): the service is the public API; the repository is ALSO
  // exported so sibling modules that compose this entity cross-module (junction
  // `.list()`, EAV value→definition resolution) inject the home-module instance
  // — the only place the repo's own deps are wired (e.g. an EAV entity's repo
  // injects FieldValueService for the #374 integration dual-write tx). Local-providing
  // such a repo elsewhere can't satisfy those deps. Use-case internals stay unexported.
  exports: [CrateService, CrateRepository],
})
export class CratesModule implements OnModuleInit {
  // OPENAPI-2: register this entity's Zod schemas with the shared
  // OpenApiRegistry at module init. OPENAPI-4 awaits `build()` at boot
  // to emit the full /docs-json document.
  constructor(
    @Inject(OPENAPI_REGISTRY) private readonly openApi: OpenApiRegistry,
  ) {}

  onModuleInit(): void {
    this.openApi.registerSchema('CreateCrateDto', CreateCrateSchema);
    this.openApi.registerSchema('UpdateCrateDto', UpdateCrateSchema);
    // The response schema is named <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but the generated code publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    this.openApi.registerSchema('CrateOutputDto', CrateOutputSchema);
  }
}
