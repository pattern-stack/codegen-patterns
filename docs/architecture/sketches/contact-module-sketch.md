# Sketch — Contact Module in v2 Shape

**Purpose:** This is the concrete "picture that makes everything real" — what a single domain module looks like end-to-end under the v2 architecture. Contact is chosen as the pilot because it has the smallest surface area (no EAV, no complex sync, minimal use cases) while still exercising every layer. When you read this and it feels right, the ADRs have landed.

**Scope:** This is a design sketch, not production code. Types and signatures are illustrative. The goal is layout, layering, and the flow of calls — not exhaustive implementation details.

**Assumptions:**
- All base classes from ADR-005 exist (`BaseRepository`, `CrmEntityRepository`, `BaseService`, `CrmEntityService`, `BaseAnalyticsService`, `WithAnalytics` mixin)
- Subsystems are stood up (`Cache`, `Events`, `Jobs`, `Integrations`)
- Canonical schemas exist (`modules/canonical/contact/`)
- Hexagonal port for CRM sync exists (`subsystems/integrations/ports/crm-sync.port.ts`)
- Codegen emits this shape from `modules/canonical/contact/contact.canonical.yaml`

---

## Directory Tree

```
modules/
  contacts/
    contact.entity.ts              ← Drizzle table + TS type
    contact.repository.ts          ← Extends CrmEntityRepository<Contact>
    contact.service.ts             ← Extends CrmEntityService, adds domain methods
    contact.controller.ts          ← Thin REST adapter
    contacts.module.ts             ← NestJS wiring
    dto/
      create-contact.dto.ts
      update-contact.dto.ts
      contact-output.dto.ts
      contact-search.dto.ts
    use-cases/
      new-contact.use-case.ts         ← CreateContact-with-CRM-sync workflow
      merge-contacts.use-case.ts      ← Cross-record orchestration
      mark-as-champion.use-case.ts    ← Domain-specific workflow
      link-to-opportunity.use-case.ts ← Cross-domain write
    tests/
      contact.service.spec.ts         ← Integration (real DB, no mocks)
      new-contact.use-case.spec.ts    ← Integration (real DB, mocked CRM port)
      merge-contacts.use-case.spec.ts
      contact.e2e.spec.ts             ← HTTP-level E2E
```

Every file lives under one directory. No jumping around the tree.

---

## `contact.entity.ts`

Drizzle table + domain type collocated. This is the same pattern Clean-Lite uses.

```ts
import { pgTable, text, timestamp, uuid, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations, type InferSelectModel } from 'drizzle-orm';
import { accounts } from '../accounts/account.entity';
import { users } from '../users/user.entity';

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id),
    accountId: uuid('account_id').references(() => accounts.id),

    // Canonical fields (from modules/canonical/contact/contact.canonical.yaml)
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    email: text('email').notNull(),
    title: text('title'),
    phone: text('phone'),
    linkedinUrl: text('linkedin_url'),

    // CRM sync fields (inherited pattern via codegen)
    externalId: text('external_id'),
    provider: text('provider'),
    providerMetadata: text('provider_metadata'),

    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    externalIdIdx: uniqueIndex('contacts_external_id_idx').on(t.userId, t.externalId, t.provider),
  }),
);

export const contactsRelations = relations(contacts, ({ one }) => ({
  account: one(accounts, { fields: [contacts.accountId], references: [accounts.id] }),
  user: one(users, { fields: [contacts.userId], references: [users.id] }),
}));

export type Contact = InferSelectModel<typeof contacts>;
export type ContactInsert = typeof contacts.$inferInsert;
```

No separate "domain entity class." The Drizzle type IS the entity type. A `Contact` value object lives wherever you need it. This is Clean-Lite's merged schema+domain pattern and it is fine.

---

## `contact.repository.ts`

Extends `CrmEntityRepository<Contact>`. Inherits standard CRUD + CRM sync methods. Adds contact-specific queries only.

