/**
 * Type-level assertions over the generated baseline tree, compiled by the
 * baseline typecheck (`test/tsconfig.baseline.json` includes this file, and
 * `test/run-test.ts` fails on any diagnostic outside the named #680
 * expectation).
 *
 * An output DTO is the row's shape for the keys it exposes: same keys, same
 * optionality, same types — and it exposes no key the row lacks. #851 — Zod 3 inferred a `json` (`z.unknown()`) key as OPTIONAL, so
 * `DealStateOutputDto['metadata']` was `metadata?: unknown` while the row has
 * `metadata: unknown`. Every baseline entity is asserted, so the other field
 * kinds (enum, decimal, nullable, FK, timestamps, soft delete, external id)
 * are held to the same rule.
 */
import type { Account } from '@gen/modules/accounts/account.entity';
import type { AccountOutputDto } from '@gen/modules/accounts/dto/account-output.dto';
import type { Contact } from '@gen/modules/contacts/contact.entity';
import type { ContactOutputDto } from '@gen/modules/contacts/dto/contact-output.dto';
import type { DealState } from '@gen/modules/deal-states/deal-state.entity';
import type { DealStateOutputDto } from '@gen/modules/deal-states/dto/deal-state-output.dto';
import type { Deal } from '@gen/modules/deals/deal.entity';
import type { DealOutputDto } from '@gen/modules/deals/dto/deal-output.dto';
import type { Opportunity } from '@gen/modules/opportunities/opportunity.entity';
import type { OpportunityOutputDto } from '@gen/modules/opportunities/dto/opportunity-output.dto';
import type { Organization } from '@gen/modules/organizations/organization.entity';
import type { OrganizationOutputDto } from '@gen/modules/organizations/dto/organization-output.dto';
import type { Person } from '@gen/modules/persons/person.entity';
import type { PersonOutputDto } from '@gen/modules/persons/dto/person-output.dto';
import type { Tenant } from '@gen/modules/tenants/tenant.entity';
import type { TenantOutputDto } from '@gen/modules/tenants/dto/tenant-output.dto';
import type { User } from '@gen/modules/users/user.entity';
import type { UserOutputDto } from '@gen/modules/users/dto/user-output.dto';

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
/** The DTO is the row narrowed to its keys, and names no key the row lacks. */
type IsRowProjection<Dto, Row> = Equal<Dto, Pick<Row, keyof Dto & keyof Row>> extends true
	? Equal<Exclude<keyof Dto, keyof Row>, never>
	: false;

export type AccountOutputIsTheRow = Assert<IsRowProjection<AccountOutputDto, Account>>;
export type ContactOutputIsTheRow = Assert<IsRowProjection<ContactOutputDto, Contact>>;
export type DealStateOutputIsTheRow = Assert<IsRowProjection<DealStateOutputDto, DealState>>;
export type DealOutputIsTheRow = Assert<IsRowProjection<DealOutputDto, Deal>>;
export type OpportunityOutputIsTheRow = Assert<IsRowProjection<OpportunityOutputDto, Opportunity>>;
export type OrganizationOutputIsTheRow = Assert<IsRowProjection<OrganizationOutputDto, Organization>>;
export type PersonOutputIsTheRow = Assert<IsRowProjection<PersonOutputDto, Person>>;
export type TenantOutputIsTheRow = Assert<IsRowProjection<TenantOutputDto, Tenant>>;
export type UserOutputIsTheRow = Assert<IsRowProjection<UserOutputDto, User>>;
