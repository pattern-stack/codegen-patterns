
import { Injectable } from '@nestjs/common';
import { BinService } from '../bin.service';
import type { CreateBinDto } from '../dto/create-bin.dto';
import type { BinFlat } from '../bin.repository';

@Injectable()
export class CreateBinUseCase {
  constructor(private readonly service: BinService) {}

  async execute(
    dto: CreateBinDto,
  ): Promise<BinFlat> {
    return this.service.create(dto);
  }
}
