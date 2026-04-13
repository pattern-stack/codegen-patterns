/**
 * DeleteContactUseCase — hand-written write use case for scaffold validation.
 * Soft-deletes the contact (sets deletedAt) via BaseService.delete.
 */
import { Injectable } from '@nestjs/common';
import { ContactService } from '@gen/modules/contacts/contact.service';
import type { Contact } from '@gen/modules/contacts/contact.entity';

@Injectable()
export class DeleteContactUseCase {
  constructor(private readonly service: ContactService) {}

  async execute(id: string): Promise<Contact | null> {
    return this.service.delete(id);
  }
}
