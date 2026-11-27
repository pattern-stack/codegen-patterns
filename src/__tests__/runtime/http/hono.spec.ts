/**
 * `runtime/http/hono.ts` (H-1b): the answers a Hono route and app send, each the Nest target's.
 */
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { answer, badId, bindInput, jsonBody, queryOf, REFUSAL_STATUS, useNestFallbacks } from '../../../../runtime/http/hono';
import { REFUSALS } from '../../../../runtime/commands';

const appWith = (handler: Parameters<Hono['post']>[1]) => {
	const app = new Hono();
	app.post('/x/:id', handler);
	app.get('/boom', () => {
		throw new Error('boom');
	});
	useNestFallbacks(app);
	return app;
};

describe('the Hono view of the commands', () => {
	it('has a status for every reason a command refuses with', () => {
		expect(Object.keys(REFUSAL_STATUS).sort()).toEqual(Object.keys(REFUSALS).sort());
	});

	it('answers a result with its success status, and no result with an empty body', async () => {
		const app = new Hono();
		app.get('/ok', (c) => answer(c, { ok: true, result: { a: 1 } }, 201));
		app.get('/none', (c) => answer(c, { ok: true, result: undefined }, 200));
		const ok = await app.request('/ok');
		expect(ok.status).toBe(201);
		expect(await ok.json()).toEqual({ a: 1 });
		const none = await app.request('/none');
		expect(none.status).toBe(200);
		expect(await none.text()).toBe('');
	});

	it("answers a refusal with its reason's status and its data", async () => {
		const app = new Hono();
		const data = { message: 'gone', error: 'Not Found', statusCode: 404 };
		app.get('/r', (c) => answer(c, { ok: false, refusal: { reason: 'not-found', detail: 'gone', instead: 'look', data } }, 200));
		app.get('/odd', (c) => answer(c, { ok: false, refusal: { reason: 'who-knows', detail: 'x', instead: 'y' } }, 200));
		useNestFallbacks(app);
		const r = await app.request('/r');
		expect(r.status).toBe(404);
		expect(await r.json()).toEqual(data);
		// A reason no row names is a crash: Nest's 500.
		const odd = await app.request('/odd');
		expect(odd.status).toBe(500);
	});

	it("refuses a malformed id with ParseUUIDPipe's body", async () => {
		const app = appWith((c) => badId(c, c.req.param('id')) ?? c.json({ fine: true }));
		const bad = await app.request('/x/nope', { method: 'POST' });
		expect(bad.status).toBe(400);
		expect(JSON.stringify(await bad.json())).toBe(
			JSON.stringify({ message: 'Validation failed (uuid is expected)', error: 'Bad Request', statusCode: 400 }),
		);
		const good = await app.request('/x/00000000-0000-4000-8000-000000000000', { method: 'POST' });
		expect(await good.json()).toEqual({ fine: true });
	});

	it('reads a JSON body as the Nest body parser does', async () => {
		const app = appWith(async (c) => {
			const read = await jsonBody(c);
			return read.ok ? c.json({ body: read.body }) : read.response;
		});
		const post = (body: string, type?: string) =>
			app.request('/x/1', { method: 'POST', body, ...(type ? { headers: { 'content-type': type } } : {}) });
		expect(await (await post('{"a":1}', 'application/json')).json()).toEqual({ body: { a: 1 } });
		expect(await (await post('{"a":1}')).json()).toEqual({ body: {} });
		// Only application/json is parsed (a charset is fine), as body-parser's default type.
		expect(await (await post('{"a":1}', 'application/json; charset=utf-8')).json()).toEqual({ body: { a: 1 } });
		expect(await (await post('{"a":1}', 'application/vnd.x+json')).json()).toEqual({ body: {} });
		// Strict: a top level that is not an object or array is refused, as body-parser's strict mode refuses it.
		const primitive = await post('"abc"', 'application/json');
		expect(primitive.status).toBe(400);
		expect(((await primitive.json()) as { message: string }).message).toContain('"');
		expect(await (await post('', 'application/json')).json()).toEqual({ body: {} });
		const malformed = await post('{"a":', 'application/json');
		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toMatchObject({ error: 'Bad Request', statusCode: 400 });
	});

	it('reads a repeated query key as an array, as Express does', async () => {
		const app = new Hono();
		app.get('/q', (c) => c.json(queryOf(c)));
		expect(await (await app.request('/q?a=1&b=2&b=3')).json()).toEqual({ a: '1', b: ['2', '3'] });
	});

	it('binds the path and query onto an object body, and leaves any other body as it is', () => {
		expect(bindInput({ a: 1 }, { id: 'x' })).toEqual({ a: 1, id: 'x' });
		expect(bindInput([1], { id: 'x' })).toEqual([1]);
		expect(bindInput('s', { id: 'x' })).toBe('s');
	});

	it("answers an unknown route and a crash as Nest does", async () => {
		const app = appWith((c) => c.json({}));
		const unknown = await app.request('/nope');
		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toEqual({ message: 'Cannot GET /nope', error: 'Not Found', statusCode: 404 });
		const withQuery = await app.request('/nope?x=1');
		expect(((await withQuery.json()) as { message: string }).message).toBe('Cannot GET /nope?x=1');
		const boom = await app.request('/boom');
		expect(boom.status).toBe(500);
		expect(await boom.json()).toEqual({ statusCode: 500, message: 'Internal server error' });
	});
});
