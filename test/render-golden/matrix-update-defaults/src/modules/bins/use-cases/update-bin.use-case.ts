
import { Injectable } from '@nestjs/common';
import { BinService } from '../bin.service';
import type { UpdateBinDto } from '../dto/update-bin.dto';
import type { BinFlat } from '../bin.repository';

@Injectable()
export class UpdateBinUseCase {
  constructor(private readonly service: BinService) {}

  async execute(
    id: string,
    dto: UpdateBinDto,
  ): Promise<BinFlat | null> {
    return this.service.update(id, dto);
  }
}
