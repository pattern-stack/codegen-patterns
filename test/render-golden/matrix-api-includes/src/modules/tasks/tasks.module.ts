
import { Inject, Module, forwardRef } from '@nestjs/common';
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
export class TasksModule {
  // OPENAPI-2: register this entity's Zod schemas when Nest constructs the
  // module (in `NestFactory.create`), so they are in the registry before
  // main.ts builds /docs-json. A lifecycle hook (`onModuleInit`) runs too late.
  constructor(@Inject(OPENAPI_REGISTRY) openApi: OpenApiRegistry) {
    openApi.registerSchema('CreateTaskDto', CreateTaskSchema);
    openApi.registerSchema('UpdateTaskDto', UpdateTaskSchema);
    // The response schema is named <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but the generated code publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    openApi.registerSchema('TaskOutputDto', TaskOutputSchema);
  }
}
