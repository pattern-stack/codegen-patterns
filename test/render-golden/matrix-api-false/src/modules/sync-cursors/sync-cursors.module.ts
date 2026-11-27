
import { Inject, Module, forwardRef } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '@shared/openapi';
import { DatabaseModule } from '@shared/database/database.module';
import { AccountsModule } from '../accounts/accounts.module';

import { SyncCursorRepository } from './sync-cursor.repository';
import { SyncCursorService } from './sync-cursor.service';
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
import { CreateSyncCursorSchema } from './dto/create-sync-cursor.dto';
import { UpdateSyncCursorSchema } from './dto/update-sync-cursor.dto';
import { SyncCursorOutputSchema } from './dto/sync-cursor-output.dto';
import { FindSyncCursorByIdUseCase } from './use-cases/find-sync-cursor-by-id.use-case';
import { ListSyncCursorsUseCase } from './use-cases/list-sync-cursors.use-case';
import { CreateSyncCursorUseCase } from './use-cases/create-sync-cursor.use-case';
import { UpdateSyncCursorUseCase } from './use-cases/update-sync-cursor.use-case';
import { DeleteSyncCursorUseCase } from './use-cases/delete-sync-cursor.use-case';

@Module({
  imports: [
    DatabaseModule,
    forwardRef(() => AccountsModule),
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
  ],
  controllers: [],
  providers: [
    SyncCursorRepository,
    SyncCursorService,
    FindSyncCursorByIdUseCase,
    ListSyncCursorsUseCase,
    CreateSyncCursorUseCase,
    UpdateSyncCursorUseCase,
    DeleteSyncCursorUseCase,
  ],
  // ADR-002 (revised): the service is the public API; the repository is ALSO
  // exported so sibling modules that compose this entity cross-module (junction
  // `.list()`, EAV value→definition resolution) inject the home-module instance
  // — the only place the repo's own deps are wired (e.g. an EAV entity's repo
  // injects FieldValueService for the #374 integration dual-write tx). Local-providing
  // such a repo elsewhere can't satisfy those deps. Use-case internals stay unexported.
  exports: [SyncCursorService, SyncCursorRepository],
})
export class SyncCursorsModule {
  // OPENAPI-2: register this entity's Zod schemas when Nest constructs the
  // module (in `NestFactory.create`), so they are in the registry before
  // main.ts builds /docs-json. A lifecycle hook (`onModuleInit`) runs too late.
  constructor(@Inject(OPENAPI_REGISTRY) openApi: OpenApiRegistry) {
    openApi.registerSchema('CreateSyncCursorDto', CreateSyncCursorSchema);
    openApi.registerSchema('UpdateSyncCursorDto', UpdateSyncCursorSchema);
    // The response schema is named <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but the generated code publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    openApi.registerSchema('SyncCursorOutputDto', SyncCursorOutputSchema);
  }
}
