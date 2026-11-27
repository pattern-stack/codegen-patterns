
import { Inject, Module } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '@shared/openapi';
import { DatabaseModule } from '@shared/database/database.module';

import { AuditEntryRepository } from './audit-entry.repository';
import { AuditEntryService } from './audit-entry.service';
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
import { CreateAuditEntrySchema } from './dto/create-audit-entry.dto';
import { UpdateAuditEntrySchema } from './dto/update-audit-entry.dto';
import { AuditEntryOutputSchema } from './dto/audit-entry-output.dto';
import { FindAuditEntryByIdUseCase } from './use-cases/find-audit-entry-by-id.use-case';
import { ListAuditEntriesUseCase } from './use-cases/list-audit-entries.use-case';
import { CreateAuditEntryUseCase } from './use-cases/create-audit-entry.use-case';
import { UpdateAuditEntryUseCase } from './use-cases/update-audit-entry.use-case';
import { DeleteAuditEntryUseCase } from './use-cases/delete-audit-entry.use-case';

@Module({
  imports: [
    DatabaseModule,
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
  ],
  controllers: [],
  providers: [
    AuditEntryRepository,
    AuditEntryService,
    FindAuditEntryByIdUseCase,
    ListAuditEntriesUseCase,
    CreateAuditEntryUseCase,
    UpdateAuditEntryUseCase,
    DeleteAuditEntryUseCase,
  ],
  // ADR-002 (revised): the service is the public API; the repository is ALSO
  // exported so sibling modules that compose this entity cross-module (junction
  // `.list()`, EAV value→definition resolution) inject the home-module instance
  // — the only place the repo's own deps are wired (e.g. an EAV entity's repo
  // injects FieldValueService for the #374 integration dual-write tx). Local-providing
  // such a repo elsewhere can't satisfy those deps. Use-case internals stay unexported.
  exports: [AuditEntryService, AuditEntryRepository],
})
export class AuditEntriesModule {
  // OPENAPI-2: register this entity's Zod schemas when Nest constructs the
  // module (in `NestFactory.create`), so they are in the registry before
  // main.ts builds /docs-json. A lifecycle hook (`onModuleInit`) runs too late.
  constructor(@Inject(OPENAPI_REGISTRY) openApi: OpenApiRegistry) {
    openApi.registerSchema('CreateAuditEntryDto', CreateAuditEntrySchema);
    openApi.registerSchema('UpdateAuditEntryDto', UpdateAuditEntrySchema);
    // The response schema is named <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but the generated code publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    openApi.registerSchema('AuditEntryOutputDto', AuditEntryOutputSchema);
  }
}
