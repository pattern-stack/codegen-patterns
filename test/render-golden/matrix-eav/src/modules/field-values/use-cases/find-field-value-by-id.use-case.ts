
import { Injectable, NotFoundException } from '@nestjs/common';
import { FieldValueService } from '../field-value.service';
import type { FieldValue } from '../field-value.entity';

@Injectable()
export class FindFieldValueByIdUseCase {
  constructor(private readonly service: FieldValueService) {}

  async execute(id: string): Promise<FieldValue> {
    const entity = await this.service.findById(id);
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`FieldValue not found: ${id}`);
    }
    return entity;
  }
}
