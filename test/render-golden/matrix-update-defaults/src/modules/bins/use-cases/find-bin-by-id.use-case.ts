
import { Injectable, NotFoundException } from '@nestjs/common';
import { BinService } from '../bin.service';
import type {
  BinInclude,
  BinNoInclude,
  BinFlat,
} from '../bin.repository';

@Injectable()
export class FindBinByIdUseCase {
  constructor(private readonly service: BinService) {}

  /**
   * RFC-0006 §3.2, §5: a bin is read FLAT — `findWithBase`, one statement, the base's columns
   * hoisted to the root — so the base relation is never an include. `include` is a typed include TREE, not a client
   * string: the controller already resolved `?include=` against the route's allowlist (REL-2 §5).
   */
  async execute<TWith extends BinInclude & { tote?: never } = BinNoInclude>(
    id: string,
    include?: TWith,
  ): Promise<BinFlat<TWith>> {
    const entity = await this.service.findWithBase<TWith>(
      id,
      include === undefined ? undefined : { with: include },
    );
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`Bin not found: ${id}`);
    }
    return entity;
  }
}