```ts
import { Injectable, Inject } from '@nestjs/common';
import { DRIZZLE } from '@shared/constants/tokens';
import type { DrizzleClient } from '@shared/types/drizzle';
import { eq, inArray, and, sql } from 'drizzle-orm';
import { CrmEntityRepository } from '@shared/base-classes/crm-entity-repository';
import { contacts, type Contact } from './contact.entity';

@Injectable()
export class ContactRepository extends CrmEntityRepository<Contact> {
  readonly table = contacts;

  constructor(@Inject(DRIZZLE) db: DrizzleClient) {
    super(db);
  }

  // Inherited from CrmEntityRepository (no hand-written code):
  //   findById, findByIds, findByExternalId, findManyByExternalIds,
  //   findAllByUserId, findVisibleByUserId, syncUpsert,
  //   create, update, delete, upsertMany, list, count, exists

  // Contact-specific methods only:

  async findManyByEmails(emails: string[], userId: string): Promise<Contact[]> {
    return this.db.select().from(contacts).where(
      and(eq(contacts.userId, userId), inArray(contacts.email, emails)),
    );
  }

  async findEmailsByOpportunityId(opportunityId: string): Promise<string[]> {
    // Cross-domain READ — allowed under ADR-004
    const rows = await this.db.execute<{ email: string }>(sql`
      SELECT DISTINCT c.email
      FROM contacts c
      INNER JOIN opportunity_contact_link ocl ON ocl.contact_id = c.id
      WHERE ocl.opportunity_id = ${opportunityId}
    `);
    return rows.map((r) => r.email);
  }

  async findOpportunityIdsByEmailsGrouped(
    emails: string[],
    userId: string,
  ): Promise<Map<string, string[]>> {
    // Returns email → [opportunityIds...]
    // Used by the meeting attendee → deal matching flow
    // ...implementation...
  }
}
```

Compare to today's `ContactRepository`: roughly 200 lines of hand-written CRUD + entity-specific methods. The v2 version is ~60 lines because CRUD and CRM sync are inherited.

---

## `contact.service.ts`

Extends `CrmEntityService` with the analytics mixin. Inherits standard reads. Adds canonical field helpers and domain methods.

```ts
import { Injectable } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/base-analytics-service';
import { CrmEntityService } from '@shared/base-classes/crm-entity-service';
import { ContactRepository } from './contact.repository';
import type { Contact } from './contact.entity';
import type { ContactOutputDto } from './dto/contact-output.dto';

@Injectable()
export class ContactService extends WithAnalytics(
  CrmEntityService<ContactRepository, Contact>,
) {
  constructor(protected readonly repository: ContactRepository) {
    super();
  }

  // Inherited from CrmEntityService (no hand-written code):
  //   findById, findByExternalId, findAllByUser, findVisibleByUser,
  //   getFieldValues, getFieldHistory, create, update, delete, list, count

  // Inherited from WithAnalytics mixin:
  //   measures.count, measures.newThisPeriod, etc. (defined in contact.semantics.yaml)

  // Contact-specific reads:

  async findByEmails(emails: string[], userId: string): Promise<Contact[]> {
    return this.repository.findManyByEmails(emails, userId);
  }

  async findByOpportunity(opportunityId: string): Promise<Contact[]> {
    // Cross-domain read is allowed — uses the junction table via repository helper
    return this.repository.findByOpportunityId(opportunityId);
  }

  // Canonical field helper: always exposes the contact with canonical shape
  async getOverview(id: string): Promise<ContactOutputDto> {
    const contact = await this.findById(id);
    // Join account name (cross-domain READ allowed — ADR-004)
    const accountName = contact.accountId
      ? await this.accountRepository.findById(contact.accountId).then((a) => a?.name ?? null)
      : null;

    return {
      id: contact.id,
      fullName: `${contact.firstName} ${contact.lastName}`,
      email: contact.email,
      title: contact.title,
      accountName,
      linkedinUrl: contact.linkedinUrl,
    };
  }

  // Contact-specific writes (OWN-DOMAIN ONLY per ADR-004):

  async updateTitle(id: string, title: string): Promise<Contact> {
    return this.repository.update(id, { title });
  }

  async updatePrimaryContactStatus(id: string, isPrimary: boolean): Promise<Contact> {
    // Writes to contacts only; cross-domain update of opportunity.primary_contact_id
    // would happen in a use case that composes this with OpportunityService.
    return this.repository.update(id, { isPrimary });
  }
}
```

**Note what isn't here:**
- No event emission (`this.events.emit(...)`) — services don't emit events (ADR-003)
- No CRM sync call — `syncUpsert` is inherited but used by a use case, not called from service methods
- No cross-domain writes — `accountRepository.update(...)` would be a lint failure

Services are thin, testable, and focused. ~80 lines.

---

## `contact.controller.ts`

Thin REST adapter. Pure reads call service methods directly (ADR-003 CQRS-lite shortcut). Writes call use cases.

