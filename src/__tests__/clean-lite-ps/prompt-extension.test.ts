/**
 * Unit tests for clean-lite-ps/prompt-extension.js
 */

import { describe, it, expect } from 'bun:test';
import {
  buildCleanLitePsLocals,
  createEntityLookup,
  identifierRef,
  resolveImpliedBehaviors,
} from '../../../templates/entity/new/clean-lite-ps/prompt-extension.js';

// Minimal base locals (the real version has many more fields, but we only need
// the shape to test the extension itself). `runtimeMode: 'vendored'` keeps the
// base-class import assertions on the `@shared/*` form the pattern library
// authors — i.e. these tests verify the vendored emission stays byte-identical
// (ADR-037). The package-mode rewrite has its own dedicated test below.
const EMPTY_BASE_LOCALS = { runtimeMode: 'vendored' };

// ============================================================================
// Contact entity definition matching test/fixtures/contact-v2.yaml
// ============================================================================

const contactDefinition = {
  entity: {
    name: 'contact',
    plural: 'contacts',
    table: 'contacts',
    pattern: 'Integrated',
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

// Entity without pattern key
const noFamilyDefinition = {
  entity: { name: 'task', plural: 'tasks', table: 'tasks' },
  fields: { title: { type: 'string', required: true } },
  relationships: {},
  behaviors: [],
};

// Activity pattern entity
const activityDefinition = {
  entity: { name: 'note', plural: 'notes', table: 'notes', pattern: 'Activity' },
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

  it('maps Integrated pattern to IntegratedEntityRepository and IntegratedEntityService', () => {
    const locals = buildCleanLitePsLocals(contactDefinition, EMPTY_BASE_LOCALS);

    expect(locals.patternName).toBe('Integrated');
    expect(locals.repositoryBaseClass).toBe('IntegratedEntityRepository');
    expect(locals.serviceBaseClass).toBe('IntegratedEntityService');
    expect(locals.repositoryBaseImport).toBe('@shared/base-classes/integrated-entity-repository');
    expect(locals.serviceBaseImport).toBe('@shared/base-classes/integrated-entity-service');
  });

  it('maps Activity pattern to ActivityEntityRepository and ActivityEntityService', () => {
    const locals = buildCleanLitePsLocals(activityDefinition, EMPTY_BASE_LOCALS);

    expect(locals.patternName).toBe('Activity');
    expect(locals.repositoryBaseClass).toBe('ActivityEntityRepository');
    expect(locals.serviceBaseClass).toBe('ActivityEntityService');
    expect(locals.repositoryBaseImport).toBe('@shared/base-classes/activity-entity-repository');
    expect(locals.serviceBaseImport).toBe('@shared/base-classes/activity-entity-service');
  });

  it('defaults to base when pattern key is absent', () => {
    const locals = buildCleanLitePsLocals(noFamilyDefinition, EMPTY_BASE_LOCALS);

    expect(locals.patternName).toBe('Base');
    expect(locals.repositoryBaseClass).toBe('BaseRepository');
    expect(locals.serviceBaseClass).toBe('BaseService');
    expect(locals.repositoryBaseImport).toBe('@shared/base-classes/base-repository');
    expect(locals.serviceBaseImport).toBe('@shared/base-classes/base-service');
  });

  it('generates correct output paths for entity with plural name', () => {
    const locals = buildCleanLitePsLocals(contactDefinition, EMPTY_BASE_LOCALS);

    expect(locals.clpOutputPaths.entity).toBe('src/modules/contacts/contact.entity.ts');
    expect(locals.clpOutputPaths.repository).toBe('src/modules/contacts/contact.repository.ts');
    expect(locals.clpOutputPaths.service).toBe('src/modules/contacts/contact.service.ts');
    expect(locals.clpOutputPaths.controller).toBe('src/modules/contacts/contact.controller.ts');
    expect(locals.clpOutputPaths.module).toBe('src/modules/contacts/contacts.module.ts');
    expect(locals.clpOutputPaths.findByIdUseCase).toBe('src/modules/contacts/use-cases/find-contact-by-id.use-case.ts');
    expect(locals.clpOutputPaths.listUseCase).toBe('src/modules/contacts/use-cases/list-contacts.use-case.ts');
    expect(locals.clpOutputPaths.createDto).toBe('src/modules/contacts/dto/create-contact.dto.ts');
    expect(locals.clpOutputPaths.updateDto).toBe('src/modules/contacts/dto/update-contact.dto.ts');
    expect(locals.clpOutputPaths.outputDto).toBe('src/modules/contacts/dto/contact-output.dto.ts');
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
    // nullable AND not required → must also be optional, so the create payload
    // can omit the key entirely (not forced to send an explicit null).
    expect(titleField!.zodChainCreate).toContain('.optional()');

    const firstNameField = locals.clpCreateDtoFields.find((f: any) => f.name === 'first_name');
    expect(firstNameField).toBeDefined();
    expect(firstNameField!.nullable).toBe(false);
    expect(firstNameField!.zodChainCreate).not.toContain('.nullable()');
    // required → neither nullable nor optional.
    expect(firstNameField!.zodChainCreate).not.toContain('.optional()');
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
      entity: { name: 'account', plural: 'accounts', table: 'accounts', pattern: 'Integrated' },
      fields: { domain: { type: 'string', required: true } },
      relationships: {},
      behaviors: [],
      queries: [{ by: ['domain'], unique: true }],
    };
    const opportunityDef = {
      entity: { name: 'opportunity', plural: 'opportunities', table: 'opportunities', pattern: 'Integrated' },
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
      'src/modules/contacts/use-cases/declarative-queries.ts',
    );
  });

  it('sets declarativeQueries output path to null when no queries', () => {
    const locals = buildCleanLitePsLocals(contactDefinition, EMPTY_BASE_LOCALS);

    expect(locals.clpOutputPaths.declarativeQueries).toBeNull();
  });

  it('uses custom srcRoot from baseLocals', () => {
    const locals = buildCleanLitePsLocals(contactDefinition, { srcRoot: 'app' });

    expect(locals.clpOutputPaths.entity).toBe('app/modules/contacts/contact.entity.ts');
    expect(locals.clpOutputPaths.service).toBe('app/modules/contacts/contact.service.ts');
  });

  it('uses src_root from entity definition', () => {
    const withSrcRoot = {
      ...contactDefinition,
      entity: { ...contactDefinition.entity, src_root: 'lib' },
    };
    const locals = buildCleanLitePsLocals(withSrcRoot, EMPTY_BASE_LOCALS);

    expect(locals.clpOutputPaths.entity).toBe('lib/modules/contacts/contact.entity.ts');
  });

  it('defaults srcRoot to src when not specified', () => {
    const locals = buildCleanLitePsLocals(contactDefinition, EMPTY_BASE_LOCALS);

    expect(locals.clpOutputPaths.entity).toStartWith('src/');
  });
});


