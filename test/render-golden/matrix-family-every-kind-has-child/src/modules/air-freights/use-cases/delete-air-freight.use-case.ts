
import { Injectable } from '@nestjs/common';
import { AirFreightService } from '../air-freight.service';

@Injectable()
export class DeleteAirFreightUseCase {
  constructor(private readonly service: AirFreightService) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
