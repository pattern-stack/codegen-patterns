/**
 * The Hono app (H-1b), as a client sees it: requests through `createApp(app).request(…)` on Postgres, each answer's
 * status and body checked against what the Nest target sends for the same request. Copied into the smoke project's
 * `src/`; the compile half type-checks it, `--postgres <url>` runs it.
 */
import { composeApp } from './compose';
import { createApp } from './generated/http';

const assert = (ok: unknown, what: string): void => {
  if (!ok) throw new Error(`http-check: ${what}`);
};
const same = (actual: unknown, expected: unknown, what: string): void =>
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${what}: got ${JSON.stringify(actual)}`);

export async function httpCheck(url: string): Promise<void> {
  const app = composeApp({ databaseUrl: url });
  await app.start();
  try {
    // The document is served only when `openapi.enabled` (as on the Nest target); this check turns it on.
    const http = createApp(app, { openApi: { enabled: true } });
    const call = async (method: string, path: string, body?: unknown, raw?: string) => {
      const res = await http.request(path, {
        method,
        ...(body !== undefined || raw !== undefined
          ? { headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body) }
          : {}),
      });
      const text = await res.text();
      return { status: res.status, body: text === '' ? null : (JSON.parse(text) as Record<string, unknown>) };
    };
    const missing = '00000000-0000-4000-8000-000000000000';

    const docs = await call('GET', '/docs-json');
    assert(docs.status === 200, `GET /docs-json is 200: ${docs.status}`);
    assert('CreateAccountDto' in ((docs.body!.components as { schemas: object }).schemas), 'the document registers the DTOs');
    // H-1b2: the operations the Nest target documents, at the same paths, methods and operationIds.
    const paths = docs.body!.paths as Record<string, Record<string, { operationId?: string; parameters?: Array<{ name: string }> }>>;
    const ops = Object.entries(paths).flatMap(([p, methods]) => Object.entries(methods).map(([m, op]) => `${m.toUpperCase()} ${p} ${op.operationId}`));
    for (const expected of [
      'GET /accounts listAccounts',
      'POST /accounts createAccount',
      'GET /accounts/{id} findAccountById',
      'PATCH /accounts/{id} updateAccount',
      'DELETE /accounts/{id} deleteAccount',
      'GET /accounts/search AccountSearchController_search',
      'GET /contacts listContacts',
    ]) {
      assert(ops.includes(expected), `the document has ${expected}: ${ops.join('; ')}`);
    }
    // The bearer scheme every entity operation names is defined (Nest's addBearerAuth()); search names none.
    const components = docs.body!.components as { securitySchemes?: Record<string, unknown> };
    same(components.securitySchemes, { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } }, 'the bearer scheme');
    const ops2 = paths as unknown as Record<string, Record<string, { security?: unknown; responses?: Record<string, unknown> }>>;
    assert(ops2['/accounts']!.get!.security !== undefined, 'an entity operation names the bearer scheme');
    assert(ops2['/accounts/search']!.get!.security === undefined, "search names no security (Nest's search controller has none)");
    assert(Object.keys(ops2['/accounts/search']!.get!.responses ?? {}).includes('200'), 'search documents its 200');
    assert(
      paths['/accounts']!.get!.parameters!.map((p) => p.name).join(',') === 'page,pageSize,cursor,sort_by,sort_order,include',
      'the list operation documents its query parameters',
    );

    const created = await call('POST', '/accounts', { name: 'Initech', status: 'active' });
    assert(created.status === 201, `POST /accounts is 201: ${created.status} ${JSON.stringify(created.body)}`);
    const id = created.body!.id as string;

    const found = await call('GET', `/accounts/${id}`);
    assert(found.status === 200 && found.body!.name === 'Initech', `GET /accounts/:id reads it: ${JSON.stringify(found)}`);

    const listed = await call('GET', '/accounts?pageSize=5');
    assert(listed.status === 200 && Array.isArray(listed.body!.items), `GET /accounts pages: ${JSON.stringify(listed)}`);

    const searched = await call('GET', '/accounts/search?status=active');
    assert(
      searched.status === 200 && (searched.body!.items as Array<{ id: string }>).some((a) => a.id === id),
      `GET /accounts/search filters (and is not read as an id): ${JSON.stringify(searched)}`,
    );

    const badId = await call('GET', '/accounts/not-a-uuid');
    assert(badId.status === 400, `a malformed id is 400: ${badId.status}`);
    same(badId.body, { message: 'Validation failed (uuid is expected)', error: 'Bad Request', statusCode: 400 }, "the malformed id's body is ParseUUIDPipe's");

    const notFound = await call('GET', `/accounts/${missing}`);
    assert(notFound.status === 404, `a missing row is 404: ${notFound.status}`);
    same(notFound.body, { message: `Account not found: ${missing}`, error: 'Not Found', statusCode: 404 }, "the find's 404 body is Nest's");

    const include = await call('GET', `/accounts/${id}?include=contacts`);
    assert(include.status === 400, `an include no allowlist names is 400: ${include.status}`);
    same(
      include.body,
      { statusCode: 400, error: 'Bad Request', code: 'include_not_allowed', path: 'contacts', message: "include not allowed: 'contacts'" },
      "the include refusal's body is the controller's",
    );

    const invalid = await call('POST', '/accounts', { status: 'active' });
    assert(invalid.status === 400 && invalid.body!.message === 'Validation failed', `a body without name is 400: ${JSON.stringify(invalid)}`);
    assert((invalid.body!.issues as Array<{ path: string }>).some((i) => i.path === 'name'), 'its issues name the field');

    const malformed = await call('POST', '/accounts', undefined, '{"name":');
    assert(malformed.status === 400 && malformed.body!.error === 'Bad Request', `malformed JSON is 400: ${JSON.stringify(malformed)}`);

    const updateMissing = await call('PATCH', `/accounts/${missing}`, { name: 'x' });
    assert(updateMissing.status === 404, `an update of a missing row is 404: ${updateMissing.status}`);
    same(updateMissing.body, { message: `Account ${missing} not found`, error: 'Not Found', statusCode: 404 }, "the update's 404 body is Nest's");

    const updated = await call('PATCH', `/accounts/${id}`, { name: 'Initech 2' });
    assert(updated.status === 200 && updated.body!.name === 'Initech 2', `PATCH writes: ${JSON.stringify(updated)}`);

    const orphan = await call('POST', '/contacts', { email: 'o@x.test', accountId: missing });
    assert(orphan.status === 422 && orphan.body!.code === 'foreign_key_violation', `a contact on a missing account is 422: ${JSON.stringify(orphan)}`);

    const contact = await call('POST', '/contacts', { email: 'c@initech.test', accountId: id });
    assert(contact.status === 201, `POST /contacts is 201: ${JSON.stringify(contact)}`);
    const referenced = await call('DELETE', `/accounts/${id}`);
    assert(referenced.status === 409 && referenced.body!.code === 'still_referenced', `deleting a referenced account is 409: ${JSON.stringify(referenced)}`);

    const deletedContact = await call('DELETE', `/contacts/${contact.body!.id as string}`);
    assert(deletedContact.status === 200 && deletedContact.body === null, `DELETE is 200 with an empty body, as Nest's: ${JSON.stringify(deletedContact)}`);
    assert((await call('DELETE', `/accounts/${id}`)).status === 200, 'DELETE /accounts/:id is 200');

    // Nest's body parser refuses a body over 100kb with a 413 before reading it; so does the Hono app.
    const tooLarge = await call('POST', '/accounts', undefined, JSON.stringify({ name: 'x'.repeat(200 * 1024) }));
    assert(tooLarge.status === 413, `a body over 100kb is 413: ${tooLarge.status}`);
    same(tooLarge.body, { message: 'request entity too large', error: 'Payload Too Large', statusCode: 413 }, "the 413 body is Nest's");

    // Express ignores a trailing slash; so does the Hono app.
    const slashed = await call('GET', '/accounts/');
    assert(slashed.status === 200 && Array.isArray(slashed.body!.items), `GET /accounts/ lists, as Nest's does: ${slashed.status}`);

    const unknown = await call('GET', '/nope');
    assert(unknown.status === 404, `an unknown route is 404: ${unknown.status}`);
    same(unknown.body, { message: 'Cannot GET /nope', error: 'Not Found', statusCode: 404 }, "the unknown route's body is Nest's");
  } finally {
    await app.stop();
  }
}

if (import.meta.main) {
  const url = process.argv[2];
  if (!url) throw new Error('usage: bun src/http-check.ts <postgres url>');
  await httpCheck(url);
  console.log('http-check: OK');
}
