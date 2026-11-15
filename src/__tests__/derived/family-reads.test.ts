/**
 * The family read surface of a joined-table entity (RFC-0006 §3, #875 S3) — derived once (ADR-046): which
 * methods exist, what they are called, and the YAML declaration that caused them. `hasTypedInclude` is the one
 * owner of "can this entity's repository name a `with`", read by `entity-locals.js` and the include-allowlist gate.
 */
import { describe, expect, it } from 'bun:test';

import { familyConstName } from '../../derived/api/names';
import { familyReadSurface, familyWriteSurface, hasTypedInclude } from '../../derived/api/entity';
import { inheritanceBaseOf, inheritanceChildrenOf, naturalKeyIndexOf } from '../../schema/inheritance';
import { baselineSet, deriveSet } from './_inputs';
import { RENDER_MATRIX } from './_render-matrix';

const plain = { entity: { name: 'thing' } };

describe('hasTypedInclude', () => {
	it('is false with no relationships and no family', () => {
		expect(hasTypedInclude(plain, [])).toBe(false);
		expect(hasTypedInclude({ ...plain, relationships: {} }, [])).toBe(false);
	});

	it('a through: relationship emits no edge', () => {
		const through = { deep: { type: 'has_many', target: 'x', through: 'a.b' } };
		expect(hasTypedInclude({ ...plain, relationships: through }, [])).toBe(false);
	});

	it('a child has its base edge, and a base one per child, whatever the YAML declares', () => {
		expect(hasTypedInclude({ ...plain, inherits: 'communication' }, [])).toBe(true);
		expect(hasTypedInclude(plain, [{ name: 'email', as: 'email' }])).toBe(true);
	});
});

describe('inheritanceChildrenOf', () => {
	it('finds the children across a set, sorted by kind', () => {
		const set = baselineSet();
		expect(inheritanceChildrenOf('communication', set.entities)).toEqual([
			{ name: 'email', as: 'email' },
			{ name: 'meeting', as: 'meeting' },
		]);
		expect(inheritanceChildrenOf('email', set.entities)).toEqual([]);
	});
});

describe('familyReadSurface', () => {
	it('a base with a discriminator but no child table has no cross-kind reads', () => {
		expect(familyReadSurface({ ...plain, discriminator: 'kind' }, [])).toEqual({ child: false, crossKind: false });
		expect(familyReadSurface({ ...plain, discriminator: 'kind' }, [{ name: 'a', as: 'a' }])).toEqual({
			child: false,
			crossKind: true,
		});
	});
});

