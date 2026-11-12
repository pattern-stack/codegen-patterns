/**
 * READ-1 (docs/specs/READ-1.md §8.1) — the generated read surface's TYPES, in a
 * real consumer project.
 *
 * Copied into the relationship smoke's `src/` and compiled by its `tsc` step —
 * the consumer posture (`strict` + `noUncheckedIndexedAccess`), which is the one
 * that matters: `bun run typecheck` does not validate a runtime type change
 * (charter I9). Never executed: every function here is only type-checked.
 *
 * `Equal` is exact equality, not assignability. Every negative is a
 * `@ts-expect-error`, which TS2578 keeps honest — an expectation that stops
 * erroring fails the build.
 */
import { eq, sql } from 'drizzle-orm';
import type {
	AccountNoInclude,
	AccountRepository,
	AccountResult,
} from './modules/accounts/account.repository';
import type { ContactRepository } from './modules/contacts/contact.repository';
import type { OpportunityRepository } from './modules/opportunities/opportunity.repository';
import type { AccountService } from './modules/accounts/account.service';
import type { Account } from './modules/accounts/account.entity';
import type { Contact } from './modules/contacts/contact.entity';
import { accounts } from './modules/accounts/account.entity';
import { contacts } from './modules/contacts/contact.entity';
import { rootScope, SCOPES, type Relations } from './generated/relations';
import { scopedRoot, UNSCOPED } from '@shared/base-classes/scope-filters';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
function assert<T extends true>(): T | undefined {
	return undefined;
}

declare const accountRepo: AccountRepository;
declare const contactRepo: ContactRepository;
declare const opportunityRepo: OpportunityRepository;
declare const accountService: AccountService;
declare const db: NodePgDatabase<Relations>;

export async function defaults(): Promise<void> {
	// No options ⇒ exactly the row, on every read.
	const one = await accountRepo.findById('x');
	assert<Equal<typeof one, Account | null>>();
	const many = await accountRepo.findByIds(['x']);
	assert<Equal<typeof many, Account[]>>();
	const listed = await accountRepo.list();
	assert<Equal<typeof listed, Account[]>>();
}

export function resultTypes(): void {
	// `<Entity>Result<TWith, TColumns>` — the include FIRST, the mask SECOND (both
	// defaulted), so REL-2's one-argument `AccountResult<W>` keeps its meaning.
	assert<Equal<AccountResult, Account>>();
	// The full row. With the mask first this was `{}` — `NoInclude` fit the mask slot
	// and selected nothing, and the error surfaced only at a property read.
	assert<Equal<AccountResult<AccountNoInclude>, Account>>();
	type WithContacts = AccountResult<{ contacts: true }>;
	assert<Equal<WithContacts['contacts'], Contact[]>>();
	assert<Equal<WithContacts['name'], Account['name']>>();
	assert<Equal<AccountResult<AccountNoInclude, { id: true }>, { id: string }>>();
}

// @ts-expect-error — a mask in the include slot shares no key with the include surface
export type MaskInIncludeSlot = AccountResult<{ id: true }>;

export async function rootMask(): Promise<void> {
	const row = await accountRepo.findById('x', { columns: { id: true, name: true } });
	assert<Equal<typeof row, { id: string; name: string } | null>>();

	const rows = await accountRepo.list({ columns: { name: true }, limit: 5 });
	assert<Equal<typeof rows, Array<{ name: string }>>>();

	// An exclusion mask drops just those keys.
	const excl = await contactRepo.findById('x', { columns: { email: false } });
	assert<Equal<typeof excl, Omit<Contact, 'email'> | null>>();
}

export async function maskAndInclude(): Promise<void> {
	// Root mask + a to-one include with its own mask. `account` is NOT NULL, but `accounts` is
	// soft-deleted + user-tracked (`pattern: Integrated`), so the hop can drop it: nullable (#850).
	const c = await contactRepo.findById('x', {
		columns: { id: true, email: true },
		with: { account: { columns: { name: true } } },
	});
	assert<Equal<typeof c, { id: string; email: string; account: { name: string } | null } | null>>();

	// Two levels deep, masked at both.
	const a = await accountRepo.findById('x', {
		columns: { name: true },
		with: { contacts: { columns: { email: true }, with: { account: { columns: { id: true } } } } },
	});
	assert<Equal<typeof a, { name: string; contacts: Array<{ email: string; account: { id: string } | null }> } | null>>();

	// findByIds: one statement for the page, mask + includes.
	const page = await contactRepo.findByIds(['a', 'b'], {
		columns: { id: true, firstName: true },
		with: { account: { columns: { name: true } } },
	});
	assert<Equal<typeof page, Array<{ id: string; firstName: string; account: { name: string } | null }>>>();
}

