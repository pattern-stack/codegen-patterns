
import { Injectable } from '@nestjs/common';
import { FieldValueService } from '../field-value.service';
import type { UpdateFieldValueDto } from '../dto/update-field-value.dto';
import type { FieldValue } from '../field-value.entity';

@Injectable()
export class UpdateFieldValueUseCase {
  constructor(private readonly service: FieldValueService) {}

  async execute(
    id: string,
    dto: UpdateFieldValueDto,
  ): Promise<FieldValue | null> {
    return this.service.update(id, dto);
  }
}
