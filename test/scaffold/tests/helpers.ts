/**
 * Test helpers — factories and utilities.
 */
import type { ContactInsert } from '@gen/modules/contacts/contact.entity';
import type { CrmEntity, ActivityEntity } from '../schema';

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

/** Factory for Synced family test entities. */
export function syncedEntityFactory(
  overrides?: Partial<Omit<CrmEntity, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>>,
) {
  return {
    name: `CRM Entity ${++counter}`,
    externalId: `ext-${counter}-${Date.now()}`,
    provider: 'salesforce',
    userId: `user-${counter}`,
    ...overrides,
  };
}

/** Factory for Activity family test entities. */
export function activityEntityFactory(
  overrides?: Partial<Omit<ActivityEntity, 'id' | 'createdAt' | 'updatedAt'>>,
) {
  return {
    name: `Activity ${++counter}`,
    userId: `user-${counter}`,
    opportunityId: `opp-${counter}`,
    occurredAt: new Date(),
    ...overrides,
  };
}

/** Factory for Metadata family test entities. */
export function metadataEntityFactory(
  overrides?: Record<string, unknown>,
) {
  return {
    entityType: 'contact',
    entityId: `entity-${++counter}`,
    fieldName: `field-${counter}`,
    fieldValue: `value-${counter}`,
    validFrom: new Date(),
    ...overrides,
  };
}
