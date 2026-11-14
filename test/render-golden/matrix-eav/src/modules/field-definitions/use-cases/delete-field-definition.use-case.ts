
import { Injectable } from '@nestjs/common';
import { FieldDefinitionService } from '../field-definition.service';

@Injectable()
export class DeleteFieldDefinitionUseCase {
  constructor(private readonly service: FieldDefinitionService) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
