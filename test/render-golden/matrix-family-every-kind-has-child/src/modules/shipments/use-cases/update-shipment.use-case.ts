
import { Injectable } from '@nestjs/common';
import { ShipmentService } from '../shipment.service';
import type { UpdateShipmentDto } from '../dto/update-shipment.dto';
import type { Shipment } from '../shipment.entity';

@Injectable()
export class UpdateShipmentUseCase {
  constructor(private readonly service: ShipmentService) {}

  async execute(
    id: string,
    dto: UpdateShipmentDto,
  ): Promise<Shipment | null> {
    return this.service.update(id, dto);
  }
}
