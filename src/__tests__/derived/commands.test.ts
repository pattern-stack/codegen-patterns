/**
 * `apiSurface.commands` (H-1): one command per use case but a declarative query, over the baseline set — its name,
 * effect, input and, when routed, how a request carries the input.
 */
import { describe, expect, it } from 'bun:test';
import { baselineSet, deriveSet } from './_inputs';

const surfaces = deriveSet(baselineSet());

describe('apiSurface.commands', () => {
	it('lists every use case but a declarative query, once, in use-case order', () => {
		for (const s of surfaces.values()) {
			expect(s.commands.map((c) => c.useCase)).toEqual(s.useCases.filter((u) => u.kind !== 'query').map((u) => u.className));
			expect(new Set(s.commands.map((c) => c.name)).size).toBe(s.commands.length);
		}
	});

	it('names, effects and inputs by kind', () => {
		const contact = surfaces.get('contact')!;
		const byKind = Object.fromEntries(contact.commands.map((c) => [c.kind, c]));
		expect(byKind.create).toMatchObject({ name: 'contact create', effect: 'side-effect', useCaseKey: 'create', input: { dto: 'create', id: false } });
		expect(byKind.update).toMatchObject({ effect: 'idempotent', input: { dto: 'update', id: true } });
		expect(byKind.delete).toMatchObject({ effect: 'side-effect', input: { id: true } });
		expect(byKind.find_by_id).toMatchObject({ name: 'contact find', effect: 'read', useCaseKey: 'findById', input: { id: true, include: true } });
		expect(byKind.list).toMatchObject({ effect: 'read', input: { include: true, query: 'list' } });
		expect(contact.commandsConst).toBe('contactCommands');
	});

	it("a routed command's binding and status follow its route", () => {
		for (const s of surfaces.values()) {
			for (const c of s.commands) {
				const route = s.http.routes.find((r) => r.useCase === c.useCase);
				if (!route) {
					expect(c.http).toBeUndefined();
					continue;
				}
				expect(c.http).toMatchObject({ verb: route.verb, path: route.path });
				expect(c.http!.success).toBe(c.kind === 'create' ? 201 : c.kind === 'delete' ? 204 : 200);
				expect(c.http!.binding.path).toEqual(c.input.id ? ['id'] : []);
				expect(c.http!.binding.body).toBe(c.input.dto !== undefined);
				// The include resolves against the route's own allowlist key.
				expect(c.includeRoute).toBe(route.includeRoute);
			}
		}
	});
});
