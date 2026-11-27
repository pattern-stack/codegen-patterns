/**
 * Pattern-stack wiring usage (PW-3a), as a consumer writes it: a `database` system, the generated modules composed with
 * `@pattern-stack/wiring`, then CRUD through the use cases. Copied into the smoke project's `src/`: the compile
 * half type-checks it (every key it reads is the composition's real API); `--postgres <url>` runs it.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { relations } from './generated/relations';
import { compose, defineSystem } from './generated/wiring';
import { MODULES } from './generated/composition';
import { registerOpenApiSchemas } from './generated/openapi';
import { NotFoundError } from './shared/errors';
import { OpenApiRegistry } from './shared/openapi';
// test/smoke/_openapi-refs.ts, copied in beside this file: the Nest OpenAPI gate's own `$ref` closure check.
import { danglingRefs } from './openapi-refs';
import type { CrmRepositories } from './modules/crm/module';

const assert = (ok: unknown, what: string): void => {
  if (!ok) throw new Error(`crud-check: ${what}`);
};

/** A hand-written context service's shape (d27, PW-3b): it takes the context's repository bundle, not the classes. */
async function accountNames(repositories: CrmRepositories): Promise<string[]> {
  return (await repositories.account.list()).map((a) => a.name);
}

/** Every entity's DTO schemas register, and the document carries them (PW-3b). Needs no database. */
export async function openApiCheck(): Promise<void> {
  const openApi = new OpenApiRegistry();
  registerOpenApiSchemas(openApi);
  const doc = await openApi.build({ title: 'pattern-stack smoke', version: '0.0.0' });
  const schemas = doc.components.schemas;
  for (const name of ['CreateAccountDto', 'UpdateAccountDto', 'AccountOutputDto', 'PersonOutputDto', 'NoteOutputDto']) {
    assert(name in schemas, `openapi.ts registers ${name}: ${Object.keys(schemas).join(', ')}`);
  }
  const dangling = danglingRefs(doc);
  assert(dangling.length === 0, `every $ref resolves: ${dangling.join(', ')}`);
  // Each request DTO's prefill is one its own schema accepts, as the Nest gate holds Try it out to.
  for (const [name, component] of Object.entries(schemas)) {
    if (!/^(Create|Update)\w+Dto$/.test(name)) continue;
    const example = (component as { example?: unknown }).example;
    if (example === undefined) continue;
    const parsed = openApi.schemaNamed(name)!.safeParse(example);
    assert(parsed.success, `${name}'s example parses with its own schema: ${JSON.stringify(parsed.error?.issues)}`);
  }
}

export async function crudCheck(url: string): Promise<void> {
  const pool = new Pool({ connectionString: url });
  const database = defineSystem({
    name: 'database',
    uses: [],
    create: () => ({ db: drizzle({ client: pool, relations }) }),
    stop: () => pool.end(),
  });
  const app = compose({ systems: [database], modules: [...MODULES] });
  assert(app.order.indexOf('crm') < app.order.indexOf('billing'), `billing is composed after crm: ${app.order.join(', ')}`);
  await app.start();
  try {
    const crm = app.module('crm');
    const billing = app.module('billing');

    const account = await crm.account.useCases.create.execute({ name: 'Acme', status: 'active' });
    assert(account.id, 'create returns a row with an id');
    const found = await crm.account.useCases.findById.execute(account.id);
    assert(found.name === 'Acme', 'findById reads it back');

    const contact = await crm.contact.useCases.create.execute({ email: 'a@acme.test', accountId: account.id });
    const invoice = await billing.invoice.useCases.create.execute({ amountCents: 1200, accountId: account.id });
    assert(contact.accountId === account.id && invoice.accountId === account.id, 'the composed repositories write');

    // A joined-table child: its repository writes the base row and its own in one transaction (RFC-0006).
    const person = await crm.person.useCases.create.execute({ displayName: 'Ada L.', firstName: 'Ada' });
    const personBack = await crm.person.useCases.findById.execute(person.id);
    assert(personBack.firstName === 'Ada', 'a child is created through its base and read back');

    assert((await accountNames(crm.repositories)).includes('Acme'), 'a context service reads through the bundle');

    const page = await crm.account.useCases.list.execute();
    assert(page.items.some((a) => a.id === account.id), 'list pages it');
    const byStatus = await crm.account.useCases.findByStatus.execute('active');
    assert(byStatus.some((a) => a.id === account.id), 'the declarative query finds it');

    const updated = await crm.account.useCases.update.execute(account.id, { name: 'Acme 2' });
    assert(updated?.name === 'Acme 2', 'update writes');

    await billing.invoice.useCases.delete.execute(invoice.id);
    await crm.contact.useCases.delete.execute(contact.id);
    await crm.account.useCases.delete.execute(account.id);
    let notFound: unknown;
    try {
      await crm.account.useCases.findById.execute(account.id);
    } catch (err) {
      notFound = err;
    }
    assert(notFound instanceof NotFoundError && notFound.status === 404, 'a deleted id is a NotFoundError (404)');
  } finally {
    await app.stop();
  }
}

if (import.meta.main) {
  const url = process.argv[2];
  if (!url) throw new Error('usage: bun src/crud-check.ts <postgres url> | --openapi');
  await openApiCheck();
  if (url !== '--openapi') await crudCheck(url);
  console.log('crud-check: OK');
}
