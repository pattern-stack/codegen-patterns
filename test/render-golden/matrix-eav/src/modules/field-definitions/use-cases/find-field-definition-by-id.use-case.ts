
import { Injectable, NotFoundException } from '@nestjs/common';
import { FieldDefinitionService } from '../field-definition.service';
import type { FieldDefinition } from '../field-definition.entity';

@Injectable()
export class FindFieldDefinitionByIdUseCase {
  constructor(private readonly service: FieldDefinitionService) {}

  async execute(id: string): Promise<FieldDefinition> {
    const entity = await this.service.findById(id);
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`FieldDefinition not found: ${id}`);
    }
    return entity;
  }
}