// ============================================================================
// PATTERN-5 — registry-driven resolution + patternConfig emission
// ============================================================================

import { registerLibraryPattern, _resetRegistryForTests } from '../../patterns/registry.ts';
import { z } from 'zod';
import {
  LIBRARY_PATTERN_DEFINITIONS,
} from '../../patterns/library/index.ts';

describe('buildCleanLitePsLocals — PATTERN-5 registry integration', () => {
  it('exposes `patternName` verbatim from the pattern registry', () => {
    const locals = buildCleanLitePsLocals(contactDefinition, EMPTY_BASE_LOCALS);
    expect(locals.patternName).toBe('Integrated');
  });

  // ADR-041 §2 — positional selection is gone. Two inheritable bases is a hard
  // error at generation; before CAP-1 this quietly emitted the first one and
  // dropped the second pattern's entire contribution.
  it('two inheritable spine bases throw at generation', () => {
    const def = {
      entity: {
        name: 'deal',
        plural: 'deals',
        table: 'deals',
        patterns: ['Integrated', 'Activity'],
      },
      fields: {},
      relationships: {},
      behaviors: ['timestamps'],
    };
    expect(() => buildCleanLitePsLocals(def, EMPTY_BASE_LOCALS)).toThrow(
      /inheritable spine bases \(Integrated, Activity\)/,
    );
  });

  it('hasPatternConfig is false for patterns that declare no config', () => {
    const locals = buildCleanLitePsLocals(contactDefinition, EMPTY_BASE_LOCALS);
    expect(locals.hasPatternConfig).toBe(false);
    expect(locals.patternConfig).toBeNull();
  });

  it('hasPatternConfig is true + patternConfig populated when YAML supplies a config block', () => {
    // Register a synthetic pattern with a configSchema to drive the test.
    registerLibraryPattern({
      name: 'CrmEntityTest',
      repositoryClass: 'CrmEntityRepository',
      repositoryImport: '@/patterns/crm-entity.pattern',
      serviceClass: 'CrmEntityService',
      serviceImport: '@/patterns/crm-entity.pattern',
      repositoryInheritedMethods: [],
      serviceInheritedMethods: [],
      configSchema: z.object({ entityType: z.string() }),
    });

    const def = {
      entity: {
        name: 'opportunity',
        plural: 'opportunities',
        table: 'opportunities',
        pattern: 'CrmEntityTest',
      },
      fields: {},
      relationships: {},
      behaviors: [],
      config: { CrmEntityTest: { entityType: 'opportunity' } },
    };
    const locals = buildCleanLitePsLocals(def, EMPTY_BASE_LOCALS);
    expect(locals.hasPatternConfig).toBe(true);
    expect(locals.patternConfig).toEqual({ entityType: 'opportunity' });
    expect(locals.repositoryBaseClass).toBe('CrmEntityRepository');
    expect(locals.repositoryBaseImport).toBe('@/patterns/crm-entity.pattern');
    expect(locals.patternName).toBe('CrmEntityTest');
  });

  it('base-class output is byte-identical to the pre-PATTERN-5 FAMILY_MAP for library patterns', () => {
    // This test nails down the PATTERN-5 integration gate: the values
    // returned for library patterns must match what the old FAMILY_MAP
    // produced. Any future library-pattern edit that drifts the strings
    // will fail here, which is the desired alarm.
    const want = {
      integrated: {
        repositoryBaseClass: 'IntegratedEntityRepository',
        serviceBaseClass: 'IntegratedEntityService',
        repositoryBaseImport: '@shared/base-classes/integrated-entity-repository',
        serviceBaseImport: '@shared/base-classes/integrated-entity-service',
      },
      activity: {
        repositoryBaseClass: 'ActivityEntityRepository',
        serviceBaseClass: 'ActivityEntityService',
        repositoryBaseImport: '@shared/base-classes/activity-entity-repository',
        serviceBaseImport: '@shared/base-classes/activity-entity-service',
      },
      metadata: {
        repositoryBaseClass: 'MetadataEntityRepository',
        serviceBaseClass: 'MetadataEntityService',
        repositoryBaseImport: '@shared/base-classes/metadata-entity-repository',
        serviceBaseImport: '@shared/base-classes/metadata-entity-service',
      },
      knowledge: {
        repositoryBaseClass: 'KnowledgeEntityRepository',
        serviceBaseClass: 'KnowledgeEntityService',
        repositoryBaseImport: '@shared/base-classes/knowledge-entity-repository',
        serviceBaseImport: '@shared/base-classes/knowledge-entity-service',
      },
      base: {
        repositoryBaseClass: 'BaseRepository',
        serviceBaseClass: 'BaseService',
        repositoryBaseImport: '@shared/base-classes/base-repository',
        serviceBaseImport: '@shared/base-classes/base-service',
      },
    } as const;

    for (const [lowerName, expected] of Object.entries(want)) {
      const pascal = lowerName.charAt(0).toUpperCase() + lowerName.slice(1);
      const def = {
        entity: { name: 't', plural: 'ts', table: 'ts', pattern: pascal },
        fields: {},
        relationships: {},
        behaviors: [],
      };
      const locals = buildCleanLitePsLocals(def, EMPTY_BASE_LOCALS);
      expect(locals.repositoryBaseClass).toBe(expected.repositoryBaseClass);
      expect(locals.serviceBaseClass).toBe(expected.serviceBaseClass);
      expect(locals.repositoryBaseImport).toBe(expected.repositoryBaseImport);
      expect(locals.serviceBaseImport).toBe(expected.serviceBaseImport);
      expect(locals.patternName).toBe(pascal);
    }
  });

  it('package mode rewrites library base-class imports to @pattern-stack/codegen/runtime (ADR-037)', () => {
    const def = {
      entity: { name: 'contact', plural: 'contacts', table: 'contacts', pattern: 'Integrated' },
      fields: {},
      relationships: {},
      behaviors: [],
    };
    const locals = buildCleanLitePsLocals(def, { runtimeMode: 'package' });
    // Class names are unchanged; only the import specifier flips.
    expect(locals.repositoryBaseClass).toBe('IntegratedEntityRepository');
    expect(locals.repositoryBaseImport).toBe(
      '@pattern-stack/codegen/runtime/base-classes/integrated-entity-repository',
    );
    expect(locals.serviceBaseImport).toBe(
      '@pattern-stack/codegen/runtime/base-classes/integrated-entity-service',
    );
  });

  // ACTIVITY-SUBJECT-1 — Activity inherited-method strings are config-driven now.
  it('Activity advertises the config-driven subject finders (not the CRM names)', () => {
    const def = {
      entity: { name: 'meeting', plural: 'meetings', table: 'meetings', pattern: 'Activity' },
      fields: {},
      relationships: {},
      behaviors: [],
    };
    const locals = buildCleanLitePsLocals(def, EMPTY_BASE_LOCALS);
    const repoLines = (locals.repositoryInheritedMethods ?? []).join(' | ');
    const serviceLines = (locals.serviceInheritedMethods ?? []).join(' | ');
    expect(repoLines).toContain('findBySubjectId');
    expect(repoLines).toContain('findRecentBySubjectId');
    expect(repoLines).not.toContain('Opportunity');
    expect(serviceLines).not.toContain('Opportunity');
  });

  // ADR-041 §2 names `patterns: [Integrated, Activity]` as its worked example:
  // two config-bearing bases, and it fails "until one is authored as a
  // capability". What it used to do — emit `Integrated` and silently ignore the
  // `config: { Activity: ... }` block below, since `patternConfig` is looked up
  // under the SPINE's name — is the defect, not the contract.
  it('patterns: [Integrated, Activity] throws instead of silently dropping Activity', () => {
    const def = {
      entity: {
        name: 'message',
        plural: 'messages',
        table: 'messages',
        patterns: ['Integrated', 'Activity'],
      },
      fields: {},
      relationships: {},
      behaviors: ['timestamps'],
      config: { Activity: { subject: 'person' } },
    };
    expect(() => buildCleanLitePsLocals(def, EMPTY_BASE_LOCALS)).toThrow(
      /pattern composition failed for 'message'/,
    );
  });

  // The spine still resolves when only ONE pattern is inheritable, wherever it
  // sits — `Integrated` is second here, and its implied behavior + integration
  // write surface still land.
  it('a capability before the spine does not change the base class', () => {
    registerLibraryPattern({
      name: 'PeLead',
      kind: 'capability',
      mixin: 'WithPeLead',
      mixinImport: '@shared/base-classes/with-pe-lead',
      forwarderMethods: ['leads'],
    });
    const def = {
      entity: {
        name: 'message',
        plural: 'messages',
        table: 'messages',
        patterns: ['PeLead', 'Integrated'],
      },
      fields: {},
      relationships: {},
      behaviors: ['timestamps'],
    };
    const locals = buildCleanLitePsLocals(def, EMPTY_BASE_LOCALS);
    expect(locals.patternName).toBe('Integrated');
    expect(locals.repositoryBaseClass).toBe('IntegratedEntityRepository');
    expect(locals.hasExternalIdTracking).toBe(true);
    expect(locals.capabilityMixins.map((c) => c.name)).toEqual(['PeLead']);
  });
});

