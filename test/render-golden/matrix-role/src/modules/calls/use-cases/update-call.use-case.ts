
import { Injectable } from '@nestjs/common';
import { CallService } from '../call.service';
import type { UpdateCallDto } from '../dto/update-call.dto';
import type { Call } from '../call.entity';

@Injectable()
export class UpdateCallUseCase {
  constructor(private readonly service: CallService) {}

  async execute(
    id: string,
    dto: UpdateCallDto,
  ): Promise<Call | null> {
    return this.service.update(id, dto);
  }
}
