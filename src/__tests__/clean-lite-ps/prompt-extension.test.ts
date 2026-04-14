/**
 * Unit tests for clean-lite-ps/prompt-extension.js
 */

import { describe, it, expect } from 'bun:test';
import { buildCleanLitePsLocals } from '../../../templates/entity/new/clean-lite-ps/prompt-extension.js';

// Minimal base locals (the real version has many more fields, but we only need
// the shape to test the extension itself)
const EMPTY_BASE_LOCALS = {};

// ============================================================================
// Contact entity definition matching test/fixtures/contact-v2.yaml
// ============================================================================

const contactDefinition = {
  entity: {
    name: 'contact',
    plural: 'contacts',
    table: 'contacts',
    family: 'synced',
  },
  fields: {
    user_id: { type: 'uuid', required: true },
    account_id: { type: 'uuid', nullable: true },
    first_name: { type: 'string', required: true },
    last_name: { type: 'string', required: true },
    email: { type: 'string', required: true },
    title: { type: 'string', nullable: true },
    phone: { type: 'string', nullable: true },
    linkedin_url: { type: 'string', nullable: true },
  },
  relationships: {
    account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id', nullable: true },
    user: { type: 'belongs_to', target: 'user', foreign_key: 'user_id', nullable: false },
  },
  behaviors: ['timestamps', 'soft_delete'],
};

// Entity without family key
const noFamilyDefinition = {
  entity: { name: 'task', plural: 'tasks', table: 'tasks' },
  fields: { title: { type: 'string', required: true } },
  relationships: {},
  behaviors: [],
};

// Activity family entity
const activityDefinition = {
  entity: { name: 'note', plural: 'notes', table: 'notes', family: 'activity' },
  fields: { body: { type: 'string', required: true } },
  relationships: {},
  behaviors: ['timestamps'],
};

// ============================================================================
// Tests
// ============================================================================

