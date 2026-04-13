/**
 * Test helpers — factories and utilities.
 */
import type { ContactInsert } from '@gen/modules/contacts/contact.entity';

let counter = 0;

/** Generate a unique email for test isolation. */
export function uniqueEmail(): string {
  return `test-${++counter}-${Date.now()}@example.com`;
}

/** Factory for valid contact creation data. */
export function contactFactory(
  overrides?: Partial<Omit<ContactInsert, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>>,
) {
  return {
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: uniqueEmail(),
    ...overrides,
  };
}