```ts
import { Controller, Get, Post, Put, Param, Body } from '@nestjs/common';
import { ContactService } from './contact.service';
import { NewContactUseCase } from './use-cases/new-contact.use-case';
import { MergeContactsUseCase } from './use-cases/merge-contacts.use-case';
import { MarkAsChampionUseCase } from './use-cases/mark-as-champion.use-case';
import { CreateContactDto } from './dto/create-contact.dto';
import { ContactOutputDto } from './dto/contact-output.dto';
import type { Contact } from './contact.entity';

@Controller('contacts')
export class ContactController {
  constructor(
    // Reads shortcut to service (ADR-003)
    private readonly contacts: ContactService,
    // Writes go through use cases
    private readonly newContact: NewContactUseCase,
    private readonly mergeContacts: MergeContactsUseCase,
    private readonly markAsChampion: MarkAsChampionUseCase,
  ) {}

  // READS — direct to service

  @Get(':id')
  async getById(@Param('id') id: string): Promise<ContactOutputDto> {
    return this.contacts.getOverview(id);
  }

  @Get()
  async list(): Promise<Contact[]> {
    return this.contacts.findAllByUser(/* userId from auth */);
  }

  // WRITES — through use cases

  @Post()
  async create(@Body() dto: CreateContactDto): Promise<Contact> {
    return this.newContact.execute(dto);
  }

  @Put(':id/merge/:targetId')
  async merge(@Param('id') id: string, @Param('targetId') targetId: string): Promise<Contact> {
    return this.mergeContacts.execute({ sourceId: id, targetId });
  }

  @Put(':id/champion')
  async markChampion(@Param('id') id: string): Promise<Contact> {
    return this.markAsChampion.execute({ contactId: id });
  }
}
```

Lint rule: controllers can only import `*.service.ts` and `*.use-case.ts` files. Not repositories. Not the database. The rule is enforced by filename patterns.

---

## `use-cases/new-contact.use-case.ts`

Business workflow with side effects. This is what a use case should look like: multiple services, event emission, external port invocation, all coordinated.

```ts
import { Injectable } from '@nestjs/common';
import { ContactService } from '../contact.service';
import { AccountService } from '../../accounts/account.service';
import { EventBus } from '@subsystems/events/event-bus';
import { CrmSyncPort } from '@subsystems/integrations/ports/crm-sync.port';
import type { CreateContactDto } from '../dto/create-contact.dto';
import type { Contact } from '../contact.entity';

@Injectable()
export class NewContactUseCase {
  constructor(
    private readonly contacts: ContactService,
    private readonly accounts: AccountService,
    private readonly events: EventBus,
    private readonly crmSync: CrmSyncPort,
  ) {}

  async execute(dto: CreateContactDto): Promise<Contact> {
    // 1. Resolve or create account (cross-domain READ, then conditional write via AccountService)
    let accountId = dto.accountId;
    if (!accountId && dto.companyDomain) {
      const existing = await this.accounts.findByDomain(dto.companyDomain);
      accountId = existing?.id ?? (await this.accounts.create({ domain: dto.companyDomain })).id;
    }

    // 2. Create the contact within its own domain
    const contact = await this.contacts.create({ ...dto, accountId });

    // 3. Sync to CRM via hexagonal port (ADR-009)
    await this.crmSync.upsertContact(contact);

    // 4. Emit domain event
    await this.events.emit('contact.created', {
      contactId: contact.id,
      accountId,
      createdBy: dto.userId,
    });

    return contact;
  }
}
```

Note:
- **Two services composed** (`ContactService`, `AccountService`) — cross-domain orchestration belongs here
- **Port invocation** (`CrmSyncPort`) — external system access is a use case concern
- **Event emission** — side effects live in use cases
- **No SQL, no ORM code** — use cases never touch the database directly

The file is ~40 lines. Easy to read, easy to test, easy to change.

---

## `use-cases/merge-contacts.use-case.ts`

A more complex orchestrator showing cross-domain writes done right.

```ts
import { Injectable } from '@nestjs/common';
import { ContactService } from '../contact.service';
import { ActivityService } from '../../activities/activity.service';
import { OpportunityService } from '../../opportunities/opportunity.service';
import { EventBus } from '@subsystems/events/event-bus';
import type { Contact } from '../contact.entity';

interface MergeContactsInput {
  sourceId: string;
  targetId: string;
}

@Injectable()
export class MergeContactsUseCase {
  constructor(
    private readonly contacts: ContactService,
    private readonly activities: ActivityService,
    private readonly opportunities: OpportunityService,
    private readonly events: EventBus,
  ) {}

  async execute({ sourceId, targetId }: MergeContactsInput): Promise<Contact> {
    const [source, target] = await Promise.all([
      this.contacts.findById(sourceId),
      this.contacts.findById(targetId),
    ]);

    // 1. Reassociate activities (cross-domain write — but ActivityService owns its domain)
    await this.activities.reassociateContactLinks(sourceId, targetId);

    // 2. Reassociate opportunity links (OpportunityService owns the junction table per ADR-004)
    await this.opportunities.reassignContactLinks(sourceId, targetId);

    // 3. Merge canonical field values (own-domain write)
    const merged = await this.contacts.mergeInto(target.id, source);

    // 4. Soft-delete the source
    await this.contacts.delete(source.id);

    // 5. Emit event
    await this.events.emit('contact.merged', { sourceId, targetId: merged.id });

    return merged;
  }
}
```

