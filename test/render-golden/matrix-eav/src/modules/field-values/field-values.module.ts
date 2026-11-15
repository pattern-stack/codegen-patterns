
import { Inject, Module, forwardRef, type OnModuleInit } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '@shared/openapi';
import { DatabaseModule } from '@shared/database/database.module';
import { FieldDefinitionsModule } from '../field-definitions/field-definitions.module';

import { FieldValueRepository } from './field-value.repository';
import { FieldValueService } from './field-value.service';
import { FieldValueController } from './field-value.controller';
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
import { CreateFieldValueSchema } from './dto/create-field-value.dto';
import { UpdateFieldValueSchema } from './dto/update-field-value.dto';
import { FieldValueOutputSchema } from './dto/field-value-output.dto';
import { FindFieldValueByIdUseCase } from './use-cases/find-field-value-by-id.use-case';
import { ListFieldValuesUseCase } from './use-cases/list-field-values.use-case';
import { CreateFieldValueUseCase } from './use-cases/create-field-value.use-case';
import { UpdateFieldValueUseCase } from './use-cases/update-field-value.use-case';
import { DeleteFieldValueUseCase } from './use-cases/delete-field-value.use-case';

@Module({
  imports: [
    DatabaseModule,
    forwardRef(() => FieldDefinitionsModule),
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
  ],
  controllers: [FieldValueController],
  providers: [
    FieldValueRepository,
    FieldValueService,
    FindFieldValueByIdUseCase,
    ListFieldValuesUseCase,
    CreateFieldValueUseCase,
    UpdateFieldValueUseCase,
    DeleteFieldValueUseCase,
  ],
  // ADR-002 (revised): the service is the public API; the repository is ALSO
  // exported so sibling modules that compose this entity cross-module (junction
  // `.list()`, EAV value→definition resolution) inject the home-module instance
  // — the only place the repo's own deps are wired (e.g. an EAV entity's repo
  // injects FieldValueService for the #374 integration dual-write tx). Local-providing
  // such a repo elsewhere can't satisfy those deps. Use-case internals stay unexported.
  exports: [FieldValueService, FieldValueRepository],
})
export class FieldValuesModule implements OnModuleInit {
  // OPENAPI-2: register this entity's Zod schemas with the shared
  // OpenApiRegistry at module init. OPENAPI-4 awaits `build()` at boot
  // to emit the full /docs-json document.
  constructor(
    @Inject(OPENAPI_REGISTRY) private readonly openApi: OpenApiRegistry,
  ) {}

  onModuleInit(): void {
    this.openApi.registerSchema('CreateFieldValueDto', CreateFieldValueSchema);
    this.openApi.registerSchema('UpdateFieldValueDto', UpdateFieldValueSchema);
    // The response schema is named <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but the generated code publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    this.openApi.registerSchema('FieldValueOutputDto', FieldValueOutputSchema);
  }
}