describe('buildCleanLitePsLocals', () => {
  it('derives correct class names from entity name', () => {
    const locals = buildCleanLitePsLocals(contactDefinition, EMPTY_BASE_LOCALS);

    expect(locals.entityName).toBe('contact');
    expect(locals.entityNamePascal).toBe('Contact');
    expect(locals.entityNamePlural).toBe('contacts');
    expect(locals.entityNamePluralPascal).toBe('Contacts');

    expect(locals.classNames.entity).toBe('Contact');
    expect(locals.classNames.repository).toBe('ContactRepository');
    expect(locals.classNames.service).toBe('ContactService');
    expect(locals.classNames.controller).toBe('ContactController');
    expect(locals.classNames.module).toBe('ContactsModule');
    expect(locals.classNames.findByIdUseCase).toBe('FindContactByIdUseCase');
    expect(locals.classNames.listUseCase).toBe('ListContactsUseCase');
    expect(locals.classNames.createDto).toBe('CreateContactDto');
    expect(locals.classNames.updateDto).toBe('UpdateContactDto');
    expect(locals.classNames.outputDto).toBe('ContactOutputDto');
    expect(locals.classNames.createSchema).toBe('CreateContactSchema');
    expect(locals.classNames.updateSchema).toBe('UpdateContactSchema');
    expect(locals.classNames.outputSchema).toBe('ContactOutputSchema');
  });

  it('maps synced family to SyncedEntityRepository and SyncedEntityService', () => {
    const locals = buildCleanLitePsLocals(contactDefinition, EMPTY_BASE_LOCALS);

    expect(locals.family).toBe('synced');
    expect(locals.repositoryBaseClass).toBe('SyncedEntityRepository');
    expect(locals.serviceBaseClass).toBe('SyncedEntityService');
    expect(locals.repositoryBaseImport).toBe('@shared/base-classes/synced-entity-repository');
    expect(locals.serviceBaseImport).toBe('@shared/base-classes/synced-entity-service');
  });

  it('maps activity family to ActivityEntityRepository and ActivityEntityService', () => {
    const locals = buildCleanLitePsLocals(activityDefinition, EMPTY_BASE_LOCALS);

    expect(locals.family).toBe('activity');
    expect(locals.repositoryBaseClass).toBe('ActivityEntityRepository');
    expect(locals.serviceBaseClass).toBe('ActivityEntityService');
    expect(locals.repositoryBaseImport).toBe('@shared/base-classes/activity-entity-repository');
    expect(locals.serviceBaseImport).toBe('@shared/base-classes/activity-entity-service');
  });

  it('defaults to base family when family key is absent', () => {
    const locals = buildCleanLitePsLocals(noFamilyDefinition, EMPTY_BASE_LOCALS);

    expect(locals.family).toBe('base');
    expect(locals.repositoryBaseClass).toBe('BaseRepository');
    expect(locals.serviceBaseClass).toBe('BaseService');
    expect(locals.repositoryBaseImport).toBe('@shared/base-classes/base-repository');
    expect(locals.serviceBaseImport).toBe('@shared/base-classes/base-service');
  });

  it('generates correct output paths for entity with plural name', () => {
    const locals = buildCleanLitePsLocals(contactDefinition, EMPTY_BASE_LOCALS);

    expect(locals.clpOutputPaths.entity).toBe('modules/contacts/contact.entity.ts');
    expect(locals.clpOutputPaths.repository).toBe('modules/contacts/contact.repository.ts');
    expect(locals.clpOutputPaths.service).toBe('modules/contacts/contact.service.ts');
    expect(locals.clpOutputPaths.controller).toBe('modules/contacts/contact.controller.ts');
    expect(locals.clpOutputPaths.module).toBe('modules/contacts/contacts.module.ts');
    expect(locals.clpOutputPaths.findByIdUseCase).toBe('modules/contacts/use-cases/find-contact-by-id.use-case.ts');
    expect(locals.clpOutputPaths.listUseCase).toBe('modules/contacts/use-cases/list-contacts.use-case.ts');
    expect(locals.clpOutputPaths.createDto).toBe('modules/contacts/dto/create-contact.dto.ts');
    expect(locals.clpOutputPaths.updateDto).toBe('modules/contacts/dto/update-contact.dto.ts');
    expect(locals.clpOutputPaths.outputDto).toBe('modules/contacts/dto/contact-output.dto.ts');
  });

  it('processes belongs_to relations into BelongsToRelation shape', () => {
    const locals = buildCleanLitePsLocals(contactDefinition, EMPTY_BASE_LOCALS);

    expect(locals.clpBelongsTo).toHaveLength(2);

    const accountRel = locals.clpBelongsTo.find((r: any) => r.relatedEntity === 'account');
    expect(accountRel).toBeDefined();
    expect(accountRel!.field).toBe('account_id');
    expect(accountRel!.camelField).toBe('accountId');
    expect(accountRel!.relatedEntityPascal).toBe('Account');
    expect(accountRel!.relatedTable).toBe('accounts');
    expect(accountRel!.nullable).toBe(true);
    expect(accountRel!.importPath).toBe('../accounts/account.entity');

    const userRel = locals.clpBelongsTo.find((r: any) => r.relatedEntity === 'user');
    expect(userRel).toBeDefined();
    expect(userRel!.nullable).toBe(false);
  });

  it('excludes id and behavior fields from create DTO field list', () => {
    const locals = buildCleanLitePsLocals(contactDefinition, EMPTY_BASE_LOCALS);

    const fieldNames = locals.clpCreateDtoFields.map((f: any) => f.name);

    // Must not include these
    expect(fieldNames).not.toContain('id');
    expect(fieldNames).not.toContain('created_at');
    expect(fieldNames).not.toContain('updated_at');
    expect(fieldNames).not.toContain('deleted_at');

    // Must include entity fields (FK fields handled separately in clpBelongsToFkFields)
    expect(fieldNames).toContain('first_name');
    expect(fieldNames).toContain('last_name');
    expect(fieldNames).toContain('email');
    expect(fieldNames).toContain('title');
  });

  it('includes all fields including id in output DTO field list', () => {
    const locals = buildCleanLitePsLocals(contactDefinition, EMPTY_BASE_LOCALS);

    const fieldNames = locals.clpOutputDtoFields.map((f: any) => f.name);

    // All entity fields appear (id is added via template literal, not in processedFields)
    expect(fieldNames).toContain('first_name');
    expect(fieldNames).toContain('last_name');
    expect(fieldNames).toContain('email');
    expect(fieldNames).toContain('title');
    // Behavior fields NOT in clpOutputDtoFields (they come from hasTimestamps/hasSoftDelete)
    // FK fields come from clpBelongsToFkFields
  });

  it('derives nullable correctly for fields with nullable: true', () => {
    const locals = buildCleanLitePsLocals(contactDefinition, EMPTY_BASE_LOCALS);

    const titleField = locals.clpCreateDtoFields.find((f: any) => f.name === 'title');
    expect(titleField).toBeDefined();
    expect(titleField!.nullable).toBe(true);
    expect(titleField!.zodChainCreate).toContain('.nullable()');

    const firstNameField = locals.clpCreateDtoFields.find((f: any) => f.name === 'first_name');
    expect(firstNameField).toBeDefined();
    expect(firstNameField!.nullable).toBe(false);
    expect(firstNameField!.zodChainCreate).not.toContain('.nullable()');
  });

  it('sets hasTimestamps and hasSoftDelete flags from behaviors', () => {
    const locals = buildCleanLitePsLocals(contactDefinition, EMPTY_BASE_LOCALS);

    expect(locals.hasTimestamps).toBe(true);
    expect(locals.hasSoftDelete).toBe(true);
  });

  it('sets hasTimestamps false when timestamps behavior absent', () => {
    const locals = buildCleanLitePsLocals(noFamilyDefinition, EMPTY_BASE_LOCALS);

    expect(locals.hasTimestamps).toBe(false);
    expect(locals.hasSoftDelete).toBe(false);
  });

  // ============================================================================
  // Declarative queries
  // ============================================================================

  it('processes declarative queries from queries block', () => {
    const withQueries = {
      ...contactDefinition,
      queries: [
        { by: ['user_id'] },
        { by: ['email'], unique: true },
        { by: ['account_id'], order: 'created_at desc' },
        { by: ['user_id', 'account_id'] },
      ],
    };
    const locals = buildCleanLitePsLocals(withQueries, EMPTY_BASE_LOCALS);

    expect(locals.hasDeclarativeQueries).toBe(true);
    expect(locals.processedQueries).toHaveLength(4);
    expect(locals.processedQueries[0].methodName).toBe('findByUserId');
    expect(locals.processedQueries[1].methodName).toBe('findByEmail');
    expect(locals.processedQueries[1].isUnique).toBe(true);
    expect(locals.processedQueries[1].returnType).toBe('Contact | null');
    expect(locals.processedQueries[2].hasOrder).toBe(true);
    expect(locals.processedQueries[2].orderBy).toBe('createdAt');
    expect(locals.processedQueries[2].orderDirection).toBe('desc');
    expect(locals.processedQueries[3].hasMultipleParams).toBe(true);
    expect(locals.processedQueries[3].methodName).toBe('findByUserIdAndAccountId');
  });

  it('processes via-table and select queries', () => {
    const withViaQueries = {
      ...contactDefinition,
      queries: [
        { by: ['opportunity_id'], via: 'opportunity_contact_link' },
        { by: ['opportunity_id'], select: ['email'], via: 'opportunity_contact_link' },
      ],
    };
    const locals = buildCleanLitePsLocals(withViaQueries, EMPTY_BASE_LOCALS);

    expect(locals.hasViaQuery).toBe(true);
    expect(locals.processedQueries[0].hasVia).toBe(true);
    expect(locals.processedQueries[0].viaTable).toBe('opportunity_contact_link');
    expect(locals.processedQueries[0].methodName).toBe('findByOpportunityId');
    expect(locals.processedQueries[1].hasSelect).toBe(true);
    expect(locals.processedQueries[1].methodName).toBe('findEmailsByOpportunityId');
  });

  it('generates entity-prefixed use case class names from queries', () => {
    const withQueries = {
      ...contactDefinition,
      queries: [{ by: ['user_id'] }, { by: ['email'], unique: true }],
    };
    const locals = buildCleanLitePsLocals(withQueries, EMPTY_BASE_LOCALS);

    // Names are prefixed with the entity to avoid collisions across modules
    // and read as English: "Find contact by user id".
    expect(locals.declarativeQueryClasses).toEqual([
      'FindContactByUserIdUseCase',
      'FindContactByEmailUseCase',
    ]);
  });

  it('generates entity-prefixed class names for composite queries', () => {
    const withQueries = {
      ...contactDefinition,
      queries: [{ by: ['user_id', 'account_id'] }],
    };
    const locals = buildCleanLitePsLocals(withQueries, EMPTY_BASE_LOCALS);

    expect(locals.declarativeQueryClasses).toEqual([
      'FindContactByUserIdAndAccountIdUseCase',
    ]);
    expect(locals.processedQueries[0].useCaseClassName).toBe(
      'FindContactByUserIdAndAccountIdUseCase',
    );
  });

  it('generates entity-prefixed class names for select + via queries', () => {
    const withQueries = {
      ...contactDefinition,
      queries: [
        { by: ['opportunity_id'], select: ['email'], via: 'opportunity_contact_link' },
      ],
    };
    const locals = buildCleanLitePsLocals(withQueries, EMPTY_BASE_LOCALS);

    // methodName 'findEmailsByOpportunityId' → 'FindContactEmailsByOpportunityIdUseCase'
    expect(locals.declarativeQueryClasses).toEqual([
      'FindContactEmailsByOpportunityIdUseCase',
    ]);
  });

  it('produces collision-free class names for different entities sharing a query', () => {
    const accountDef = {
      entity: { name: 'account', plural: 'accounts', table: 'accounts', family: 'synced' },
      fields: { domain: { type: 'string', required: true } },
      relationships: {},
      behaviors: [],
      queries: [{ by: ['domain'], unique: true }],
    };
    const opportunityDef = {
      entity: { name: 'opportunity', plural: 'opportunities', table: 'opportunities', family: 'synced' },
      fields: { domain: { type: 'string', required: true } },
      relationships: {},
      behaviors: [],
      queries: [{ by: ['domain'], unique: true }],
    };

    const accountLocals = buildCleanLitePsLocals(accountDef, EMPTY_BASE_LOCALS);
    const opportunityLocals = buildCleanLitePsLocals(opportunityDef, EMPTY_BASE_LOCALS);

    expect(accountLocals.declarativeQueryClasses).toEqual(['FindAccountByDomainUseCase']);
    expect(opportunityLocals.declarativeQueryClasses).toEqual(['FindOpportunityByDomainUseCase']);
    // Different entities must not produce colliding class names
    expect(accountLocals.declarativeQueryClasses[0]).not.toBe(
      opportunityLocals.declarativeQueryClasses[0],
    );
  });

  it('sets hasDeclarativeQueries false when no queries block', () => {
    const locals = buildCleanLitePsLocals(contactDefinition, EMPTY_BASE_LOCALS);

    expect(locals.hasDeclarativeQueries).toBe(false);
    expect(locals.processedQueries).toEqual([]);
    expect(locals.declarativeQueryClasses).toEqual([]);
  });

  it('includes declarativeQueries output path when queries exist', () => {
    const withQueries = {
      ...contactDefinition,
      queries: [{ by: ['user_id'] }],
    };
    const locals = buildCleanLitePsLocals(withQueries, EMPTY_BASE_LOCALS);

    expect(locals.clpOutputPaths.declarativeQueries).toBe(
      'modules/contacts/use-cases/declarative-queries.ts',
    );
  });

  it('sets declarativeQueries output path to null when no queries', () => {
    const locals = buildCleanLitePsLocals(contactDefinition, EMPTY_BASE_LOCALS);

    expect(locals.clpOutputPaths.declarativeQueries).toBeNull();
  });
});