describe('the derived family reads', () => {
	const surfaces = deriveSet(baselineSet());

	it('a child: the flat reads (findWithBase, findManyWithBase, listFlat, countFlat) on both layers, caused by its inherits:', () => {
		for (const child of ['email', 'meeting']) {
			const s = surfaces.get(child)!;
			const origin = { from: 'yaml', at: { doc: { kind: 'entity', name: child }, path: ['inherits'] } };
			const flatKinds = ['with_base', 'list_flat', 'count_flat'];
			const repo = s.repository.methods.filter((m) => flatKinds.includes(m.kind));
			expect(repo.map((m) => [m.name, m.kind])).toEqual([
				['findWithBase', 'with_base'],
				['findManyWithBase', 'with_base'],
				['listFlat', 'list_flat'],
				['countFlat', 'count_flat'],
			]);
			expect(repo.map((m) => m.origin)).toEqual([origin, origin, origin, origin]);
			expect(repo.map((m) => m.readOptions)).toEqual(['columns+with', 'columns+with', 'with', 'none']);
			expect(repo.map((m) => m.returns)).toEqual(['one', 'many', 'many', 'count']);
			// `listFlat` / `countFlat` read the BASE repository's `listKind` / `countKind` — named on the surface, not in the template.
			expect(repo.map((m) => m.delegatesTo)).toEqual([
				undefined,
				undefined,
				{ entity: 'communication', layer: 'repository', method: 'listKind' },
				{ entity: 'communication', layer: 'repository', method: 'countKind' },
			]);
			const svc = s.service.methods.filter((m) => flatKinds.includes(m.kind));
			expect(svc.map((m) => [m.name, m.kind, m.delegatesTo?.method])).toEqual([
				['findWithBase', 'with_base', 'findWithBase'],
				['findManyWithBase', 'with_base', 'findManyWithBase'],
				['listFlat', 'list_flat', 'listFlat'],
				['countFlat', 'count_flat', 'countFlat'],
			]);
			expect(s.repository.typedInclude).toBe(true);
		}
	});

	it('a child\'s list use case names both roots: list / count, and listFlat / countFlat', () => {
		for (const child of ['email', 'meeting']) {
			const list = surfaces.get(child)!.useCases.find((u) => u.kind === 'list')!;
			const ref = (method: string) => ({ entity: child, layer: 'service', method });
			expect(list.calls).toEqual(ref('list'));
			expect(list.alsoCalls).toEqual([ref('count'), ref('listFlat'), ref('countFlat')]);
		}
		expect(surfaces.get('communication')!.useCases.find((u) => u.kind === 'list')!.alsoCalls).toBeUndefined();
	});

	it('a base: the five cross-kind reads, caused by its discriminator:, naming the child kinds', () => {
		const s = surfaces.get('communication')!;
		const repo = s.repository.methods.filter((m) => ['all_kinds', 'kind_by_id', 'list_kind', 'count_kind', 'orphans'].includes(m.kind));
		expect(repo.map((m) => m.name)).toEqual(['findAllKinds', 'findKindById', 'listKind', 'countKind', 'findOrphans']);
		for (const m of repo) {
			expect(m.origin).toMatchObject({ from: 'yaml', at: { path: ['discriminator'], note: 'kinds with a child table: email, meeting' } });
		}
		expect(s.service.methods.filter((m) => ['all_kinds', 'kind_by_id', 'list_kind', 'count_kind', 'orphans'].includes(m.kind)).map((m) => m.name)).toEqual(
			repo.map((m) => m.name),
		);
	});

	it('a plain entity carries none of them', () => {
		for (const [name, s] of surfaces) {
			if (['email', 'meeting', 'communication'].includes(name)) continue;
			expect(s.repository.methods.some((m) => ['with_base', 'all_kinds', 'kind_by_id', 'list_kind', 'count_kind', 'orphans'].includes(m.kind))).toBe(false);
		}
	});
});

describe('a base with no entity lookup', () => {
  it('fails loudly rather than reading as "no children"', async () => {
    // @ts-ignore -- plain-ESM hygen extension, no types
    const { buildBackendLocals } = await import('../../../templates/entity/new/backend/entity-locals.js');
    const { withEntities } = await import('../backend/_entity-lookup');
    const raw = {
      entity: { name: 'notice', plural: 'notices' },
      discriminator: 'kind',
      fields: { kind: { type: 'enum', choices: ['a', 'b'], required: true } },
    };
    const { entityLookupFrom } = await import('../../../templates/_shared/entity-naming.mjs');
    const full = entityLookupFrom([raw.entity], { definitions: [raw] });
    // A lookup that resolves names but cannot enumerate the set: the children are unknowable, not absent.
    const hidden = new Proxy(full, { get: (t, k) => (k === 'definitions' ? undefined : (t as any)[k]) });
    const base = { ...withEntities(), entityLookup: hidden };
    expect(() => buildBackendLocals(raw, base)).toThrow(/a `match:` referrer scan for 'notice' needs an entity lookup/);
  });
});

