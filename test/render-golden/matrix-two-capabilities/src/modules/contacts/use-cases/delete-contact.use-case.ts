
import { Injectable } from '@nestjs/common';
import { ContactService } from '../contact.service';

@Injectable()
export class DeleteContactUseCase {
  constructor(private readonly service: ContactService) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
