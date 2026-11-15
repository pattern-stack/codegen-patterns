
import { Injectable, NotFoundException } from '@nestjs/common';
import { SeaFreightService } from '../sea-freight.service';
import type {
  SeaFreightInclude,
  SeaFreightNoInclude,
  SeaFreightFlat,
} from '../sea-freight.repository';

@Injectable()
export class FindSeaFreightByIdUseCase {
  constructor(private readonly service: SeaFreightService) {}

  /**
   * RFC-0006 §3.2, §5: a sea_freight is read FLAT — `findWithBase`, one statement, the base's columns
   * hoisted to the root — so the base relation is never an include. `include` is a typed include TREE, not a client
   * string: the controller already resolved `?include=` against the route's allowlist (REL-2 §5).
   */
  async execute<TWith extends SeaFreightInclude & { shipment?: never } = SeaFreightNoInclude>(
    id: string,
    include?: TWith,
  ): Promise<SeaFreightFlat<TWith>> {
    const entity = await this.service.findWithBase<TWith>(
      id,
      include === undefined ? undefined : { with: include },
    );
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`SeaFreight not found: ${id}`);
    }
    return entity;
  }
}
