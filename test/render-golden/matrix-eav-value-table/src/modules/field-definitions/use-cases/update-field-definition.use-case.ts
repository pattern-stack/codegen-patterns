
import { Injectable } from '@nestjs/common';
import { FieldDefinitionService } from '../field-definition.service';
import type { UpdateFieldDefinitionDto } from '../dto/update-field-definition.dto';
import type { FieldDefinition } from '../field-definition.entity';

@Injectable()
export class UpdateFieldDefinitionUseCase {
  constructor(private readonly service: FieldDefinitionService) {}

  async execute(
    id: string,
    dto: UpdateFieldDefinitionDto,
  ): Promise<FieldDefinition | null> {
    return this.service.update(id, dto);
  }
}
