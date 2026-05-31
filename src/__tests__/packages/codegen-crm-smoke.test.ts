/**
 * Cross-workspace smoke test for @pattern-stack/codegen-crm (Track C · C1, #330).
 *
 * Resolves the package BY ITS PUBLISHED NAME from a sibling workspace (the
 * codegen root, where this test lives) — proving `bun install` linked the new
 * workspace package and its public barrel exports the C1 port + token. This is
 * the issue's "a consumer workspace imports IFieldDefinitionReader and
 * CRM_FIELD_DEFINITION_READER … both resolve" DoD check.
 */

import { describe, it, expect } from 'bun:test';
import {
  CRM_FIELD_DEFINITION_READER,
  type IFieldDefinitionReader,
  type CrmFieldDescriptor,
  type CrmFieldType,
  type CrmEntity,
} from '@pattern-stack/codegen-crm';

describe('@pattern-stack/codegen-crm public barrel', () => {
  it('exports the CRM_FIELD_DEFINITION_READER token as a registered symbol', () => {
    expect(typeof CRM_FIELD_DEFINITION_READER).toBe('symbol');
    // Symbol.for → registered in the global registry under the package-scoped key.
    expect(CRM_FIELD_DEFINITION_READER.description).toBe(
      '@pattern-stack/codegen-crm.field-definition-reader',
    );
    expect(CRM_FIELD_DEFINITION_READER).toBe(
      Symbol.for('@pattern-stack/codegen-crm.field-definition-reader'),
    );
  });

  it('exposes IFieldDefinitionReader as an implementable type-shaped port', async () => {
    // A trivial in-test implementation proves the port + vocab types compose.
    const descriptor: CrmFieldDescriptor = {
      id: 'Amount',
      label: 'Amount',
      type: 'currency' satisfies CrmFieldType,
      entity: 'opportunity' satisfies CrmEntity,
      custom: false,
    };
    const reader: IFieldDefinitionReader = {
      async list(_integrationId, entity) {
        return entity === 'opportunity' ? [descriptor] : [];
      },
    };
    await expect(reader.list('conn-1', 'opportunity')).resolves.toEqual([descriptor]);
    await expect(reader.list('conn-1', 'account')).resolves.toEqual([]);
  });
});
