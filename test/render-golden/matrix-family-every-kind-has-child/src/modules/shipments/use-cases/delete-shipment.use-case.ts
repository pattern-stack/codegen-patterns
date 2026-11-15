
import { Injectable } from '@nestjs/common';
import { ShipmentService } from '../shipment.service';

@Injectable()
export class DeleteShipmentUseCase {
  constructor(private readonly service: ShipmentService) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