describe('a child service\'s delete (Gate 2.5, #875 S4)', () => {
	const surfaces = deriveSet(baselineSet());
	const deletes = (name: string) => surfaces.get(name)!.service.methods.filter((m) => m.name === 'delete');

	it('is a pair_delete, which the generated service prints as a pre-read that emits nothing for another kind\'s id', () => {
		expect(deletes('meeting').map((m) => m.kind)).toEqual(['pair_delete']);
		expect(deletes('email').map((m) => m.kind)).toEqual(['pair_delete']);
	});

	it('a base or a plain entity has none (BaseService.delete is right for a row it owns)', () => {
		expect(deletes('communication').map((m) => m.kind)).toEqual(['inherited']);
		expect(deletes('catalog_entry').map((m) => m.kind)).toEqual(['inherited']);
	});
});

describe('familyConstName (Gate 2.5, #875 S4)', () => {
	it('is the one SCREAMING_CASE rule, shared with includesConstName: a camelCase boundary is a word break', () => {
		expect(familyConstName('meeting', 'BASE_KEYS')).toBe('MEETING_BASE_KEYS');
		expect(familyConstName('deal_state', 'NATURAL_KEY')).toBe('DEAL_STATE_NATURAL_KEY');
		expect(familyConstName('dealState', 'NATURAL_KEY')).toBe('DEAL_STATE_NATURAL_KEY');
	});
});

describe('familyWriteSurface (RFC-0006 §4, #875 S4)', () => {
	const set = baselineSet();
	const byName = (n: string) => set.entities.find((d) => d.entity.name === n)!;
	const surfaceOf = (n: string) =>
		familyWriteSurface(byName(n), inheritanceChildrenOf(n, set.entities), inheritanceBaseOf(byName(n), set.entities));

	it('a child pair-writes and upserts through its base\'s natural key', () => {
		expect(surfaceOf('email')).toEqual({ pairWrite: true, upsert: 'through_base', kindGuardUpdate: false, kindGuardCreate: false });
	});

	it('a base with child tables upserts on its own key and guards both writes', () => {
		expect(surfaceOf('communication')).toEqual({ pairWrite: false, upsert: 'own', kindGuardUpdate: true, kindGuardCreate: true });
	});

	it('a plain natural_key entity upserts and guards nothing', () => {
		expect(surfaceOf('catalog_entry')).toEqual({ pairWrite: false, upsert: 'own', kindGuardUpdate: false, kindGuardCreate: false });
	});

	it('a child whose base declares no natural key has no upsert to write through', () => {
		const matrix = RENDER_MATRIX.find((m) => m.id === 'matrix-family-no-natural-key')!;
		const crate = matrix.entities.find((d) => d.entity.name === 'crate')!;
		expect(naturalKeyIndexOf(matrix.entities.find((d) => d.entity.name === 'parcel')!)).toBe(-1);
		expect(familyWriteSurface(crate, [], inheritanceBaseOf(crate, matrix.entities))).toEqual({
			pairWrite: true,
			upsert: null,
			kindGuardUpdate: false,
			kindGuardCreate: false,
		});
	});

	it('the upsert is caused by the natural_key marker: the base\'s own index for a child', () => {
		const surfaces = deriveSet(set);
		const own = surfaces.get('communication')!.repository.methods.find((m) => m.name === 'upsertByNaturalKey')!;
		const idx = naturalKeyIndexOf(byName('communication'));
		expect(own.origin).toMatchObject({ from: 'yaml', at: { doc: { name: 'communication' }, path: ['unique_indexes', idx, 'natural_key'] } });
		const child = surfaces.get('email')!.repository.methods.find((m) => m.name === 'upsertByNaturalKey')!;
		expect(child.origin).toMatchObject({ from: 'yaml', at: { doc: { name: 'communication' }, path: ['unique_indexes', idx, 'natural_key'] } });
		// The override replaces the pattern's 'inherited' entry rather than listing the name twice.
		for (const layer of ['repository', 'service'] as const) {
			const names = surfaces.get('email')![layer].methods.map((m) => m.name);
			expect(names.filter((n) => n === 'create')).toHaveLength(1);
		}
		expect(surfaces.get('email')!.repository.methods.find((m) => m.name === 'create')?.kind).toBe('pair_create');
	});
});
