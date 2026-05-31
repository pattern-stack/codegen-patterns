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
  CRM_PICKLIST_READER,
  CRM_ASSOCIATION_READER,
  CRM_CAPABILITIES,
  NO_CRM_CAPABILITIES,
  type IFieldDefinitionReader,
  type IPicklistReader,
  type IAssociationReader,
  type CrmFieldDescriptor,
  type CrmFieldType,
  type CrmEntity,
  type CrmEntityType,
  type CrmPicklistValue,
  type CrmAssociation,
  type CrmCapabilities,
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

  it('C2 — exports IPicklistReader + CRM_PICKLIST_READER', async () => {
    expect(CRM_PICKLIST_READER).toBe(
      Symbol.for('@pattern-stack/codegen-crm.picklist-reader'),
    );
    const value: CrmPicklistValue = { value: 'new', label: 'New', active: true };
    const reader: IPicklistReader = {
      async values(_id, _entity, _fieldId) {
        return [value];
      },
    };
    await expect(reader.values('conn-1', 'opportunity', 'StageName')).resolves.toEqual([
      value,
    ]);
  });

  it('C3 — exports IAssociationReader + CRM_ASSOCIATION_READER (CrmEntityType aliases CrmEntity)', async () => {
    expect(CRM_ASSOCIATION_READER).toBe(
      Symbol.for('@pattern-stack/codegen-crm.association-reader'),
    );
    // CrmEntityType is the same union as CrmEntity — a value typed as one is
    // assignable to the other (alias, single source of truth).
    const entity: CrmEntityType = 'contact';
    const asEntity: CrmEntity = entity;
    expect(asEntity).toBe('contact');

    const assoc: CrmAssociation = {
      fromEntity: 'contact',
      fromId: 'c1',
      toEntity: 'account',
      toId: 'a1',
      primary: true,
    };
    const reader: IAssociationReader = {
      async list(_id, from, _fromId, to) {
        return from === 'contact' && to === 'account' ? [assoc] : [];
      },
    };
    await expect(reader.list('conn-1', 'contact', 'c1', 'account')).resolves.toEqual([
      assoc,
    ]);
  });

  it('C4 — CrmCapabilities + NO_CRM_CAPABILITIES + CRM_CAPABILITIES token', () => {
    expect(CRM_CAPABILITIES).toBe(Symbol.for('@pattern-stack/codegen-crm.capabilities'));
    expect(NO_CRM_CAPABILITIES).toEqual({
      fieldDefinitions: false,
      picklists: false,
      associations: false,
      entities: [],
    });
    const caps: CrmCapabilities = {
      ...NO_CRM_CAPABILITIES,
      fieldDefinitions: true,
      picklists: true,
      entities: ['account', 'contact', 'opportunity'],
    };
    expect(caps.fieldDefinitions).toBe(true);
    expect(caps.associations).toBe(false); // inherited from NO_CRM_CAPABILITIES
    expect(caps.entities).toEqual(['account', 'contact', 'opportunity']);
    // NO_CRM_CAPABILITIES is not mutated by the spread.
    expect(NO_CRM_CAPABILITIES.entities).toEqual([]);
  });
});