describe('impliedBehaviors fold — pattern-implied behaviors merge into emit', () => {
  // A pattern: Integrated entity with NO explicit external_id_tracking behavior.
  const integratedNoExplicitBehavior = {
    entity: { name: 'account', plural: 'accounts', table: 'accounts', pattern: 'Integrated' },
    fields: { name: { type: 'string', required: true } },
    relationships: {},
    behaviors: ['timestamps'],
  };

  it('resolveImpliedBehaviors returns external_id_tracking for pattern: Integrated', () => {
    expect(resolveImpliedBehaviors(integratedNoExplicitBehavior.entity)).toContain(
      'external_id_tracking',
    );
  });

  it('resolveImpliedBehaviors walks the patterns: [...] array form', () => {
    const multi = { name: 'deal', plural: 'deals', table: 'deals', patterns: ['Integrated'] };
    expect(resolveImpliedBehaviors(multi)).toContain('external_id_tracking');
  });

  it('resolveImpliedBehaviors returns [] for a pattern with no impliedBehaviors', () => {
    expect(resolveImpliedBehaviors({ name: 'task', plural: 'tasks', pattern: 'Base' })).toEqual([]);
  });

  it('a Integrated entity gets hasExternalIdTracking even without re-declaring the behavior', () => {
    const locals = buildCleanLitePsLocals(integratedNoExplicitBehavior, EMPTY_BASE_LOCALS);
    expect(locals.hasExternalIdTracking).toBe(true);
  });

  it('explicit external_id_tracking declaration stays a no-op (silent dedup)', () => {
    const explicit = {
      ...integratedNoExplicitBehavior,
      behaviors: ['timestamps', 'external_id_tracking'],
    };
    const implied = buildCleanLitePsLocals(integratedNoExplicitBehavior, EMPTY_BASE_LOCALS);
    const declared = buildCleanLitePsLocals(explicit, EMPTY_BASE_LOCALS);

    // Re-declaring the implied behavior must not change the resolved flag or
    // the Drizzle imports — explicit and implied paths converge.
    expect(declared.hasExternalIdTracking).toBe(true);
    expect(implied.hasExternalIdTracking).toBe(true);
    expect(declared.clpDrizzleImports).toEqual(implied.clpDrizzleImports);
  });

  it('a Base entity (no pattern) does NOT gain external_id_tracking', () => {
    const base = {
      entity: { name: 'task', plural: 'tasks', table: 'tasks', pattern: 'Base' },
      fields: { title: { type: 'string', required: true } },
      relationships: {},
      behaviors: [],
    };
    const locals = buildCleanLitePsLocals(base, EMPTY_BASE_LOCALS);
    expect(locals.hasExternalIdTracking).toBe(false);
  });
});

