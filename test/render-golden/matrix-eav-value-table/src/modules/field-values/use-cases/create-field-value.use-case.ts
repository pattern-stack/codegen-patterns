
import { Injectable } from '@nestjs/common';
import { FieldValueService } from '../field-value.service';
import type { CreateFieldValueDto } from '../dto/create-field-value.dto';
import type { FieldValue } from '../field-value.entity';

@Injectable()
export class CreateFieldValueUseCase {
  constructor(private readonly service: FieldValueService) {}

  async execute(
    dto: CreateFieldValueDto,
  ): Promise<FieldValue> {
    return this.service.create(dto);
  }
}