This is exactly the pattern ADR-004 describes: every cross-domain write happens within the owning service's method (`activities.reassociate*`, `opportunities.reassignContactLinks`), and the use case composes them. No service writes directly to another domain's repository.

---

## `dto/` — Zod Schemas

Colocated with the domain module. Input DTOs for controllers, output DTOs for responses.

```ts
// dto/create-contact.dto.ts
import { z } from 'zod';

export const CreateContactSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email(),
  title: z.string().max(200).optional(),
  phone: z.string().optional(),
  linkedinUrl: z.string().url().optional(),
  companyDomain: z.string().optional(),
  accountId: z.string().uuid().optional(),
  userId: z.string().uuid(),
});

export type CreateContactDto = z.infer<typeof CreateContactSchema>;
```

```ts
// dto/contact-output.dto.ts
import { z } from 'zod';

export const ContactOutputSchema = z.object({
  id: z.string().uuid(),
  fullName: z.string(),
  email: z.string().email(),
  title: z.string().nullable(),
  accountName: z.string().nullable(),
  linkedinUrl: z.string().url().nullable(),
});

export type ContactOutputDto = z.infer<typeof ContactOutputSchema>;
```

No separate interfaces + class-validator. Just Zod. The same pattern used everywhere: schemas, DTOs, API responses, agent tool inputs, canonical field definitions, event bodies. One validation system.

---

## `contacts.module.ts` — NestJS Wiring

Every piece assembled.

```ts
import { Module } from '@nestjs/common';
import { DatabaseModule } from '@shared/database/database.module';
import { EventsSubsystemModule } from '@subsystems/events/events.module';
import { IntegrationsSubsystemModule } from '@subsystems/integrations/integrations.module';
import { AccountsModule } from '../accounts/accounts.module';
import { ActivitiesModule } from '../activities/activities.module';
import { OpportunitiesModule } from '../opportunities/opportunities.module';
import { ContactRepository } from './contact.repository';
import { ContactService } from './contact.service';
import { ContactController } from './contact.controller';
import { NewContactUseCase } from './use-cases/new-contact.use-case';
import { MergeContactsUseCase } from './use-cases/merge-contacts.use-case';
import { MarkAsChampionUseCase } from './use-cases/mark-as-champion.use-case';
import { LinkToOpportunityUseCase } from './use-cases/link-to-opportunity.use-case';

@Module({
  imports: [
    DatabaseModule,
    EventsSubsystemModule,
    IntegrationsSubsystemModule,
    AccountsModule,
    ActivitiesModule,
    OpportunitiesModule,
  ],
  controllers: [ContactController],
  providers: [
    ContactRepository,
    ContactService,
    NewContactUseCase,
    MergeContactsUseCase,
    MarkAsChampionUseCase,
    LinkToOpportunityUseCase,
  ],
  exports: [ContactService],
})
export class ContactsModule {}
```

The module imports other domain modules whose services it needs (Accounts, Activities, Opportunities). It imports the subsystem modules. It does not import repositories directly from other domains — that would be a lint violation.

---

## `tests/` — Integration-First

Tests hit a real database via TestContainers. External ports are mocked.

```ts
// tests/contact.service.spec.ts
import { Test } from '@nestjs/testing';
import { ContactsModule } from '../contacts.module';
import { TestDatabaseModule } from '@shared/testing/test-database.module';
import { ContactService } from '../contact.service';
import { ContactRepository } from '../contact.repository';

describe('ContactService (integration)', () => {
  let service: ContactService;
  let repo: ContactRepository;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [TestDatabaseModule, ContactsModule],
    }).compile();

    service = module.get(ContactService);
    repo = module.get(ContactRepository);
  });

  it('finds a contact by ID via inherited findById', async () => {
    const inserted = await repo.create({
      userId: 'user-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
    });
    const found = await service.findById(inserted.id);
    expect(found.email).toBe('ada@example.com');
  });

  it('returns a joined account name in getOverview', async () => {
    // ... set up account + contact, verify getOverview returns accountName
  });

  it('does not emit events on updateTitle (side-effect check)', async () => {
    // Verify that the service method is a pure data operation (ADR-003 sharp test)
  });
});
```

