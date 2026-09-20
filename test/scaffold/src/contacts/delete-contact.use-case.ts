/**
 * DeleteContactUseCase — hand-written write use case for scaffold validation.
 * Soft-deletes the contact (sets deletedAt) via BaseService.delete.
 *
 * `BaseService.delete` returns `void` (REL-2 #587 deleted the scaffold stub that
 * used to return the row, so this suite now runs against the real contract). The
 * use-case reads the row back so the DELETE route can still answer with it —
 * which is what the HTTP contract this harness asserts has always been.
 */
import { Injectable } from '@nestjs/common';
import { ContactService } from '@gen/modules/contacts/contact.service';
import type { Contact } from '@gen/modules/contacts/contact.entity';

@Injectable()
export class DeleteContactUseCase {
  constructor(private readonly service: ContactService) {}

  async execute(id: string): Promise<Contact | null> {
    const before = await this.service.findById(id);
    if (before === null) return null;
    await this.service.delete(id);
    // `findById` filters soft-deleted rows, so the response is built from the
    // pre-delete snapshot plus the stamp the delete just applied.
    return { ...(before as Contact), deletedAt: new Date() };
  }
}
