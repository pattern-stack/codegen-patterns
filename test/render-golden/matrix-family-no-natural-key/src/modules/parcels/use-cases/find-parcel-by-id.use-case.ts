
import { Injectable, NotFoundException } from '@nestjs/common';
import { ParcelService } from '../parcel.service';
import type {
  ParcelInclude,
  ParcelNoInclude,
  ParcelResult,
} from '../parcel.repository';

@Injectable()
export class FindParcelByIdUseCase {
  constructor(private readonly service: ParcelService) {}

  /**
   * `include` is a typed include TREE, not a client string — the controller has
   * already resolved `?include=` against the route's allowlist and rejected
   * anything it does not name (REL-2 §5). An internal caller passes the tree
   * directly and gets the exact nested result type back, because `TWith` is
   * inferred at the call site.
   */
  async execute<TWith extends ParcelInclude = ParcelNoInclude>(
    id: string,
    include?: TWith,
  ): Promise<ParcelResult<TWith>> {
    const entity = await this.service.findById<TWith>(
      id,
      include === undefined ? undefined : { with: include },
    );
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`Parcel not found: ${id}`);
    }
    return entity;
  }
}
