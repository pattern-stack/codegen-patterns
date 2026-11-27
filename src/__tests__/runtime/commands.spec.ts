/**
 * `runtime/commands.ts` (H-1): what a use case throws for a caller's mistake → a refusal whose `data` is the body the
 * Nest target sends for it; anything else is a crash.
 */
import { describe, expect, it } from 'bun:test';
import { attempt, invalidInput, invokeCommand, orNotFound, refusalOf, REFUSALS } from '../../../runtime/commands';
import { BadRequestError, NotFoundError } from '../../../runtime/errors';
import { IncludeNotAllowedError } from '../../../runtime/http/includes';
import { z } from 'zod';

const pgError = (code: string, message: string, detail: string, constraint: string, table: string) =>
	Object.assign(new Error('Failed query'), { cause: Object.assign(new Error(message), { code, detail, constraint, table }) });

describe('refusalOf', () => {
	it('a missing row is not-found, with the Nest body', () => {
		expect(refusalOf(new NotFoundError('Contact not found: x'))).toEqual({
			reason: 'not-found',
			detail: 'Contact not found: x',
			instead: REFUSALS['not-found'],
			data: { message: 'Contact not found: x', error: 'Not Found', statusCode: 404 },
		});
	});

	it("an include the allowlist doesn't name is include-not-allowed, with the controller's body", () => {
		expect(JSON.stringify(refusalOf(new IncludeNotAllowedError('contacts'))?.data)).toBe(
			JSON.stringify({ statusCode: 400, error: 'Bad Request', code: 'include_not_allowed', path: 'contacts', message: "include not allowed: 'contacts'" }),
		);
	});

	it('a BadRequestError is bad-request, keeping its code', () => {
		const r = refusalOf(new BadRequestError('cannot sort', { code: 'sort_not_combinable' }));
		expect(r?.reason).toBe('bad-request');
		expect(r?.data).toMatchObject({ statusCode: 400, code: 'sort_not_combinable' });
	});

	it('a constraint violation is its reason, with the constraint body', () => {
		const fk = pgError(
			'23503',
			'insert or update on table "tasks" violates foreign key constraint "tasks_project_id_projects_id_fkey"',
			'Key (project_id)=(00000000-0000-4000-8000-000000000001) is not present in table "projects".',
			'tasks_project_id_projects_id_fkey',
			'tasks',
		);
		const r = refusalOf(fk);
		expect(r?.reason).toBe('foreign-key-violation');
		expect(r?.data).toMatchObject({ statusCode: 422, code: 'foreign_key_violation', fields: 'projectId' });
	});

	it('anything else is a crash', () => {
		expect(refusalOf(new Error('boom'))).toBeNull();
	});
});

describe('attempt, orNotFound, invokeCommand', () => {
	it('a result, a refusal, or a rethrown crash', async () => {
		expect(await attempt(async () => 1)).toEqual({ ok: true, result: 1 });
		const missing = await attempt(async () => orNotFound(null, 'Contact a not found'));
		expect(missing.ok ? null : missing.refusal.reason).toBe('not-found');
		await expect(attempt(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
	});

	it('refuses input its schema refuses, with the validation pipe body, before running', async () => {
		let ran = false;
		const command = {
			name: 'thing create',
			summary: 'Create thing',
			effect: 'side-effect' as const,
			input: z.object({ name: z.string() }),
			run: async (_apis: unknown, input: { name: string }) => {
				ran = true;
				return { ok: true as const, result: input.name };
			},
		};
		const out = await invokeCommand(command, {}, { name: 3 }, {});
		expect(ran).toBe(false);
		expect(out.ok ? null : out.refusal).toEqual(invalidInput([{ path: ['name'], code: 'invalid_type', message: 'Invalid input: expected string, received number' }]));
		expect(out.ok ? null : out.refusal.data).toMatchObject({ statusCode: 400, message: 'Validation failed', issues: [{ path: 'name', code: 'invalid_type' }] });
		expect(await invokeCommand(command, {}, { name: 'a' }, {})).toEqual({ ok: true, result: 'a' });
	});
});
