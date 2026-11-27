
import { Inject, Module, forwardRef } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '@shared/openapi';
import { DatabaseModule } from '@shared/database/database.module';
import { ShipmentsModule } from '../shipments/shipments.module';

import { AirFreightRepository } from './air-freight.repository';
import { AirFreightService } from './air-freight.service';
import { AirFreightController } from './air-freight.controller';
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
import { CreateAirFreightSchema } from './dto/create-air-freight.dto';
import { UpdateAirFreightSchema } from './dto/update-air-freight.dto';
import { AirFreightOutputSchema } from './dto/air-freight-output.dto';
import { FindAirFreightByIdUseCase } from './use-cases/find-air-freight-by-id.use-case';
import { ListAirFreightsUseCase } from './use-cases/list-air-freights.use-case';
import { CreateAirFreightUseCase } from './use-cases/create-air-freight.use-case';
import { UpdateAirFreightUseCase } from './use-cases/update-air-freight.use-case';
import { DeleteAirFreightUseCase } from './use-cases/delete-air-freight.use-case';

@Module({
  imports: [
    DatabaseModule,
    // A air_freight is a kind of shipment: its repository injects the base's, which that module exports.
    forwardRef(() => ShipmentsModule),
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
  ],
  controllers: [AirFreightController],
  providers: [
    AirFreightRepository,
    AirFreightService,
    FindAirFreightByIdUseCase,
    ListAirFreightsUseCase,
    CreateAirFreightUseCase,
    UpdateAirFreightUseCase,
    DeleteAirFreightUseCase,
  ],
  // ADR-002 (revised): the service is the public API; the repository is ALSO
  // exported so sibling modules that compose this entity cross-module (junction
  // `.list()`, EAV value→definition resolution) inject the home-module instance
  // — the only place the repo's own deps are wired (e.g. an EAV entity's repo
  // injects FieldValueService for the #374 integration dual-write tx). Local-providing
  // such a repo elsewhere can't satisfy those deps. Use-case internals stay unexported.
  exports: [AirFreightService, AirFreightRepository],
})
export class AirFreightsModule {
  // OPENAPI-2: register this entity's Zod schemas when Nest constructs the
  // module (in `NestFactory.create`), so they are in the registry before
  // main.ts builds /docs-json. A lifecycle hook (`onModuleInit`) runs too late.
  constructor(@Inject(OPENAPI_REGISTRY) openApi: OpenApiRegistry) {
    openApi.registerSchema('CreateAirFreightDto', CreateAirFreightSchema);
    openApi.registerSchema('UpdateAirFreightDto', UpdateAirFreightSchema);
    // The response schema is named <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but the generated code publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    openApi.registerSchema('AirFreightOutputDto', AirFreightOutputSchema);
  }
}
