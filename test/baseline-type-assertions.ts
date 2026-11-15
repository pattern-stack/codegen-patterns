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
import type { Communication } from '@gen/modules/communications/communication.entity';
import type { CommunicationRepository } from '@gen/modules/communications/communication.repository';
import type { Meeting } from '@gen/modules/meetings/meeting.entity';
import type { MeetingFlat, MeetingRepository } from '@gen/modules/meetings/meeting.repository';
import type { MeetingService } from '@gen/modules/meetings/meeting.service';
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

/**
 * RFC-0006 §3.1/§3.3 (#875 S3) — a family member's plain reads type the include its edges give it, by design: the
 * base takes `with: { meeting: true, email: true }` and the child `with: { communication: true }`, whatever the
 * entity's own `relationships:` declare. `tsc` reports an unused `@ts-expect-error` (TS2578), so the last line is
 * what stops this from being a no-op: a key the graph does not have must still be refused.
 */
export async function familyIncludesType(
	communicationRepo: CommunicationRepository,
	meetingRepo: MeetingRepository,
): Promise<void> {
	const rows = await communicationRepo.list({ with: { meeting: true, email: true } });
	const child: Meeting | null | undefined = rows[0]?.meeting;
	const base: Communication | undefined = (await meetingRepo.findById('x', { with: { communication: true } }))?.communication;
	void child;
	void base;
	// @ts-expect-error — `nope` is not a relation of communications
	await communicationRepo.list({ with: { nope: true } });
	// `findWithBase` adds the base key itself, so a caller cannot also name it (a narrower spec would be dropped).
	// @ts-expect-error — `communication` is the key `findWithBase` joins
	await meetingRepo.findWithBase('x', { with: { communication: true } });
}

type IsNever<T> = [T] extends [never] ? true : false;

/**
 * RFC-0006 §3.2, §4 (#875 S3/S4) — `<Child>Flat` with its default generics is a real row type. The default include
 * is `Record<string, never>`, and `TWith & { communication: true }` over that index signature made `communication`
 * `never`, so the whole flat row was `never` and every field read off a pair write was TS2339 (review of S4).
 * Each read below is a real assignment off the flat row; a `never` row would also satisfy them all, so the first
 * assertion is the one that holds the rest honest.
 */
export type MeetingFlatIsNotNever = Assert<Equal<IsNever<MeetingFlat>, false>>;
export type MeetingFlatCarriesBothTables = Assert<
	Equal<[MeetingFlat['title'], MeetingFlat['occurredAt'], MeetingFlat['kind']], [string, Date, 'meeting']>
>;

export async function familyFlatRowsType(meetingRepo: MeetingRepository, meetingService: MeetingService): Promise<void> {
	const input = { title: 't', startsAt: new Date(), occurredAt: new Date(), source: 's', externalId: 'e' };
	const created = await meetingRepo.create(input);
	const updated = await meetingRepo.update('x', { title: 'u' });
	const upserted = (await meetingRepo.upsertByNaturalKey(input)).row;
	const found = await meetingRepo.findWithBase('x');
	const many = await meetingRepo.findManyWithBase(['x']);
	const viaService = [
		await meetingService.create(input),
		await meetingService.update('x', { title: 'u' }),
		(await meetingService.upsertByNaturalKey(input)).row,
		await meetingService.findWithBase('x'),
		...(await meetingService.findManyWithBase(['x'])),
	];
	const rows = [created, updated, upserted, found, ...many, ...viaService];
	for (const row of rows) {
		const title: string | undefined = row?.title;
		const occurredAt: Date | undefined = row?.occurredAt;
		const kind: 'meeting' | undefined = row?.kind;
		void title;
		void occurredAt;
		void kind;
	}
	const created2: boolean = (await meetingRepo.upsertByNaturalKey(input)).created;
	void created2;
	// @ts-expect-error — `nope` is on neither table
	void created.nope;
}
