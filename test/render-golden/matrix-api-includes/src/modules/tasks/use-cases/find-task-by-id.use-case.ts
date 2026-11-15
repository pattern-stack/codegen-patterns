
import { Injectable, NotFoundException } from '@nestjs/common';
import { TaskService } from '../task.service';
import type {
  TaskInclude,
  TaskNoInclude,
  TaskResult,
} from '../task.repository';

@Injectable()
export class FindTaskByIdUseCase {
  constructor(private readonly service: TaskService) {}

  /**
   * `include` is a typed include TREE, not a client string — the controller has
   * already resolved `?include=` against the route's allowlist and rejected
   * anything it does not name (REL-2 §5). An internal caller passes the tree
   * directly and gets the exact nested result type back, because `TWith` is
   * inferred at the call site.
   */
  async execute<TWith extends TaskInclude = TaskNoInclude>(
    id: string,
    include?: TWith,
  ): Promise<TaskResult<TWith>> {
    const entity = await this.service.findById<TWith>(
      id,
      include === undefined ? undefined : { with: include },
    );
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`Task not found: ${id}`);
    }
    return entity;
  }
}
