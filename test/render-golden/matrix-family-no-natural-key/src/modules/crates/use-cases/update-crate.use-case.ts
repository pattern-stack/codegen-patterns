
import { Injectable } from '@nestjs/common';
import { CrateService } from '../crate.service';
import type { UpdateCrateDto } from '../dto/update-crate.dto';
import type { CrateFlat } from '../crate.repository';

@Injectable()
export class UpdateCrateUseCase {
  constructor(private readonly service: CrateService) {}

  async execute(
    id: string,
    dto: UpdateCrateDto,
  ): Promise<CrateFlat | null> {
    return this.service.update(id, dto);
  }
}