describe('renderPatternConfigLiteral — idiomatic TS literal emission', () => {
  // Import the helper through the same extension barrel the templates do.
  const mod = require('../../../templates/entity/new/clean-lite-ps/prompt-extension.js') as {
    buildCleanLitePsLocals: typeof buildCleanLitePsLocals;
  };
  // The helper is exposed via the locals object; grab it by rendering a
  // throwaway entity.
  const sampleLocals = mod.buildCleanLitePsLocals(
    {
      entity: { name: 'x', plural: 'xs', table: 'xs', pattern: 'Base' },
      fields: {},
      relationships: {},
      behaviors: [],
    },
    {},
  ) as { renderPatternConfigLiteral: (v: unknown) => string };
  const render = sampleLocals.renderPatternConfigLiteral;

  it('emits bare identifier keys + single-quoted strings', () => {
    expect(render({ entityType: 'opportunity' })).toBe(
      "{\n  entityType: 'opportunity',\n}",
    );
  });

  it('quotes keys that are not valid identifiers', () => {
    expect(render({ 'with-dash': 1 })).toBe("{\n  'with-dash': 1,\n}");
  });

  it('handles nested objects', () => {
    expect(
      render({
        states: { qualifying: ['developing', 'closed_lost'] },
        initial_state: 'qualifying',
      }),
    ).toBe(
      "{\n  states: {\n    qualifying: [\n      'developing',\n      'closed_lost',\n    ],\n  },\n  initial_state: 'qualifying',\n}",
    );
  });

  it('handles numbers, booleans, and nulls without quotes', () => {
    expect(render({ count: 3, active: true, note: null })).toBe(
      "{\n  count: 3,\n  active: true,\n  note: null,\n}",
    );
  });

  it('emits empty objects and arrays compactly', () => {
    expect(render({})).toBe('{}');
    expect(render({ arr: [] })).toBe("{\n  arr: [],\n}");
  });

  it('escapes single quotes within string values', () => {
    expect(render({ note: "it's" })).toBe("{\n  note: 'it\\'s',\n}");
  });
});

// Restore the canonical library registry after this file runs — several
// library patterns were registered above via `registerLibraryPattern` which
// would otherwise leak into the next test file in the Bun process.
import { afterAll as _afterAllForCleanup } from 'bun:test';
_afterAllForCleanup(() => {
  _resetRegistryForTests({ includeLibrary: true });
  for (const p of LIBRARY_PATTERN_DEFINITIONS) registerLibraryPattern(p);
});

// ============================================================================
// ADR-041 — capability composition emission
// ============================================================================

