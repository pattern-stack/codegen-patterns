
import { Injectable, NotFoundException } from '@nestjs/common';
import { AirFreightService } from '../air-freight.service';
import type {
  AirFreightInclude,
  AirFreightNoInclude,
  AirFreightFlat,
} from '../air-freight.repository';

@Injectable()
export class FindAirFreightByIdUseCase {
  constructor(private readonly service: AirFreightService) {}

  /**
   * RFC-0006 §3.2, §5: a air_freight is read FLAT — `findWithBase`, one statement, the base's columns
   * hoisted to the root — so the base relation is never an include. `include` is a typed include TREE, not a client
   * string: the controller already resolved `?include=` against the route's allowlist (REL-2 §5).
   */
  async execute<TWith extends AirFreightInclude & { shipment?: never } = AirFreightNoInclude>(
    id: string,
    include?: TWith,
  ): Promise<AirFreightFlat<TWith>> {
    const entity = await this.service.findWithBase<TWith>(
      id,
      include === undefined ? undefined : { with: include },
    );
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`AirFreight not found: ${id}`);
    }
    return entity;
  }
}
