
import { Injectable } from '@nestjs/common';
import { SeaFreightService } from '../sea-freight.service';
import type { CreateSeaFreightDto } from '../dto/create-sea-freight.dto';
import type { SeaFreightFlat } from '../sea-freight.repository';

@Injectable()
export class CreateSeaFreightUseCase {
  constructor(private readonly service: SeaFreightService) {}

  async execute(
    dto: CreateSeaFreightDto,
  ): Promise<SeaFreightFlat> {
    return this.service.create(dto);
  }
}
