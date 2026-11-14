
import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '@shared/openapi';
import { DatabaseModule } from '@shared/database/database.module';
import { AccountRepository } from '../accounts/account.repository';
import { TaskRepository } from '../tasks/task.repository';

import { ProjectRepository } from './project.repository';
import { ProjectService } from './project.service';
import { ProjectController } from './project.controller';
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
import { CreateProjectSchema } from './dto/create-project.dto';
import { UpdateProjectSchema } from './dto/update-project.dto';
import { ProjectOutputSchema } from './dto/project-output.dto';
import { FindProjectByIdUseCase } from './use-cases/find-project-by-id.use-case';
import { ListProjectsUseCase } from './use-cases/list-projects.use-case';
import { CreateProjectUseCase } from './use-cases/create-project.use-case';
import { UpdateProjectUseCase } from './use-cases/update-project.use-case';
import { DeleteProjectUseCase } from './use-cases/delete-project.use-case';

@Module({
  imports: [
    DatabaseModule,
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
    // Cross-domain modules from relationships:
    // AccountsModule,
  ],
  controllers: [ProjectController],
  providers: [
    ProjectRepository,
    ProjectService,
    AccountRepository,
    TaskRepository,
    FindProjectByIdUseCase,
    ListProjectsUseCase,
    CreateProjectUseCase,
    UpdateProjectUseCase,
    DeleteProjectUseCase,
  ],
  // ADR-002 (revised): the service is the public API; the repository is ALSO
  // exported so sibling modules that compose this entity cross-module (junction
  // `.list()`, EAV value→definition resolution) inject the home-module instance
  // — the only place the repo's own deps are wired (e.g. an EAV entity's repo
  // injects FieldValueService for the #374 integration dual-write tx). Local-providing
  // such a repo elsewhere can't satisfy those deps. Use-case internals stay unexported.
  exports: [ProjectService, ProjectRepository],
})
export class ProjectsModule implements OnModuleInit {
  // OPENAPI-2: register this entity's Zod schemas with the shared
  // OpenApiRegistry at module init. OPENAPI-4 awaits `build()` at boot
  // to emit the full /docs-json document.
  constructor(
    @Inject(OPENAPI_REGISTRY) private readonly openApi: OpenApiRegistry,
  ) {}

  onModuleInit(): void {
    this.openApi.registerSchema('CreateProjectDto', CreateProjectSchema);
    this.openApi.registerSchema('UpdateProjectDto', UpdateProjectSchema);
    // The response schema is named <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but the generated code publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    this.openApi.registerSchema('ProjectOutputDto', ProjectOutputSchema);
  }
}
