
import { Injectable, NotFoundException } from '@nestjs/common';
import { ContactService } from '../contact.service';
import type { Contact } from '../contact.entity';

@Injectable()
export class FindContactByIdUseCase {
  constructor(private readonly service: ContactService) {}

  async execute(id: string): Promise<Contact> {
    const entity = await this.service.findById(id);
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`Contact not found: ${id}`);
    }
    return entity;
  }
}
