
import { Inject, Module, forwardRef, type OnModuleInit } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '@shared/openapi';
import { DatabaseModule } from '@shared/database/database.module';
import { ShipmentsModule } from '../shipments/shipments.module';

import { SeaFreightRepository } from './sea-freight.repository';
import { SeaFreightService } from './sea-freight.service';
import { SeaFreightController } from './sea-freight.controller';
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
import { CreateSeaFreightSchema } from './dto/create-sea-freight.dto';
import { UpdateSeaFreightSchema } from './dto/update-sea-freight.dto';
import { SeaFreightOutputSchema } from './dto/sea-freight-output.dto';
import { FindSeaFreightByIdUseCase } from './use-cases/find-sea-freight-by-id.use-case';
import { ListSeaFreightsUseCase } from './use-cases/list-sea-freights.use-case';
import { CreateSeaFreightUseCase } from './use-cases/create-sea-freight.use-case';
import { UpdateSeaFreightUseCase } from './use-cases/update-sea-freight.use-case';
import { DeleteSeaFreightUseCase } from './use-cases/delete-sea-freight.use-case';

@Module({
  imports: [
    DatabaseModule,
    // A sea_freight is a kind of shipment: its repository injects the base's, which that module exports.
    forwardRef(() => ShipmentsModule),
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
  ],
  controllers: [SeaFreightController],
  providers: [
    SeaFreightRepository,
    SeaFreightService,
    FindSeaFreightByIdUseCase,
    ListSeaFreightsUseCase,
    CreateSeaFreightUseCase,
    UpdateSeaFreightUseCase,
    DeleteSeaFreightUseCase,
  ],
  // ADR-002 (revised): the service is the public API; the repository is ALSO
  // exported so sibling modules that compose this entity cross-module (junction
  // `.list()`, EAV value→definition resolution) inject the home-module instance
  // — the only place the repo's own deps are wired (e.g. an EAV entity's repo
  // injects FieldValueService for the #374 integration dual-write tx). Local-providing
  // such a repo elsewhere can't satisfy those deps. Use-case internals stay unexported.
  exports: [SeaFreightService, SeaFreightRepository],
})
export class SeaFreightsModule implements OnModuleInit {
  // OPENAPI-2: register this entity's Zod schemas with the shared
  // OpenApiRegistry at module init. OPENAPI-4 awaits `build()` at boot
  // to emit the full /docs-json document.
  constructor(
    @Inject(OPENAPI_REGISTRY) private readonly openApi: OpenApiRegistry,
  ) {}

  onModuleInit(): void {
    this.openApi.registerSchema('CreateSeaFreightDto', CreateSeaFreightSchema);
    this.openApi.registerSchema('UpdateSeaFreightDto', UpdateSeaFreightSchema);
    // The response schema is named <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but the generated code publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    this.openApi.registerSchema('SeaFreightOutputDto', SeaFreightOutputSchema);
  }
}
