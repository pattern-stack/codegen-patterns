
import { Inject, Module, forwardRef } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '@shared/openapi';
import { DatabaseModule } from '@shared/database/database.module';
import { WorkspaceMembersModule } from '../workspace-members/workspace-members.module';

import { WorkspaceRepository } from './workspace.repository';
import { WorkspaceService } from './workspace.service';
import { WorkspaceController } from './workspace.controller';
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
import { CreateWorkspaceSchema } from './dto/create-workspace.dto';
import { UpdateWorkspaceSchema } from './dto/update-workspace.dto';
import { WorkspaceOutputSchema } from './dto/workspace-output.dto';
import { FindWorkspaceByIdUseCase } from './use-cases/find-workspace-by-id.use-case';
import { ListWorkspacesUseCase } from './use-cases/list-workspaces.use-case';
import { CreateWorkspaceUseCase } from './use-cases/create-workspace.use-case';
import { UpdateWorkspaceUseCase } from './use-cases/update-workspace.use-case';
import { DeleteWorkspaceUseCase } from './use-cases/delete-workspace.use-case';

@Module({
  imports: [
    DatabaseModule,
    forwardRef(() => WorkspaceMembersModule),
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
  ],
  controllers: [WorkspaceController],
  providers: [
    WorkspaceRepository,
    WorkspaceService,
    FindWorkspaceByIdUseCase,
    ListWorkspacesUseCase,
    CreateWorkspaceUseCase,
    UpdateWorkspaceUseCase,
    DeleteWorkspaceUseCase,
  ],
  // ADR-002 (revised): the service is the public API; the repository is ALSO
  // exported so sibling modules that compose this entity cross-module (junction
  // `.list()`, EAV value→definition resolution) inject the home-module instance
  // — the only place the repo's own deps are wired (e.g. an EAV entity's repo
  // injects FieldValueService for the #374 integration dual-write tx). Local-providing
  // such a repo elsewhere can't satisfy those deps. Use-case internals stay unexported.
  exports: [WorkspaceService, WorkspaceRepository],
})
export class WorkspacesModule {
  // OPENAPI-2: register this entity's Zod schemas when Nest constructs the
  // module (in `NestFactory.create`), so they are in the registry before
  // main.ts builds /docs-json. A lifecycle hook (`onModuleInit`) runs too late.
  constructor(@Inject(OPENAPI_REGISTRY) openApi: OpenApiRegistry) {
    openApi.registerSchema('CreateWorkspaceDto', CreateWorkspaceSchema);
    openApi.registerSchema('UpdateWorkspaceDto', UpdateWorkspaceSchema);
    // The response schema is named <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but the generated code publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    openApi.registerSchema('WorkspaceOutputDto', WorkspaceOutputSchema);
  }
}