describe('capability composition emission (ADR-041)', () => {
  const registerCapabilities = (): void => {
    registerLibraryPattern({
      name: 'CeGroup',
      kind: 'capability',
      mixin: 'WithCeGroup',
      // Authored as a library capability would be, so the package-mode rewrite
      // below has something to act on.
      mixinImport: '@shared/base-classes/with-ce-group',
      forwarderMethods: ['members'],
    });
    registerLibraryPattern({
      name: 'CeIndividual',
      kind: 'capability',
      mixin: 'WithCeIndividual',
      mixinImport: '@shared/base-classes/with-ce-individual',
      forwarderMethods: ['principal'],
    });
    registerLibraryPattern({
      name: 'CeAudited',
      kind: 'capability',
      mixin: 'WithCeAudited',
      // An APP capability's alias — must survive both runtime modes untouched.
      mixinImport: '@modules/capabilities/with-audited',
      forwarderMethods: ['auditCount'],
    });
  };

  const entityWith = (patterns: string[], extra: Record<string, unknown> = {}) => ({
    entity: {
      name: 'account',
      plural: 'accounts',
      table: 'accounts',
      patterns,
      ...extra,
    },
    fields: { name: { type: 'string', required: true } },
    relationships: {},
    behaviors: ['timestamps'],
  });

  it('no capability → the extends clause is exactly the pre-CAP-1 string', () => {
    registerCapabilities();
    const locals = buildCleanLitePsLocals(entityWith([]), EMPTY_BASE_LOCALS);
    expect(locals.repositoryExtendsClause).toBe('BaseRepository<Account, typeof accounts>');
    expect(locals.composedBaseClass).toBeNull();
    expect(locals.clpOutputPaths.composedBase).toBeNull();
    expect(locals.capabilityMixins).toEqual([]);
    expect(locals.capabilityForwarders).toEqual([]);
  });

  it('one capability → inline wrap, still no composed-base file', () => {
    registerCapabilities();
    const locals = buildCleanLitePsLocals(entityWith(['CeGroup']), EMPTY_BASE_LOCALS);
    expect(locals.repositoryExtendsClause).toBe(
      'WithCeGroup(BaseRepository<Account, typeof accounts>)',
    );
    expect(locals.composedBaseClass).toBeNull();
    expect(locals.clpOutputPaths.composedBase).toBeNull();
  });

  it('two or more capabilities → a composed-base file, rightmost outermost', () => {
    registerCapabilities();
    const locals = buildCleanLitePsLocals(
      entityWith(['CeGroup', 'CeIndividual', 'CeAudited']),
      EMPTY_BASE_LOCALS,
    );
    expect(locals.composedBaseClass).toBe('AccountComposedBase');
    expect(locals.composedBaseImport).toBe('./account.composed-base');
    expect(locals.clpOutputPaths.composedBase).toMatch(
      /modules\/accounts\/account\.composed-base\.ts$/,
    );
    // The repository extends the generated base; the chain lives in that file.
    expect(locals.repositoryExtendsClause).toBe('AccountComposedBase');
    expect(locals.composedBaseExtendsClause).toBe(
      'WithCeAudited(WithCeIndividual(WithCeGroup(BaseRepository<Account, typeof accounts>)))',
    );
  });

  it('the Integrated spine keeps its four-argument multi-line form inside the chain', () => {
    registerCapabilities();
    const locals = buildCleanLitePsLocals(
      entityWith(['CeGroup', 'Integrated', 'CeIndividual']),
      EMPTY_BASE_LOCALS,
    );
    expect(locals.patternName).toBe('Integrated');
    expect(locals.composedBaseExtendsClause).toBe(
      [
        'WithCeIndividual(',
        '  WithCeGroup(',
        '    IntegratedEntityRepository<',
        '      Account,',
        '      typeof accounts,',
        '      AccountIntegrationWrite,',
        '      AccountIntegrationProjection',
        '    >,',
        '  ),',
        ')',
      ].join('\n'),
    );
  });

  it('forwarders carry the contributing capability, in declaration order', () => {
    registerCapabilities();
    const locals = buildCleanLitePsLocals(
      entityWith(['CeGroup', 'CeIndividual', 'CeAudited']),
      EMPTY_BASE_LOCALS,
    );
    expect(locals.capabilityForwarders).toEqual([
      { capability: 'CeGroup', method: 'members' },
      { capability: 'CeIndividual', method: 'principal' },
      { capability: 'CeAudited', method: 'auditCount' },
    ]);
  });

  it('a library capability mixinImport is rewritten per runtime mode; an app alias is not', () => {
    registerCapabilities();
    const vendored = buildCleanLitePsLocals(
      entityWith(['CeGroup', 'CeAudited']),
      { runtimeMode: 'vendored' },
    );
    expect(vendored.capabilityMixins.map((c) => c.importPath)).toEqual([
      '@shared/base-classes/with-ce-group',
      '@modules/capabilities/with-audited',
    ]);

    const pkg = buildCleanLitePsLocals(entityWith(['CeGroup', 'CeAudited']), {
      runtimeMode: 'package',
    });
    expect(pkg.capabilityMixins.map((c) => c.importPath)).toEqual([
      '@pattern-stack/codegen/runtime/base-classes/with-ce-group',
      // An app capability's own alias is NOT a package path — untouched.
      '@modules/capabilities/with-audited',
    ]);
  });

  it('per-capability config resolves to `<camelName>Config` by default', () => {
    registerLibraryPattern({
      name: 'CeConfigured',
      kind: 'capability',
      mixin: 'WithCeConfigured',
      mixinImport: '@shared/base-classes/with-ce-configured',
    });
    const locals = buildCleanLitePsLocals(
      entityWith(['CeConfigured'], { config: { CeConfigured: { membersColumn: 'status' } } }),
      EMPTY_BASE_LOCALS,
    );
    const cap = locals.capabilityMixins[0];
    expect(cap.configProperty).toBe('ceConfiguredConfig');
    expect(cap.hasConfig).toBe(true);
    expect(cap.config).toEqual({ membersColumn: 'status' });
  });

  it('an explicit `configProperty` wins, and no config block means nothing is emitted', () => {
    registerLibraryPattern({
      name: 'CeNamed',
      kind: 'capability',
      mixin: 'WithCeNamed',
      mixinImport: '@shared/base-classes/with-ce-named',
      configProperty: 'actorConfig',
    });
    const locals = buildCleanLitePsLocals(entityWith(['CeNamed']), EMPTY_BASE_LOCALS);
    expect(locals.capabilityMixins[0].configProperty).toBe('actorConfig');
    expect(locals.capabilityMixins[0].hasConfig).toBe(false);
  });

  it('a capability method colliding with a `queries:` method throws at generation', () => {
    registerLibraryPattern({
      name: 'CeColliding',
      kind: 'capability',
      mixin: 'WithCeColliding',
      mixinImport: '@shared/base-classes/with-ce-colliding',
      forwarderMethods: ['findByName'],
    });
    const def = {
      ...entityWith(['CeColliding']),
      queries: [{ by: ['name'] }],
    };
    expect(() => buildCleanLitePsLocals(def, EMPTY_BASE_LOCALS)).toThrow(
      /Method 'findByName' is contributed by capability 'CeColliding'/,
    );
  });
});

