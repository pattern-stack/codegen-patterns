
import { Injectable } from '@nestjs/common';
import { ParcelService } from '../parcel.service';
import type { UpdateParcelDto } from '../dto/update-parcel.dto';
import type { Parcel } from '../parcel.entity';

@Injectable()
export class UpdateParcelUseCase {
  constructor(private readonly service: ParcelService) {}

  async execute(
    id: string,
    dto: UpdateParcelDto,
  ): Promise<Parcel | null> {
    return this.service.update(id, dto);
  }
}
