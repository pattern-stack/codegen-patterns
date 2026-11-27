
import { Inject, Module, forwardRef } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '@shared/openapi';
import { DatabaseModule } from '@shared/database/database.module';
import { AccountsModule } from '../accounts/accounts.module';
import { ContactsModule } from '../contacts/contacts.module';

import { CallRepository } from './call.repository';
import { CallService } from './call.service';
import { CallController } from './call.controller';
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
import { CreateCallSchema } from './dto/create-call.dto';
import { UpdateCallSchema } from './dto/update-call.dto';
import { CallOutputSchema } from './dto/call-output.dto';
import { FindCallByIdUseCase } from './use-cases/find-call-by-id.use-case';
import { ListCallsUseCase } from './use-cases/list-calls.use-case';
import { CreateCallUseCase } from './use-cases/create-call.use-case';
import { UpdateCallUseCase } from './use-cases/update-call.use-case';
import { DeleteCallUseCase } from './use-cases/delete-call.use-case';

@Module({
  imports: [
    DatabaseModule,
    forwardRef(() => AccountsModule),
    forwardRef(() => ContactsModule),
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
  ],
  controllers: [CallController],
  providers: [
    CallRepository,
    CallService,
    FindCallByIdUseCase,
    ListCallsUseCase,
    CreateCallUseCase,
    UpdateCallUseCase,
    DeleteCallUseCase,
  ],
  // ADR-002 (revised): the service is the public API; the repository is ALSO
  // exported so sibling modules that compose this entity cross-module (junction
  // `.list()`, EAV value→definition resolution) inject the home-module instance
  // — the only place the repo's own deps are wired (e.g. an EAV entity's repo
  // injects FieldValueService for the #374 integration dual-write tx). Local-providing
  // such a repo elsewhere can't satisfy those deps. Use-case internals stay unexported.
  exports: [CallService, CallRepository],
})
export class CallsModule {
  // OPENAPI-2: register this entity's Zod schemas when Nest constructs the
  // module (in `NestFactory.create`), so they are in the registry before
  // main.ts builds /docs-json. A lifecycle hook (`onModuleInit`) runs too late.
  constructor(@Inject(OPENAPI_REGISTRY) openApi: OpenApiRegistry) {
    openApi.registerSchema('CreateCallDto', CreateCallSchema);
    openApi.registerSchema('UpdateCallDto', UpdateCallSchema);
    // The response schema is named <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but the generated code publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    openApi.registerSchema('CallOutputDto', CallOutputSchema);
  }
}