// ============================================================================
// CAP-2 — role-derived belongs_to rides the existing FK path
// ============================================================================

describe('roles: → belongs_to emission (CAP-2)', () => {
  // prompt.js merges derived relationships before calling the extension; this
  // reproduces that merge with the same shared function.
  const withRoles = async (roles: Record<string, unknown>, fields: Record<string, unknown> = {}) => {
    const { deriveRoleRelationships } = await import('../../roles/derive.ts');
    return {
      entity: { name: 'meeting', plural: 'meetings', table: 'meetings' },
      fields: { title: { type: 'string', required: true }, ...fields },
      relationships: { ...deriveRoleRelationships(roles as never) },
      behaviors: ['timestamps'],
    };
  };

  it('a one-role emits its FK column, keyed by the ROLE, indexed by default', async () => {
    const locals = buildCleanLitePsLocals(
      await withRoles({ host: { target: 'contact', cardinality: 'one' } }),
      EMPTY_BASE_LOCALS,
    );
    const host = locals.clpBelongsTo.find((r: { field: string }) => r.field === 'host_contact_id');
    expect(host).toBeDefined();
    expect(host.relationKey).toBe('host');
    expect(host.role).toBe('host');
    expect(host.hasIndex).toBe(true);
    expect(host.onDelete).toBe('restrict');
    expect(host.nullable).toBe(true);
    expect(
      locals.clpTableConstraints.map((c: { expr: string }) => c.expr),
    ).toContain("index('meetings_host_contact_id_idx').on(t.hostContactId)");
  });

  it('two one-roles to the same target get two distinct relation keys', async () => {
    const locals = buildCleanLitePsLocals(
      await withRoles({
        host: { target: 'contact', cardinality: 'one' },
        organizer: { target: 'contact', cardinality: 'one' },
      }),
      EMPTY_BASE_LOCALS,
    );
    expect(locals.clpBelongsTo.map((r: { relationKey: string }) => r.relationKey).sort()).toEqual([
      'host',
      'organizer',
    ]);
  });

  it('declaring the FK field explicitly still controls required + index', async () => {
    const locals = buildCleanLitePsLocals(
      await withRoles(
        { host: { target: 'contact', cardinality: 'one' } },
        { host_contact_id: { type: 'uuid', required: true } },
      ),
      EMPTY_BASE_LOCALS,
    );
    const host = locals.clpBelongsTo.find((r: { field: string }) => r.field === 'host_contact_id');
    expect(host.nullable).toBe(false);
    // The field is declared without `index: true`, so the author has opted out.
    expect(host.hasIndex).toBe(false);
    // And the FK column is not emitted twice as a plain field.
    expect(
      locals.clpProcessedFields.some((f: { name: string }) => f.name === 'host_contact_id'),
    ).toBe(false);
  });

  it('role nullable: wins over the FK field required: — the same precedence as a declared belongs_to', async () => {
    const roleLocals = buildCleanLitePsLocals(
      await withRoles(
        { host: { target: 'contact', cardinality: 'one', nullable: true } },
        { host_contact_id: { type: 'uuid', required: true } },
      ),
      EMPTY_BASE_LOCALS,
    );
    const declaredLocals = buildCleanLitePsLocals(
      {
        entity: { name: 'meeting', plural: 'meetings', table: 'meetings' },
        fields: { host_contact_id: { type: 'uuid', required: true } },
        relationships: {
          host: { type: 'belongs_to', target: 'contact', foreign_key: 'host_contact_id', nullable: true },
        },
        behaviors: [],
      },
      EMPTY_BASE_LOCALS,
    );
    const role = roleLocals.clpBelongsTo.find((r: { field: string }) => r.field === 'host_contact_id');
    const declared = declaredLocals.clpBelongsTo.find((r: { field: string }) => r.field === 'host_contact_id');
    expect(role.nullable).toBe(true);
    // One rule, two entry points: the role and the equivalent declared
    // relationship resolve identically.
    expect(role.nullable).toBe(declared.nullable);
  });

  it('a declared (non-role) relationship keeps its target-derived key', () => {
    const locals = buildCleanLitePsLocals(
      {
        entity: { name: 'contact', plural: 'contacts', table: 'contacts' },
        fields: {},
        relationships: { account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' } },
        behaviors: [],
      },
      EMPTY_BASE_LOCALS,
    );
    expect(locals.clpBelongsTo[0].relationKey).toBe('account');
    expect(locals.clpBelongsTo[0].role).toBeNull();
    expect(locals.clpBelongsTo[0].hasIndex).toBe(false);
  });
});

// ============================================================================
// CAP-3 — library Actor / Communication configs are RESOLVED, not copied
// ============================================================================

describe('library capability configs (CAP-3, ADR-041.1)', () => {
  const restoreLibrary = () => {
    _resetRegistryForTests({ includeLibrary: true });
    for (const p of LIBRARY_PATTERN_DEFINITIONS) registerLibraryPattern(p);
  };

  const meeting = async (entityExtra: Record<string, unknown> = {}) => {
    const { deriveRoleRelationships } = await import('../../roles/derive.ts');
    const roles = {
      host: { target: 'contact', cardinality: 'one', column: 'host_contact_id' },
      attendees: { target: 'contact', cardinality: 'many', via: 'meeting_contact' },
      about: { target: 'account', cardinality: 'one' },
    };
    return {
      entity: {
        name: 'meeting',
        plural: 'meetings',
        table: 'meetings',
        patterns: ['Activity', 'Communication'],
        ...entityExtra,
      },
      fields: { title: { type: 'string', required: true } },
      roles,
      relationships: { ...deriveRoleRelationships(roles as never) },
      behaviors: ['timestamps'],
    };
  };

  const account = (actor: unknown, relationships: Record<string, unknown> = {}) => ({
    entity: {
      name: 'account',
      plural: 'accounts',
      table: 'accounts',
      patterns: ['Actor'],
      ...(actor === undefined ? {} : { config: { Actor: actor } }),
    },
    fields: { name: { type: 'string', required: true } },
    relationships,
    behaviors: [],
  });

  const hasManyContacts = {
    contacts: { type: 'has_many', target: 'contact', foreign_key: 'account_id' },
  };

  // What prompt.js passes: other entities' own `entity:` blocks, by name.
  const lookupOf = (...blocks: Array<Record<string, unknown>>) => (name: string) =>
    blocks.find((b) => b.name === name) ?? null;
  const withLookup = (...blocks: Array<Record<string, unknown>>) => ({
    ...EMPTY_BASE_LOCALS,
    entityLookup: lookupOf(...blocks),
  });

  const configOf = (locals: { capabilityMixins: Array<{ name: string; config: unknown }> }, name: string) =>
    locals.capabilityMixins.find((c) => c.name === name)?.config;

  it('Communication: config generated from roles: — one-roles reuse the derived FK, many-roles the junction', async () => {
    restoreLibrary();
    const locals = buildCleanLitePsLocals(await meeting(), EMPTY_BASE_LOCALS);
    expect(configOf(locals, 'Communication')).toEqual({
      roles: {
        host: { cardinality: 'one', target: 'contact', column: 'hostContactId' },
        attendees: {
          cardinality: 'many',
          target: 'contact',
          via: { table: identifierRef('meetingContacts'), self: 'meetingId', target: 'contactId' },
        },
        about: { cardinality: 'one', target: 'account', column: 'aboutAccountId' },
      },
    });
    expect(locals.capabilityMixins[0].hasConfig).toBe(true);
    expect(locals.capabilityConfigImports).toEqual([
      { name: 'meetingContacts', importPath: '../meeting_contacts/meeting_contact.entity' },
    ]);
  });

  it('Communication: the junction import is relative to a context-nested repository', async () => {
    restoreLibrary();
    const locals = buildCleanLitePsLocals(await meeting({ context: 'engagement' }), EMPTY_BASE_LOCALS);
    expect(locals.capabilityConfigImports).toEqual([
      { name: 'meetingContacts', importPath: '../../meeting_contacts/meeting_contact.entity' },
    ]);
  });

  it('Communication: the rendered literal writes the table handle as an identifier', async () => {
    restoreLibrary();
    const locals = buildCleanLitePsLocals(await meeting(), EMPTY_BASE_LOCALS);
    const rendered = locals.renderPatternConfigLiteral(configOf(locals, 'Communication'), '  ', '  ');
    expect(rendered).toContain('table: meetingContacts,');
    expect(rendered).not.toContain("'meetingContacts'");
  });

  it('Actor individual → { kind: individual }, no import', () => {
    restoreLibrary();
    const locals = buildCleanLitePsLocals(account({ kind: 'individual' }), EMPTY_BASE_LOCALS);
    expect(configOf(locals, 'Actor')).toEqual({ kind: 'individual' });
    expect(locals.capabilityConfigImports).toEqual([]);
  });

  it('Actor group → members resolved from the named has_many', () => {
    restoreLibrary();
    const locals = buildCleanLitePsLocals(
      account({ kind: 'group', members: 'contacts' }, hasManyContacts),
      withLookup({ name: 'contact', plural: 'contacts' }),
    );
    expect(configOf(locals, 'Actor')).toEqual({
      kind: 'group',
      members: { table: identifierRef('contacts'), foreignKey: 'accountId' },
    });
    expect(locals.capabilityConfigImports).toEqual([
      { name: 'contacts', importPath: '../contacts/contact.entity' },
    ]);
  });

  it("Actor group → the member's irregular plural: comes from ITS YAML, never re-pluralized", () => {
    restoreLibrary();
    const locals = buildCleanLitePsLocals(
      account(
        { kind: 'group', members: 'staff' },
        { staff: { type: 'has_many', target: 'person', foreign_key: 'account_id' } },
      ),
      // pluralize('person') is 'people' too — so declare something it would never produce.
      withLookup({ name: 'person', plural: 'personnel' }),
    );
    expect(configOf(locals, 'Actor')).toEqual({
      kind: 'group',
      members: { table: identifierRef('personnel'), foreignKey: 'accountId' },
    });
    expect(locals.capabilityConfigImports).toEqual([
      { name: 'personnel', importPath: '../personnel/person.entity' },
    ]);
  });

  it("Actor group → a context-nested member entity's module folder comes from its YAML", () => {
    restoreLibrary();
    const locals = buildCleanLitePsLocals(
      account({ kind: 'group', members: 'contacts' }, hasManyContacts),
      withLookup({ name: 'contact', plural: 'contacts', context: 'crm' }),
    );
    expect(locals.capabilityConfigImports).toEqual([
      { name: 'contacts', importPath: '../crm/contacts/contact.entity' },
    ]);
  });

  it('Actor group whose member entity has no YAML is a generation error', () => {
    restoreLibrary();
    expect(() =>
      buildCleanLitePsLocals(
        account({ kind: 'group', members: 'contacts' }, hasManyContacts),
        withLookup(),
      ),
    ).toThrow(/targets 'contact', which has no entity YAML/);
  });

  it('Actor group over a self-referential has_many uses its own table and adds no import', () => {
    restoreLibrary();
    const locals = buildCleanLitePsLocals(
      account(
        { kind: 'group', members: 'subsidiaries' },
        { subsidiaries: { type: 'has_many', target: 'account', foreign_key: 'parent_account_id' } },
      ),
      withLookup(),
    );
    expect(configOf(locals, 'Actor')).toEqual({
      kind: 'group',
      members: { table: identifierRef('accounts'), foreignKey: 'parentAccountId' },
    });
    // The repository already imports `accounts` from './account.entity' — a
    // second import would be TS2300.
    expect(locals.capabilityConfigImports).toEqual([]);
  });

  it("an app config value shaped like the old marker is rendered as data, not code", () => {
    restoreLibrary();
    const locals = buildCleanLitePsLocals(account({ kind: 'individual' }), EMPTY_BASE_LOCALS);
    expect(locals.renderPatternConfigLiteral({ $identifier: 'process.exit()' }, '  ', '')).toBe(
      "{\n  $identifier: 'process.exit()',\n}",
    );
  });

  it('Actor without config is a generation error', () => {
    restoreLibrary();
    expect(() => buildCleanLitePsLocals(account(undefined), EMPTY_BASE_LOCALS)).toThrow(
      /declares the 'Actor' capability, whose config is required/,
    );
  });

  it('Actor group whose members: is not a has_many is a generation error', () => {
    restoreLibrary();
    expect(() =>
      buildCleanLitePsLocals(account({ kind: 'group', members: 'contacts' }), EMPTY_BASE_LOCALS),
    ).toThrow(/members: 'contacts' must name one of its has_many relationships/);
    expect(() =>
      buildCleanLitePsLocals(
        account(
          { kind: 'group', members: 'owner' },
          { owner: { type: 'belongs_to', target: 'contact', foreign_key: 'owner_id' } },
        ),
        EMPTY_BASE_LOCALS,
      ),
    ).toThrow(/members: 'owner' must name one of its has_many relationships/);
  });

  it('an app capability config is still copied verbatim (CAP-1 hand-off unchanged)', () => {
    restoreLibrary();
    registerLibraryPattern({
      name: 'CeVerbatim',
      kind: 'capability',
      mixin: 'WithCeVerbatim',
      mixinImport: '@modules/capabilities/with-ce-verbatim',
      configSchema: z.object({ column: z.string() }),
    });
    const locals = buildCleanLitePsLocals(
      {
        entity: {
          name: 'note',
          plural: 'notes',
          table: 'notes',
          patterns: ['CeVerbatim'],
          config: { CeVerbatim: { column: 'status' } },
        },
        fields: {},
        relationships: {},
        behaviors: [],
      },
      EMPTY_BASE_LOCALS,
    );
    expect(configOf(locals, 'CeVerbatim')).toEqual({ column: 'status' });
    restoreLibrary();
  });
});

describe('createEntityLookup (ADR-041.1 cross-entity facts)', () => {
  it("reads another entity's own entity: block from the entities directory, recursively", async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-lookup-'));
    fs.mkdirSync(path.join(dir, 'people'));
    fs.writeFileSync(
      path.join(dir, 'people', 'person.yaml'),
      'entity:\n  name: person\n  plural: personnel\n  context: hr\n',
    );
    fs.writeFileSync(path.join(dir, 'broken.yaml'), 'entity: [unclosed');
    const lookup = createEntityLookup(dir);
    expect(lookup('person')).toEqual({ name: 'person', plural: 'personnel', context: 'hr' });
    expect(lookup('nobody')).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
