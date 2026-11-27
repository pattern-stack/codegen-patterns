
import { Inject, Module, forwardRef } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '@shared/openapi';
import { DatabaseModule } from '@shared/database/database.module';
import { FieldValuesModule } from '../field-values/field-values.module';

import { LeadRepository } from './lead.repository';
import { LeadService } from './lead.service';
import { LeadController } from './lead.controller';
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
import { CreateLeadSchema } from './dto/create-lead.dto';
import { UpdateLeadSchema } from './dto/update-lead.dto';
import { LeadOutputSchema } from './dto/lead-output.dto';
import { FindLeadByIdUseCase } from './use-cases/find-lead-by-id.use-case';
import { ListLeadsUseCase } from './use-cases/list-leads.use-case';
import { FindLeadByIdWithFieldsUseCase } from './use-cases/find-lead-by-id-with-fields.use-case';
import { ListLeadsWithFieldsUseCase } from './use-cases/list-leads-with-fields.use-case';
import { CreateLeadUseCase } from './use-cases/create-lead.use-case';
import { UpdateLeadUseCase } from './use-cases/update-lead.use-case';
import { DeleteLeadUseCase } from './use-cases/delete-lead.use-case';

@Module({
  imports: [
    DatabaseModule,
    forwardRef(() => FieldValuesModule),
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
  ],
  controllers: [LeadController],
  providers: [
    LeadRepository,
    LeadService,
    FindLeadByIdUseCase,
    ListLeadsUseCase,
    FindLeadByIdWithFieldsUseCase,
    ListLeadsWithFieldsUseCase,
    CreateLeadUseCase,
    UpdateLeadUseCase,
    DeleteLeadUseCase,
  ],
  // ADR-002 (revised): the service is the public API; the repository is ALSO
  // exported so sibling modules that compose this entity cross-module (junction
  // `.list()`, EAV value→definition resolution) inject the home-module instance
  // — the only place the repo's own deps are wired (e.g. an EAV entity's repo
  // injects FieldValueService for the #374 integration dual-write tx). Local-providing
  // such a repo elsewhere can't satisfy those deps. Use-case internals stay unexported.
  exports: [LeadService, LeadRepository],
})
export class LeadsModule {
  // OPENAPI-2: register this entity's Zod schemas when Nest constructs the
  // module (in `NestFactory.create`), so they are in the registry before
  // main.ts builds /docs-json. A lifecycle hook (`onModuleInit`) runs too late.
  constructor(@Inject(OPENAPI_REGISTRY) openApi: OpenApiRegistry) {
    openApi.registerSchema('CreateLeadDto', CreateLeadSchema);
    openApi.registerSchema('UpdateLeadDto', UpdateLeadSchema);
    // The response schema is named <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but the generated code publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    openApi.registerSchema('LeadOutputDto', LeadOutputSchema);
  }
}
