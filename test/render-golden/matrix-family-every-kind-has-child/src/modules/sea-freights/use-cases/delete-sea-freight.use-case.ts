
import { Injectable } from '@nestjs/common';
import { SeaFreightService } from '../sea-freight.service';

@Injectable()
export class DeleteSeaFreightUseCase {
  constructor(private readonly service: SeaFreightService) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
