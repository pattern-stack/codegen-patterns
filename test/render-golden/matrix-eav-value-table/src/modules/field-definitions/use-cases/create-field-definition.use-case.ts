
import { Injectable } from '@nestjs/common';
import { FieldDefinitionService } from '../field-definition.service';
import type { CreateFieldDefinitionDto } from '../dto/create-field-definition.dto';
import type { FieldDefinition } from '../field-definition.entity';

@Injectable()
export class CreateFieldDefinitionUseCase {
  constructor(private readonly service: FieldDefinitionService) {}

  async execute(
    dto: CreateFieldDefinitionDto,
  ): Promise<FieldDefinition> {
    return this.service.create(dto);
  }
}
