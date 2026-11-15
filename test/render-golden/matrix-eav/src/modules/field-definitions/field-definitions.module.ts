
import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '@shared/openapi';
import { DatabaseModule } from '@shared/database/database.module';

import { FieldDefinitionRepository } from './field-definition.repository';
import { FieldDefinitionService } from './field-definition.service';
import { FieldDefinitionController } from './field-definition.controller';
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
import { CreateFieldDefinitionSchema } from './dto/create-field-definition.dto';
import { UpdateFieldDefinitionSchema } from './dto/update-field-definition.dto';
import { FieldDefinitionOutputSchema } from './dto/field-definition-output.dto';
import { FindFieldDefinitionByIdUseCase } from './use-cases/find-field-definition-by-id.use-case';
import { ListFieldDefinitionsUseCase } from './use-cases/list-field-definitions.use-case';
import { CreateFieldDefinitionUseCase } from './use-cases/create-field-definition.use-case';
import { UpdateFieldDefinitionUseCase } from './use-cases/update-field-definition.use-case';
import { DeleteFieldDefinitionUseCase } from './use-cases/delete-field-definition.use-case';

@Module({
  imports: [
    DatabaseModule,
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
    // Cross-domain modules from relationships:
  ],
  controllers: [FieldDefinitionController],
  providers: [
    FieldDefinitionRepository,
    FieldDefinitionService,
    FindFieldDefinitionByIdUseCase,
    ListFieldDefinitionsUseCase,
    CreateFieldDefinitionUseCase,
    UpdateFieldDefinitionUseCase,
    DeleteFieldDefinitionUseCase,
  ],
  // ADR-002 (revised): the service is the public API; the repository is ALSO
  // exported so sibling modules that compose this entity cross-module (junction
  // `.list()`, EAV value→definition resolution) inject the home-module instance
  // — the only place the repo's own deps are wired (e.g. an EAV entity's repo
  // injects FieldValueService for the #374 integration dual-write tx). Local-providing
  // such a repo elsewhere can't satisfy those deps. Use-case internals stay unexported.
  exports: [FieldDefinitionService, FieldDefinitionRepository],
})
export class FieldDefinitionsModule implements OnModuleInit {
  // OPENAPI-2: register this entity's Zod schemas with the shared
  // OpenApiRegistry at module init. OPENAPI-4 awaits `build()` at boot
  // to emit the full /docs-json document.
  constructor(
    @Inject(OPENAPI_REGISTRY) private readonly openApi: OpenApiRegistry,
  ) {}

  onModuleInit(): void {
    this.openApi.registerSchema('CreateFieldDefinitionDto', CreateFieldDefinitionSchema);
    this.openApi.registerSchema('UpdateFieldDefinitionDto', UpdateFieldDefinitionSchema);
    // The response schema is named <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but the generated code publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    this.openApi.registerSchema('FieldDefinitionOutputDto', FieldDefinitionOutputSchema);
  }
}
