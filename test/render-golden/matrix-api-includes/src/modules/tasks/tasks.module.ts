
import { Inject, Module, forwardRef, type OnModuleInit } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '@shared/openapi';
import { DatabaseModule } from '@shared/database/database.module';
import { ProjectsModule } from '../projects/projects.module';

import { TaskRepository } from './task.repository';
import { TaskService } from './task.service';
import { TaskController } from './task.controller';
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
import { CreateTaskSchema } from './dto/create-task.dto';
import { UpdateTaskSchema } from './dto/update-task.dto';
import { TaskOutputSchema } from './dto/task-output.dto';
import { FindTaskByIdUseCase } from './use-cases/find-task-by-id.use-case';
import { ListTasksUseCase } from './use-cases/list-tasks.use-case';
import { declarativeQueryClasses } from './use-cases/declarative-queries';
import { SearchTasksUseCase } from './use-cases/search-tasks.use-case';
import { TaskSearchController } from './task-search.controller';

@Module({
  imports: [
    DatabaseModule,
    forwardRef(() => ProjectsModule),
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
  ],
  controllers: [TaskController, TaskSearchController],
  providers: [
    TaskRepository,
    TaskService,
    FindTaskByIdUseCase,
    ListTasksUseCase,
    ...declarativeQueryClasses,
    SearchTasksUseCase,
  ],
  // ADR-002 (revised): the service is the public API; the repository is ALSO
  // exported so sibling modules that compose this entity cross-module (junction
  // `.list()`, EAV value→definition resolution) inject the home-module instance
  // — the only place the repo's own deps are wired (e.g. an EAV entity's repo
  // injects FieldValueService for the #374 integration dual-write tx). Local-providing
  // such a repo elsewhere can't satisfy those deps. Use-case internals stay unexported.
  exports: [TaskService, TaskRepository],
})
export class TasksModule implements OnModuleInit {
  // OPENAPI-2: register this entity's Zod schemas with the shared
  // OpenApiRegistry at module init. OPENAPI-4 awaits `build()` at boot
  // to emit the full /docs-json document.
  constructor(
    @Inject(OPENAPI_REGISTRY) private readonly openApi: OpenApiRegistry,
  ) {}

  onModuleInit(): void {
    this.openApi.registerSchema('CreateTaskDto', CreateTaskSchema);
    this.openApi.registerSchema('UpdateTaskDto', UpdateTaskSchema);
    // The response schema is named <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but the generated code publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    this.openApi.registerSchema('TaskOutputDto', TaskOutputSchema);
  }
}
