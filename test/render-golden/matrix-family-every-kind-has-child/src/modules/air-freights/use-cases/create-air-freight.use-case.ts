
import { Injectable } from '@nestjs/common';
import { AirFreightService } from '../air-freight.service';
import type { CreateAirFreightDto } from '../dto/create-air-freight.dto';
import type { AirFreightFlat } from '../air-freight.repository';

@Injectable()
export class CreateAirFreightUseCase {
  constructor(private readonly service: AirFreightService) {}

  async execute(
    dto: CreateAirFreightDto,
  ): Promise<AirFreightFlat> {
    return this.service.create(dto);
  }
}