```ts
// tests/new-contact.use-case.spec.ts
import { Test } from '@nestjs/testing';
import { NewContactUseCase } from '../use-cases/new-contact.use-case';
import { CrmSyncPort } from '@subsystems/integrations/ports/crm-sync.port';
import { MockCrmSyncAdapter } from '@shared/testing/mock-crm-sync.adapter';

describe('NewContactUseCase (integration with mocked CRM)', () => {
  let useCase: NewContactUseCase;
  let crmMock: MockCrmSyncAdapter;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [TestDatabaseModule, ContactsModule],
    })
      .overrideProvider(CrmSyncPort)
      .useClass(MockCrmSyncAdapter)
      .compile();

    useCase = module.get(NewContactUseCase);
    crmMock = module.get(CrmSyncPort);
  });

  it('creates a contact, resolves an account, syncs to CRM, emits event', async () => {
    const result = await useCase.execute({
      userId: 'user-1',
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@navy.gov',
      companyDomain: 'navy.gov',
    });

    expect(result.id).toBeDefined();
    expect(crmMock.upsertContact).toHaveBeenCalledWith(expect.objectContaining({
      email: 'grace@navy.gov',
    }));
    // Event bus subscription check...
  });
});
```

**What we mock:**
- External ports (`CrmSyncPort`) — always mocked in integration tests
- The LLM subsystem — in tests that exercise it
- Time — for measure tests involving date ranges

**What we do NOT mock:**
- The database (real TestContainers Postgres)
- Services or repositories
- The event bus (real, observable subscriptions)
- Other domain services

---

## What Changed Compared to Today

| Dimension | Today | v2 |
|---|---|---|
| Files for Contact domain | ~15 across 5 directories | ~10 in 1 directory |
| Hand-written CRUD in repository | ~200 lines | ~0 (inherited) |
| Hand-written CRUD in service | ~150 lines | ~0 (inherited) |
| Simple use cases (`GetContactByIdUseCase`, etc.) | 5-6 files | 0 (CQRS-lite shortcut to service) |
| Complex use cases | scattered across `applications/use-cases/` flat | 4 files in `contacts/use-cases/` |
| Where CRM sync lives | Mixed: service, repository, dedicated services | Port invocation from use case only |
| Where events are emitted | Services, use cases, controllers (inconsistent) | Use cases only |
| Cross-domain writes | Anywhere (repository, service, query) | Use cases only, composing services |
| Test style | Mix of unit + integration, many mocks | Integration first, minimal mocks |

---

## What This Picture Proves

1. **The layer rules work.** Every file has exactly one reason to exist and one place it can live.
2. **Inheritance eliminates boilerplate.** Concrete repositories and services are 60-80 lines each instead of 200-300.
3. **Use cases are business documentation.** Reading `contacts/use-cases/` tells you exactly what happens to contacts: `new`, `merge`, `mark-as-champion`, `link-to-opportunity`. Nothing else.
4. **Cross-domain coupling is visible.** Every cross-domain call is in a use case, and the use case imports the other domain's service. You can trace any coupling by reading one file.
5. **Codegen is feasible.** This entire module — minus the hand-written use cases and the domain-specific service methods — can be generated from `modules/canonical/contact/contact.canonical.yaml`. The codegen emits the entity, repository, service skeleton, module, and DTO schemas. The team writes the business logic.
6. **Testing is clean.** Services test against a real DB. Use cases test against real services with ports mocked. Controllers test E2E. No combinatorial mocking.

---

## Open Questions This Sketch Raises

1. **`WithAnalytics` mixin syntax.** TypeScript mixins via generics are non-trivial. The exact syntax (`class X extends WithAnalytics(CrmEntityService<...>)`) needs a working prototype to confirm.
2. **Cross-domain method naming.** `opportunities.reassignContactLinks()` implies the `OpportunityService` has a method that operates on contact links — which is fine under ADR-004 because the junction table is owned by the Opportunity domain. But the naming can be confusing. Document the pattern in ADR-004 examples.
3. **The `WithAnalytics` measure definition location.** Measures are defined in `contact.semantics.yaml`, but where does the YAML live? Probably `modules/canonical/contact/contact.semantics.yaml` (colocated with the canonical schema). Confirm in ADR-007.
4. **Lint rule for read-only cross-domain imports.** The rule needs to allow `contactRepository.findById()` from `OpportunityService` (read) but forbid `contactRepository.update()`. Implementation detail for the custom ESLint rule.

---

If this sketch feels right, ADR-001 through ADR-005 have landed as a usable shape. If something feels wrong, the ADRs need to change — not the sketch.
