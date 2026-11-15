
import { Injectable, NotFoundException } from '@nestjs/common';
import { CrateService } from '../crate.service';
import type {
  CrateInclude,
  CrateNoInclude,
  CrateFlat,
} from '../crate.repository';

@Injectable()
export class FindCrateByIdUseCase {
  constructor(private readonly service: CrateService) {}

  /**
   * RFC-0006 §3.2, §5: a crate is read FLAT — `findWithBase`, one statement, the base's columns
   * hoisted to the root — so the base relation is never an include. `include` is a typed include TREE, not a client
   * string: the controller already resolved `?include=` against the route's allowlist (REL-2 §5).
   */
  async execute<TWith extends CrateInclude = CrateNoInclude>(
    id: string,
    include?: TWith,
  ): Promise<CrateFlat<TWith>> {
    const entity = await this.service.findWithBase<TWith>(
      id,
      include === undefined ? undefined : { with: include },
    );
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`Crate not found: ${id}`);
    }
    return entity;
  }
}
