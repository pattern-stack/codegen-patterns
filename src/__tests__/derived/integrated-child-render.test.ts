/**
 * RFC-0006 §4.2 / S7b (#917): what an Integrated child's emission looks like — no `external_id_tracking` columns on its
 * table, ONE `(tenant, provider, external_id)` unique on the base, the NULL guard, and the four reads + persist hook that
 * reach the base row. Rendered through the real backend templates over the baseline set.
 */
import { describe, expect, it } from 'bun:test';

import { assertNaturalKeyValues, NaturalKeyNullError } from '../../../runtime/base-classes/inheritance';
import { baselineSet, deriveSet } from './_inputs';
import { renderAllBackendFiles } from './_render';

const set = baselineSet();
const files = renderAllBackendFiles(set, ['inbox_item', 'mail_message', 'calendar_event']);
const text = (suffix: string): string => {
	const hit = [...files].find(([p]) => p.endsWith(suffix));
	if (!hit) throw new Error(`no rendered file ends with ${suffix}: ${[...files.keys()].join(', ')}`);
	return hit[1];
};

describe('an Integrated child owns none of external_id_tracking', () => {
	for (const child of ['mail-message', 'calendar-event']) {
		it(`${child}.entity.ts has no external_id / provider / provider_metadata column`, () => {
			const entity = text(`${child}.entity.ts`);
			expect(entity).not.toMatch(/external_id|provider/);
		});
	}

	it('its flat write and projection carry the base columns (and its base belongs_to), less exclude_fields', () => {
		const repo = text('mail-message.repository.ts');
		expect(repo).toMatch(/interface MailMessageIntegrationWrite \{[^}]*readonly mailboxExternalId\?: string \| null;/s);
		expect(repo).not.toMatch(/interface MailMessageIntegrationWrite \{[^}]*readonly preview/s); // exclude_fields: [preview]
		expect(repo).toMatch(/interface MailMessageIntegrationProjection \{[^}]*readonly externalId: string;/s);
	});
});

describe('the base emits ONE (tenant, provider, external_id) unique', () => {
	it('the natural-key entry adopts the behavior constraint', () => {
		const entity = text('inbox-item.entity.ts');
		const uniques = entity.split('\n').filter((l) => /(unique|uniqueIndex)\(.*provider.*externalId/.test(l));
		expect(uniques).toHaveLength(1);
		expect(uniques[0]).toContain('uq_inbox_items_tenant_provider_external_id');
		// NULLs stay distinct: a base-only kind's row has no provider / external_id and must not collide with another's.
		expect(uniques[0]).not.toContain('nullsNotDistinct');
	});
});

describe('the NULL guard', () => {
	it('names every key column the input leaves null or absent', () => {
		expect(() => assertNaturalKeyValues('x', { provider: 'p' }, ['provider', 'externalId'])).toThrow(NaturalKeyNullError);
		try {
			assertNaturalKeyValues('x', { provider: null, externalId: undefined }, ['provider', 'externalId']);
		} catch (e) {
			expect((e as NaturalKeyNullError).columns).toEqual(['provider', 'externalId']);
		}
		expect(() => assertNaturalKeyValues('x', { provider: 'p', externalId: 'e' }, ['provider', 'externalId'])).not.toThrow();
	});

	it("the base's upsertByNaturalKey calls it, before any statement, on the non-tenant key", () => {
		const repo = text('inbox-item.repository.ts');
		expect(repo).toContain("INBOX_ITEM_NATURAL_KEY_INPUT = ['provider', 'externalId']");
		const body = repo.slice(repo.indexOf('async upsertByNaturalKey'));
		expect(body.indexOf('assertNaturalKeyValues(')).toBeGreaterThan(-1);
		expect(body.indexOf('assertNaturalKeyValues(')).toBeLessThan(body.indexOf('.insert('));
	});
});

describe('the child repository reaches the base row', () => {
	const repo = text('mail-message.repository.ts');

	it('persists through upsertByNaturalKey, not its own insert', () => {
		const hook = repo.slice(repo.indexOf('override async writeIntegrationRow'));
		expect(hook).toContain('this.upsertByNaturalKey(');
		expect(hook.slice(0, hook.indexOf('\n  }\n'))).not.toContain('.insert(');
	});

	it('matches the base on its identity and this table on its kind (an inner join, so another kind has no row)', () => {
		expect(repo).toContain('.innerJoin(MAIL_MESSAGE_BASE, eq(MAIL_MESSAGE_BASE.id, this.table.id))');
		expect(repo).toContain('eq(MAIL_MESSAGE_BASE.externalId, externalId)');
		expect(repo).toContain('eq(MAIL_MESSAGE_BASE.provider, provider)');
	});

	it('the tombstone acts on the base through its own repository (D4)', () => {
		expect(repo).toContain('this.baseRepo.delete(hit.id, txClient)');
		expect(repo).toContain('this.baseRepo.update(hit.id, { externalId: null, provider: null }, txClient)');
	});

	it('derives each as an entry with its YAML provenance (ADR-046)', () => {
		const surface = deriveSet(set).get('mail_message')!;
		const byName = new Map(surface.repository.methods.map((m) => [m.name, m]));
		const KIND = {
			findByExternalId: 'integration_find',
			findManyByExternalIds: 'integration_find_many',
			findByExternalIdProjected: 'integration_find_projected',
			softDeleteByExternalId: 'integration_tombstone',
		} as const;
		for (const [n, kind] of Object.entries(KIND)) {
			expect(byName.get(n)?.kind).toBe(kind);
			expect(byName.get(n)?.emitted).toBe(true);
			expect(byName.get(n)?.origin).toMatchObject({ from: 'yaml', at: { path: ['entity', 'pattern'] } });
		}
		// `integrationUpsertOne` stays the pattern's: FK resolution and the projection have one owner.
		expect(byName.get('integrationUpsertOne')?.kind).toBe('inherited');
	});

	it('a plain Integrated entity has none of them', () => {
		const surface = deriveSet(set).get('contact')!;
		expect(surface.repository.methods.some((m) => m.kind.startsWith('integration_'))).toBe(false);
		expect(surface.repository.persistHook).toBeUndefined();
	});
});

describe('the integrated-child fixture copies agree', () => {
	// One source (`test/fixtures/integrated-child/entities/`), copied into the baseline set and the scaffold set.
	const { readFileSync } = require('node:fs') as typeof import('node:fs');
	const { join } = require('node:path') as typeof import('node:path');
	const root = join(import.meta.dir, '../../..');
	for (const [name, scaffold] of [['inbox_item', 'inbox-item'], ['mailbox', 'mailbox'], ['mail_message', 'mail-message'], ['calendar_event', 'calendar-event']] as const) {
		it(`${name}: baseline and scaffold copies equal the source`, () => {
			const source = readFileSync(join(root, `test/fixtures/integrated-child/entities/${name}.yaml`), 'utf-8');
			expect(readFileSync(join(root, `test/fixtures/entities/${name}.yaml`), 'utf-8')).toBe(source);
			const copy = readFileSync(join(root, `test/scaffold/entities/${scaffold}-scaffold.yaml`), 'utf-8');
			expect(copy.slice(copy.indexOf('\n') + 1)).toBe(source);
		});
	}
});