export async function finders(): Promise<void> {
	// A unique declarative finder: single row, masked.
	const byEmail = await contactRepo.findByEmail('e', { columns: { id: true } });
	assert<Equal<typeof byEmail, { id: string } | null>>();
	// A non-unique declarative finder on an enum-ish column, with an include.
	const byStage = await opportunityRepo.findByStage('won' as never, { columns: { id: true }, with: { account: { columns: { name: true } } } });
	assert<Equal<(typeof byStage)[number]['account'], { name: string } | null>>();
	// A `belongs_to` finder takes the same options plus its own `limit`.
	const byAccount = await contactRepo.findByAccountId('a', { columns: { email: true }, limit: 10 });
	assert<Equal<typeof byAccount, Array<{ email: string }>>>();
}

export async function where(): Promise<void> {
	// A row filter: a function of the table handle the executing path holds.
	await accountRepo.list({ where: (t) => eq(t.name, 'x'), with: { contacts: true } });
	await accountRepo.count((t) => eq(t.name, 'x'));
}

export async function handWrittenRoot(): Promise<void> {
	// The typed root scope of a hand-written relational read (READ-1 §5, review #10).
	await db.query.accounts.findMany({ where: { AND: [{ name: { eq: 'x' } }, rootScope.accounts('loader')] } });
	// @ts-expect-error — one table's root scope on another table's query is a compile error
	await db.query.contacts.findMany({ where: rootScope.accounts('loader') });
	// `scopedRoot` itself is typed by the scope it is given (#859 Q-1): SCOPES entries carry their table.
	await db.query.accounts.findMany({ where: scopedRoot(SCOPES.accounts, 'loader') });
	// @ts-expect-error — another table's SCOPES entry
	await db.query.contacts.findMany({ where: scopedRoot(SCOPES.accounts, 'loader') });
	// @ts-expect-error — a bare ScopeConfig names no table
	await db.query.contacts.findMany({ where: scopedRoot(UNSCOPED, 'loader') });
}

export async function negatives(): Promise<void> {
	// @ts-expect-error — a pre-rendered SQL is no longer a `where` (#840)
	await accountRepo.list({ where: eq(accounts.name, 'x') });
	// @ts-expect-error — nor is a raw `sql` fragment
	await accountRepo.list({ where: sql`true` });
	// The SERVICE layer — what use cases call — rejects the stale shapes too (review #3).
	// A row filter written for ANOTHER table is rejected on every read surface (review R-1).
	const contactFilter = (t: typeof contacts) => eq(t.email, 'x');
	// @ts-expect-error — another table's filter on a repository list
	await accountRepo.list({ where: contactFilter });
	// @ts-expect-error — another table's filter on a repository count
	await accountRepo.count(contactFilter);
	// @ts-expect-error — another table's filter on a service count
	await accountService.count(contactFilter);
	// @ts-expect-error — a pre-rendered SQL is not a service `count` filter
	await accountService.count(eq(accounts.name, 'x'));
	// @ts-expect-error — nor a service `list` where
	await accountService.list({ where: eq(accounts.name, 'x') });
	await accountService.count((t) => eq(t.name, 'x'));
	// @ts-expect-error — the pre-rendered `orderBy` is gone; `sort` is the ordering
	await accountRepo.list({ orderBy: accounts.name });
	// @ts-expect-error — an unknown column in a mask
	await accountRepo.findById('x', { columns: { nope: true } });
	// @ts-expect-error — an unknown relation in `with`
	await accountRepo.findById('x', { with: { nope: true } });
	// @ts-expect-error — an empty mask selects nothing (READ-1 §2.4)
	await accountRepo.findById('x', { columns: {} });

	const masked = await accountRepo.findById('x', { columns: { name: true } });
	// @ts-expect-error — a column the mask excluded is not on the row
	void masked?.healthScore;
}
