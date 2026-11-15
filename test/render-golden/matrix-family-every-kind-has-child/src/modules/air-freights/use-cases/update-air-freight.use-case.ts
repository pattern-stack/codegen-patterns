
import { Injectable } from '@nestjs/common';
import { AirFreightService } from '../air-freight.service';
import type { UpdateAirFreightDto } from '../dto/update-air-freight.dto';
import type { AirFreightFlat } from '../air-freight.repository';

@Injectable()
export class UpdateAirFreightUseCase {
  constructor(private readonly service: AirFreightService) {}

  async execute(
    id: string,
    dto: UpdateAirFreightDto,
  ): Promise<AirFreightFlat | null> {
    return this.service.update(id, dto);
  }
}
