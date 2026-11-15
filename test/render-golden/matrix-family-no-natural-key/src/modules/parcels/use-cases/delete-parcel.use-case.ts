
import { Injectable } from '@nestjs/common';
import { ParcelService } from '../parcel.service';

@Injectable()
export class DeleteParcelUseCase {
  constructor(private readonly service: ParcelService) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
