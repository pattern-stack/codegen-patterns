
import { Injectable } from '@nestjs/common';
import { CrateService } from '../crate.service';
import type { CreateCrateDto } from '../dto/create-crate.dto';
import type { CrateFlat } from '../crate.repository';

@Injectable()
export class CreateCrateUseCase {
  constructor(private readonly service: CrateService) {}

  async execute(
    dto: CreateCrateDto,
  ): Promise<CrateFlat> {
    return this.service.create(dto);
  }
}
