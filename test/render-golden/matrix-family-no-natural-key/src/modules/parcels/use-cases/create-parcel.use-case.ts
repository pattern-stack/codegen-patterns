
import { Injectable } from '@nestjs/common';
import { ParcelService } from '../parcel.service';
import type { CreateParcelDto } from '../dto/create-parcel.dto';
import type { Parcel } from '../parcel.entity';

@Injectable()
export class CreateParcelUseCase {
  constructor(private readonly service: ParcelService) {}

  async execute(
    dto: CreateParcelDto,
  ): Promise<Parcel> {
    return this.service.create(dto);
  }
}
