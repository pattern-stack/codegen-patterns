
import { Injectable, NotFoundException } from '@nestjs/common';
import { CategoryService } from '../category.service';
import type {
  CategoryInclude,
  CategoryNoInclude,
  CategoryResult,
} from '../category.repository';

@Injectable()
export class FindCategoryByIdUseCase {
  constructor(private readonly service: CategoryService) {}

  /**
   * `include` is a typed include TREE, not a client string — the controller has
   * already resolved `?include=` against the route's allowlist and rejected
   * anything it does not name (REL-2 §5). An internal caller passes the tree
   * directly and gets the exact nested result type back, because `TWith` is
   * inferred at the call site.
   */
  async execute<TWith extends CategoryInclude = CategoryNoInclude>(
    id: string,
    include?: TWith,
  ): Promise<CategoryResult<TWith>> {
    const entity = await this.service.findById<TWith>(
      id,
      include === undefined ? undefined : { with: include },
    );
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`Category not found: ${id}`);
    }
    return entity;
  }
}
