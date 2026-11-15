
import { Injectable } from '@nestjs/common';
import { CrateService } from '../crate.service';

@Injectable()
export class DeleteCrateUseCase {
  constructor(private readonly service: CrateService) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
