
import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '@shared/pipes/zod-validation.pipe';
import { ListQuerySchema, type Page } from '@shared/http/page';
import { SearchTasksUseCase } from './use-cases/search-tasks.use-case';
import type { Task } from './task.entity';

/**
 * The list endpoint's query (page / pageSize / cursor / sort_by / sort_order)
 * extended with the filters declared in task.yaml — so search pages
 * and sorts exactly as `GET /tasks` does (#744).
 */
const TaskFiltersSchema = ListQuerySchema.extend({
  projectId: z.string().uuid().optional(),
  search: z.string().optional(),
});

/**
 * Filtered search controller — generated from the `queries: - name: search`
 * block in task.yaml. Returns the same `Page<T>` envelope as the
 * list endpoint.
 */
@Controller('tasks')
export class TaskSearchController {
  constructor(private readonly searchUseCase: SearchTasksUseCase) {}

  @Get('search')
  async search(
    @Query(new ZodValidationPipe(TaskFiltersSchema))
    query: z.infer<typeof TaskFiltersSchema>,
  ): Promise<Page<Task>> {
    return this.searchUseCase.execute(query);
  }
}
