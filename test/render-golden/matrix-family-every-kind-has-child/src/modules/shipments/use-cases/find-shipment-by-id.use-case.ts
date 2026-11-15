
import { Injectable, NotFoundException } from '@nestjs/common';
import { ShipmentService } from '../shipment.service';
import type {
  ShipmentInclude,
  ShipmentNoInclude,
  ShipmentResult,
} from '../shipment.repository';

@Injectable()
export class FindShipmentByIdUseCase {
  constructor(private readonly service: ShipmentService) {}

  /**
   * `include` is a typed include TREE, not a client string — the controller has
   * already resolved `?include=` against the route's allowlist and rejected
   * anything it does not name (REL-2 §5). An internal caller passes the tree
   * directly and gets the exact nested result type back, because `TWith` is
   * inferred at the call site.
   */
  async execute<TWith extends ShipmentInclude = ShipmentNoInclude>(
    id: string,
    include?: TWith,
  ): Promise<ShipmentResult<TWith>> {
    const entity = await this.service.findById<TWith>(
      id,
      include === undefined ? undefined : { with: include },
    );
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`Shipment not found: ${id}`);
    }
    return entity;
  }
}
