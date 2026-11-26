
import { Injectable } from '@nestjs/common';
import { BinService } from '../bin.service';

@Injectable()
export class DeleteBinUseCase {
  constructor(private readonly service: BinService) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
