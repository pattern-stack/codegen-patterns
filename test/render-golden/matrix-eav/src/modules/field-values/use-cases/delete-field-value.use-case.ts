
import { Injectable } from '@nestjs/common';
import { FieldValueService } from '../field-value.service';

@Injectable()
export class DeleteFieldValueUseCase {
  constructor(private readonly service: FieldValueService) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
