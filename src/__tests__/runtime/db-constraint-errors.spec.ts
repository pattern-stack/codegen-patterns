/**
 * `runtime/db-constraint-errors.ts`: a write Postgres refused on a constraint → a 4xx body naming the field. The
 * driver errors below are node-postgres's, with the detail text Postgres sends, wrapped the way Drizzle wraps them
 * (`DrizzleQueryError`, the driver error as `cause`).
 */
import { describe, expect, it } from 'bun:test';
import { constraintViolationBody, constraintViolationOf } from '../../../runtime/db-constraint-errors';

class DatabaseError extends Error {
	constructor(
		message: string,
		readonly code: string,
		readonly detail: string,
		readonly constraint: string,
		readonly table: string,
	) {
		super(message);
	}
}
/** What Drizzle throws: its own error with the driver's as `cause`. */
const drizzle = (cause: unknown) => Object.assign(new Error('Failed query: insert into "tasks" …'), { cause });

const FK = new DatabaseError(
	'insert or update on table "tasks" violates foreign key constraint "tasks_project_id_projects_id_fkey"',
	'23503',
	'Key (project_id)=(00000000-0000-4000-8000-000000000001) is not present in table "projects".',
	'tasks_project_id_projects_id_fkey',
	'tasks',
);

describe('constraintViolationOf', () => {
	it('a foreign key that names no row: 422, the property name, the id and the table', () => {
		const v = constraintViolationOf(drizzle(FK))!;
		expect(v).toMatchObject({ status: 422, code: 'foreign_key_violation', fields: ['projectId'], constraint: 'tasks_project_id_projects_id_fkey' });
		expect(v.message).toBe(
			'projectId 00000000-0000-4000-8000-000000000001 does not name an existing projects row (constraint tasks_project_id_projects_id_fkey).',
		);
	});

	it('a delete of a row still referenced: 409 still_referenced, naming the referencing table', () => {
		const err = new DatabaseError(
			'update or delete on table "projects" violates foreign key constraint "tasks_project_id_projects_id_fkey" on table "tasks"',
			'23503',
			'Key (id)=(5dfb6118-5c52-4532-8e66-622354517c98) is still referenced from table "tasks".',
			'tasks_project_id_projects_id_fkey',
			'projects',
		);
		const v = constraintViolationOf(drizzle(err))!;
		expect(v).toMatchObject({ status: 409, code: 'still_referenced', fields: ['id'] });
		expect(v.message).toContain('still referenced from tasks');
	});

	it('a taken unique value: 409, one field', () => {
		const err = new DatabaseError(
			'duplicate key value violates unique constraint "account_profiles_handle_uniq"',
			'23505',
			'Key (handle)=(acme) already exists.',
			'account_profiles_handle_uniq',
			'account_profiles',
		);
		const v = constraintViolationOf(drizzle(err))!;
		expect(v).toMatchObject({ status: 409, code: 'unique_violation', fields: ['handle'] });
		expect(v.message).toBe('handle is already taken: (acme) already exists (constraint account_profiles_handle_uniq).');
	});

	it('a taken composite unique: every field, in the constraint\'s order', () => {
		const err = new DatabaseError(
			'duplicate key value violates unique constraint "asset_tags_tenant_id_code_uniq"',
			'23505',
			'Key (tenant_id, code)=(t-1, A7) already exists.',
			'asset_tags_tenant_id_code_uniq',
			'asset_tags',
		);
		const v = constraintViolationOf(err)!;
		expect(v.fields).toEqual(['tenantId', 'code']);
		expect(v.message).toContain('tenantId, code are already taken');
	});

	it('finds the driver error however deep Drizzle (or a transaction) wrapped it', () => {
		expect(constraintViolationOf(drizzle(drizzle(drizzle(FK))))?.status).toBe(422);
	});

	it('still classifies when the detail is missing (no field to name)', () => {
		const err = Object.assign(new Error('x'), { code: '23505', constraint: 'c_uniq' });
		expect(constraintViolationOf(err)).toMatchObject({ status: 409, fields: [], constraint: 'c_uniq' });
	});

	it('is null for every other error, so it keeps the default handling', () => {
		expect(constraintViolationOf(new Error('boom'))).toBeNull();
		expect(constraintViolationOf(Object.assign(new Error('not null'), { code: '23502' }))).toBeNull();
		expect(constraintViolationOf({ status: 404 })).toBeNull();
		expect(constraintViolationOf(null)).toBeNull();
		expect(constraintViolationOf('23503')).toBeNull();
	});
});

describe('constraintViolationBody', () => {
	it('has the key order of every generated error body: statusCode, error, code, details, message', () => {
		const body = constraintViolationBody(constraintViolationOf(drizzle(FK))!);
		expect(Object.keys(body)).toEqual(['statusCode', 'error', 'code', 'fields', 'constraint', 'message']);
		expect(body).toMatchObject({ statusCode: 422, error: 'Unprocessable Entity', fields: 'projectId' });
	});

	it('joins several fields with a comma', () => {
		const err = Object.assign(new Error('x'), { code: '23505', detail: 'Key (tenant_id, code)=(t, c) already exists.' });
		expect(constraintViolationBody(constraintViolationOf(err)!).fields).toBe('tenantId,code');
	});
});
