
/**
 * Declarative Query Use Cases for Task
 * Generated from queries: block in entity YAML — do not edit directly.
 *
 * Each query is an injectable use case class that delegates to the service.
 * Register all via `declarativeQueryClasses` in the module providers.
 */

import { Injectable } from '@nestjs/common';
import { TaskService } from '../task.service';
import type { Task } from '../task.entity';

@Injectable()
export class FindTaskByTitleUseCase {
  constructor(private readonly service: TaskService) {}

  async execute(title: string): Promise<Task[]> {
    return this.service.findByTitle(title);
  }
}

export const declarativeQueryClasses = [
  FindTaskByTitleUseCase,
];
