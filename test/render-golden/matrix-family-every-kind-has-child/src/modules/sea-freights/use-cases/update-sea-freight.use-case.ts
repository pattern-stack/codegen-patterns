
import { Injectable } from '@nestjs/common';
import { SeaFreightService } from '../sea-freight.service';
import type { UpdateSeaFreightDto } from '../dto/update-sea-freight.dto';
import type { SeaFreightFlat } from '../sea-freight.repository';

@Injectable()
export class UpdateSeaFreightUseCase {
  constructor(private readonly service: SeaFreightService) {}

  async execute(
    id: string,
    dto: UpdateSeaFreightDto,
  ): Promise<SeaFreightFlat | null> {
    return this.service.update(id, dto);
  }
}
