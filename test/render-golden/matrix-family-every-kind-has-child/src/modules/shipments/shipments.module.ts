
import { Inject, Module } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '@shared/openapi';
import { DatabaseModule } from '@shared/database/database.module';

import { ShipmentRepository } from './shipment.repository';
import { ShipmentService } from './shipment.service';
import { ShipmentController } from './shipment.controller';
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
import { UpdateShipmentSchema } from './dto/update-shipment.dto';
import { ShipmentOutputSchema } from './dto/shipment-output.dto';
import { FindShipmentByIdUseCase } from './use-cases/find-shipment-by-id.use-case';
import { ListShipmentsUseCase } from './use-cases/list-shipments.use-case';
import { UpdateShipmentUseCase } from './use-cases/update-shipment.use-case';
import { DeleteShipmentUseCase } from './use-cases/delete-shipment.use-case';

@Module({
  imports: [
    DatabaseModule,
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
  ],
  controllers: [ShipmentController],
  providers: [
    ShipmentRepository,
    ShipmentService,
    FindShipmentByIdUseCase,
    ListShipmentsUseCase,
    UpdateShipmentUseCase,
    DeleteShipmentUseCase,
  ],
  // ADR-002 (revised): the service is the public API; the repository is ALSO
  // exported so sibling modules that compose this entity cross-module (junction
  // `.list()`, EAV value→definition resolution) inject the home-module instance
  // — the only place the repo's own deps are wired (e.g. an EAV entity's repo
  // injects FieldValueService for the #374 integration dual-write tx). Local-providing
  // such a repo elsewhere can't satisfy those deps. Use-case internals stay unexported.
  exports: [ShipmentService, ShipmentRepository],
})
export class ShipmentsModule {
  // OPENAPI-2: register this entity's Zod schemas when Nest constructs the
  // module (in `NestFactory.create`), so they are in the registry before
  // main.ts builds /docs-json. A lifecycle hook (`onModuleInit`) runs too late.
  constructor(@Inject(OPENAPI_REGISTRY) openApi: OpenApiRegistry) {
    openApi.registerSchema('UpdateShipmentDto', UpdateShipmentSchema);
    // The response schema is named <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but the generated code publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    openApi.registerSchema('ShipmentOutputDto', ShipmentOutputSchema);
  }
}
