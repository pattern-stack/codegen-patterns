/**
 * Pattern-stack wiring usage (PW-3a; auth S-2), as a consumer writes it: the app `project init` wrote (`compose.ts`, its
 * `database` system, PW-4), then CRUD through the use cases. Copied into the smoke project's `src/`: the compile
 * half type-checks it (every key it reads is the composition's real API); `--postgres <url>` runs it.
 */
import { eq, sql } from 'drizzle-orm';
import { accountTags } from './modules/account-tags/account-tag.entity';
import {
  IntegrationRunner,
  integrationRuns,
  integrationSubscriptions,
  type Change,
  type IChangeSource,
  type IIntegrationSink,
} from './shared/subsystems/integration/core';
import { OAuth2RefreshStrategy, OAuthStateError, type AuthCredentials, type ParsedRefreshResponse } from './shared/subsystems/auth/core';
import { connections } from './modules/connections/connection.entity';
import { PostgresRequesterCache, requestFacts, type RequesterOutcome } from './shared/subsystems/identity/core';
import { withRequester } from './shared/base-classes/tenant-context';
import { ConflictError, ForbiddenError } from './shared/errors';
import { composeApp } from './compose';
import { registerOpenApiSchemas } from './generated/openapi';
import { NotFoundError } from './shared/errors';
import { invokeCommand } from './shared/commands';
import { COMMANDS, commandNamed, type App } from './generated/commands';
import { OpenApiRegistry } from './shared/openapi';
// test/smoke/_openapi-refs.ts, copied in beside this file: the Nest OpenAPI gate's own `$ref` closure check.
import { danglingRefs } from './openapi-refs';
import type { CrmRepositories } from './modules/crm/module';
import type { SystemApis } from './generated/wiring';

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
  const app = composeApp({ databaseUrl: url });
  assert(app.order.includes('integration'), `the integration system is composed: ${app.order.join(', ')}`);
  assert(
    app.order.indexOf('auth') > app.order.indexOf('settings') && app.order.indexOf('connections') > app.order.indexOf('auth'),
    `auth is composed after settings, and connections after auth: ${app.order.join(', ')}`,
  );
  assert(app.order.indexOf('crm') < app.order.indexOf('billing'), `billing is composed after crm: ${app.order.join(', ')}`);
  await app.start();
  const { db } = app.system('database');
  try {
    const crm = app.module('crm');
    const billing = app.module('billing');

    const account = await crm.account.useCases.create.execute({ name: 'Acme', status: 'active' });
    assert(account.id, 'create returns a row with an id');
    const found = await crm.account.useCases.findById.execute(account.id);
    assert(found.name === 'Acme', 'findById reads it back');

    // Events (S-1): invoice's create publishes invoice_created in its transaction; the events system's drain delivers it.
    const delivered: Array<{ invoiceId: string; amountCents: number }> = [];
    app.system('events').typed.subscribe('invoice_created', async (event) => {
      delivered.push(event.payload);
    });

    const contact = await crm.contact.useCases.create.execute({ email: 'a@acme.test', accountId: account.id });
    const invoice = await billing.invoice.useCases.create.execute({ amountCents: 1200, accountId: account.id });
    for (let i = 0; i < 100 && delivered.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert(
      delivered.some((p) => p.invoiceId === invoice.id && p.amountCents === 1200),
      `the events system drains invoice_created to its subscriber: ${JSON.stringify(delivered)}`,
    );
    assert(contact.accountId === account.id && invoice.accountId === account.id, 'the composed repositories write');

    // A joined-table child: its repository writes the base row and its own in one transaction (RFC-0006).
    const person = await crm.person.useCases.create.execute({ displayName: 'Ada L.', firstName: 'Ada' });
    const personBack = await crm.person.useCases.findById.execute(person.id);
    assert(personBack.firstName === 'Ada', 'a child is created through its base and read back');

    assert((await accountNames(crm.repositories)).includes('Acme'), 'a context service reads through the bundle');

    await integrationCheck(app.system('integration'), db);
    await authCheck(app.system('auth'), app.system('connections'), db);
    await identityCheck(app, url);

    // A junction inside crm (PW-3c): attached from one parent, listed from the other, read from `crm.junctions`.
    const tag = await crm.tag.useCases.create.execute({ label: 'priority' });
    const link = await crm.account.service.attachTag(account.id, tag.id, { note: 'from the smoke' });
    assert(link.accountId === account.id && link.tagId === tag.id, 'a parent attaches through the junction service');
    const tagged = await crm.tag.service.accountsList(tag.id);
    assert(tagged.some((t) => t.entity.id === account.id && t.link.note === 'from the smoke'), 'the other parent lists it');
    assert((await crm.junctions.accountTag.findByAccountId(account.id)).length === 1, 'the junction service reads the link');
    // `detach` is broken for every junction (it deletes by an `id` the table lacks; reported separately).
    await db.delete(accountTags).where(eq(accountTags.accountId, account.id));
    await crm.tag.useCases.delete.execute(tag.id);

    // EAV: a lead's custom fields go to custom_fields' field_values in the same transaction as the row, and read back
    // merged (the composition built FieldValueService in customFields before crm's lead repository and service).
    const customFields = app.module('customFields');
    await customFields.fieldDefinition.useCases.create.execute({ entityType: 'lead', key: 'budget' });
    const userId = '00000000-0000-4000-8000-000000000001';
    const lead = await crm.lead.useCases.create.execute({ name: 'Ada', userId, fields: { budget: 5000 } });
    const leadBack = await crm.lead.useCases.findByIdWithFields.execute(lead.id);
    assert(leadBack?.fields.budget === 5000, `a lead's custom field reads back: ${JSON.stringify(leadBack?.fields)}`);
    await crm.lead.useCases.update.execute(lead.id, { fields: { budget: 6000 } });
    const leads = await crm.lead.useCases.listWithFields.execute();
    assert(leads.some((l) => l.id === lead.id && l.fields.budget === 6000), 'an update rewrites the value, and the list merges it');

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

    await commandsCheck(app);
  } finally {
    await app.stop();
  }
}

/**
 * The same CRUD through the commands table (H-1): each result, and each refusal with the body the Nest target answers
 * it with.
 */
async function commandsCheck(app: App): Promise<void> {
  const command = (name: string) => {
    const c = commandNamed(name);
    assert(c, `COMMANDS has '${name}': ${COMMANDS.map((x) => x.name).join(', ')}`);
    return c!;
  };
  const call = (name: string, input: unknown) => invokeCommand(command(name), app, input, {});
  const refusalOf = async (name: string, input: unknown) => {
    const out = await call(name, input);
    assert(!out.ok, `${name} is refused: ${JSON.stringify(out)}`);
    return out.ok ? fail() : out.refusal;
  };
  const fail = (): never => {
    throw new Error('crud-check: unreachable');
  };

  assert(command('account create').effect === 'side-effect', 'create is a side-effect command');
  assert(command('account update').effect === 'idempotent', 'update is idempotent');
  assert(command('account list').effect === 'read', 'list reads');

  const created = await call('account create', { name: 'Initech', status: 'active' });
  assert(created.ok, `account create runs: ${JSON.stringify(created)}`);
  const account = (created as { ok: true; result: { id: string; name: string } }).result;

  const found = await call('account find', { id: account.id });
  assert(found.ok && (found.result as { name: string }).name === 'Initech', 'account find reads it back');

  const listed = await call('account list', { pageSize: '5' });
  assert(listed.ok && Array.isArray((listed.result as { items: unknown[] }).items), 'account list pages');

  const searched = await call('account search', { status: 'active' });
  assert(
    searched.ok && (searched.result as { items: Array<{ id: string }> }).items.some((a) => a.id === account.id),
    'account search filters',
  );

  const bad = await refusalOf('account create', { status: 'active' });
  assert(bad.reason === 'invalid-input', `a body without name is invalid-input: ${bad.reason}`);
  const badBody = bad.data as { statusCode: number; message: string; issues: Array<{ path: string }> };
  assert(
    badBody.statusCode === 400 && badBody.message === 'Validation failed' && badBody.issues.some((i) => i.path === 'name'),
    `the invalid-input body is the validation pipe's: ${JSON.stringify(badBody)}`,
  );

  const include = await refusalOf('account find', { id: account.id, include: 'contacts' });
  assert(include.reason === 'include-not-allowed', `an include no allowlist names is refused: ${include.reason}`);
  assert(
    JSON.stringify(include.data) ===
      JSON.stringify({ statusCode: 400, error: 'Bad Request', code: 'include_not_allowed', path: 'contacts', message: "include not allowed: 'contacts'" }),
    `the include refusal's body is the Nest controller's: ${JSON.stringify(include.data)}`,
  );

  const missing = '00000000-0000-4000-8000-000000000000';
  const notFound = await refusalOf('account update', { id: missing, name: 'x' });
  assert(notFound.reason === 'not-found', `an update of a missing row is not-found: ${notFound.reason}`);
  assert(
    JSON.stringify(notFound.data) === JSON.stringify({ message: `Account ${missing} not found`, error: 'Not Found', statusCode: 404 }),
    `the not-found body is Nest's: ${JSON.stringify(notFound.data)}`,
  );
  const findMissing = await refusalOf('account find', { id: missing });
  assert(findMissing.reason === 'not-found', `a find of a missing row is not-found: ${findMissing.reason}`);

  const orphan = await refusalOf('contact create', { email: 'o@x.test', accountId: missing });
  assert(orphan.reason === 'foreign-key-violation', `a contact on a missing account is refused: ${orphan.reason}`);
  assert((orphan.data as { statusCode: number }).statusCode === 422, 'its body is the 422 constraint body');

  const contact = await call('contact create', { email: 'c@initech.test', accountId: account.id });
  assert(contact.ok, `contact create runs: ${JSON.stringify(contact)}`);
  const referenced = await refusalOf('account delete', { id: account.id });
  assert(referenced.reason === 'still-referenced', `deleting a referenced account is refused: ${referenced.reason}`);

  const contactId = (contact as { ok: true; result: { id: string } }).result.id;
  assert((await call('contact delete', { id: contactId })).ok, 'contact delete runs');
  assert((await call('account delete', { id: account.id })).ok, 'account delete runs');
}

type Row = { externalId: string; name: string };

/**
 * One integration run (S-3) on the \`integration\` system's substrate: the Postgres cursor store and run recorder, the
 * default differ. The change source and the sink are stand-ins (the generated ones come with the adapters).
 */
async function integrationCheck(
  integration: SystemApis['integration'],
  db: SystemApis['database']['db'],
): Promise<void> {
  const [subscription] = await db
    .insert(integrationSubscriptions)
    .values({ connectionId: 'smoke', adapter: 'smoke', domain: 'account' })
    .returning({ id: integrationSubscriptions.id });
  const changes: Change<Row>[] = [
    { externalId: 'x-1', operation: 'created', record: { externalId: 'x-1', name: 'One' }, cursor: { at: 1 }, source: 'poll' },
    { externalId: 'x-2', operation: 'created', record: { externalId: 'x-2', name: 'Two' }, cursor: { at: 2 }, source: 'poll' },
  ];
  const source: IChangeSource<Row> = {
    label: 'smoke',
    async *listChanges() {
      yield* changes;
    },
  };
  const saved = new Map<string, Row>();
  const sink: IIntegrationSink<Row> = {
    findByExternalId: async (_userId, externalId) => saved.get(externalId) ?? null,
    upsertByExternalId: async (_userId, record) => {
      saved.set(record.externalId, record);
      return { id: record.externalId, saved: record };
    },
    softDeleteByExternalId: async () => null,
  };
  const runner = new IntegrationRunner<Row>({ ...integration, source, sink });
  const result = await runner.execute({
    subscription: { id: subscription!.id, domain: 'account' },
    userId: 'smoke',
    provider: 'smoke',
    direction: 'inbound',
    action: 'poll',
  });
  assert(result.status === 'success' && result.recordsProcessed === 2, `the run processes both changes: ${JSON.stringify(result)}`);
  assert(saved.size === 2, 'the sink receives both records');
  const [run] = await db.select().from(integrationRuns).where(eq(integrationRuns.id, result.runId));
  assert(run?.status === 'success' && run.recordsProcessed === 2, `the run recorder logs the run: ${JSON.stringify(run)}`);
  assert(
    JSON.stringify(await integration.cursors.get(subscription!.id)) === JSON.stringify({ at: 2 }),
    'the cursor store keeps the last cursor',
  );
}

type App = ReturnType<typeof composeApp>;

const refusalOf = (outcome: RequesterOutcome): string | null => ('refusal' in outcome ? outcome.refusal.reason : null);
const roleOf = (outcome: RequesterOutcome): string | null => ('requester' in outcome ? (outcome.requester.role ?? null) : null);

async function until(what: string, ok: () => Promise<boolean>, ms = 2000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) {
    if (await ok()) return;
  }
  throw new Error(`crud-check: ${what} (waited ${ms} ms)`);
}

async function refusedWith(kind: new (...a: never[]) => Error, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (err) {
    return err instanceof kind;
  }
}

/**
 * Identity (ID-1) on the `requester` system and the `workspaces` module: the requester port's four outcomes, the
 * workspace operations and their rules, and the Postgres cache's two promises — a change made by one app is evicted
 * in another (its own listener, its own cache), and a listener that reconnects clears its cache.
 */
async function identityCheck(app: App, url: string): Promise<void> {
  const users = app.module('identity').user.useCases;
  const workspaces = app.module('workspaces').service;
  const requester = app.system('requester');
  const stamp = Date.now();
  const [a, b, c] = await Promise.all(
    ['a', 'b', 'c'].map((n) => users.create.execute({ email: `${n}-${stamp}@smoke.test`, displayName: n })),
  );
  const facts = (who?: string, workspace?: string) =>
    requestFacts('/anything', { 'X-Smoke-Principal': who, 'X-Workspace': workspace });

  assert(refusalOf(await requester.resolve(facts())) === 'unauthenticated', 'no principal is unauthenticated');
  const { workspace, role } = await withRequester({ userId: a!.id }, () =>
    workspaces.createWorkspace({ name: 'Smoke', slug: `smoke-${stamp}` }),
  );
  assert(role === 'owner', 'the creator owns the workspace');
  const asA = await requester.resolve(facts(a!.id, workspace.id));
  assert(
    'requester' in asA && asA.requester.tenantId === workspace.id && asA.requester.role === 'owner',
    `the owner resolves in the workspace: ${JSON.stringify(asA)}`,
  );
  const ownerA = (asA as { requester: Parameters<typeof withRequester>[0] }).requester;
  const mine = await withRequester({ userId: a!.id }, () => workspaces.listMine());
  assert(mine.some((m) => m.workspace.id === workspace.id && m.role === 'owner'), 'listMine has it, as owner');
  assert(refusalOf(await requester.resolve(facts(a!.id, 'not-an-id'))) === 'bad-workspace', 'a malformed workspace is refused');
  assert(refusalOf(await requester.resolve(facts(c!.id, workspace.id))) === 'not-a-member', 'a non-member is refused');

  await withRequester(ownerA, () => workspaces.addMember({ userId: b!.id, role: 'member' }));
  assert(roleOf(await requester.resolve(facts(b!.id, workspace.id))) === 'member', 'an added user resolves as member');
  const memberB = { userId: b!.id, tenantId: workspace.id, role: 'member' };
  assert(
    await refusedWith(ForbiddenError, () => withRequester(memberB, () => workspaces.addMember({ userId: c!.id, role: 'member' }))),
    'a member may not add members',
  );
  await withRequester(ownerA, () => workspaces.changeRole({ userId: b!.id, role: 'admin' }));
  assert(roleOf(await requester.resolve(facts(b!.id, workspace.id))) === 'admin', 'a role change is seen at once by the app that made it');
  assert(
    await refusedWith(ConflictError, () => withRequester(ownerA, () => workspaces.changeRole({ userId: a!.id, role: 'member' }))),
    'the last owner may not be demoted',
  );
  assert(
    await refusedWith(ConflictError, () => withRequester(ownerA, () => workspaces.removeMember({ userId: a!.id }))),
    'the last owner may not leave',
  );

  // A second app: its own pool, listener and cache. It caches B, the first app removes B, the second hears it.
  const other = composeApp({ databaseUrl: url });
  await other.start();
  try {
    const otherRequester = other.system('requester');
    const otherCache = otherRequester.cache as PostgresRequesterCache;
    await until('the second app\'s listener connects', async () => otherCache.caching);
    assert(roleOf(await otherRequester.resolve(facts(b!.id, workspace.id))) === 'admin', 'the second app sees B as admin');
    assert(otherCache.size > 0, 'the second app cached the membership');
    await withRequester(ownerA, () => workspaces.removeMember({ userId: b!.id }));
    await until(
      'the second app refuses B after the first removed it',
      async () => refusalOf(await otherRequester.resolve(facts(b!.id, workspace.id))) === 'not-a-member',
    );

    // Reconnect: end every identity listener's backend; each drops (stops caching), reconnects and clears its cache.
    assert(roleOf(await otherRequester.resolve(facts(a!.id, workspace.id))) === 'owner', 'A is cached in the second app');
    const { db } = app.system('database');
    await db.execute(sql`select pg_terminate_backend(pid) from pg_stat_activity where query = 'LISTEN identity_requester'`);
    await until('the second app\'s listener drops', async () => !otherCache.caching);
    await until('the second app\'s listener reconnects', async () => otherCache.caching, 10_000);
    assert(otherCache.size === 0, `a reconnected listener clears its cache (size ${otherCache.size})`);
    await withRequester(ownerA, () => workspaces.addMember({ userId: c!.id, role: 'member' }));
    await until(
      'the second app sees a member added after it reconnected',
      async () => roleOf(await otherRequester.resolve(facts(c!.id, workspace.id))) === 'member',
    );
  } finally {
    await other.stop();
  }
}

/** A provider's refresh strategy, as an author writes one: the token endpoint is stubbed (`fetch`), the store is real. */
class SmokeOAuthStrategy extends OAuth2RefreshStrategy {
  protected readonly provider = 'smoke';
  protected readonly defaultExpiresInSec = 3600;
  protected tokenEndpoint(): string {
    return 'https://smoke.invalid/token';
  }
  protected refreshBodyExtras(): Record<string, string> {
    return { client_id: 'smoke' };
  }
  protected parseRefreshResponse(raw: unknown): ParsedRefreshResponse {
    const r = raw as { access_token: string; refresh_token?: string; expires_in?: number };
    return { accessToken: r.access_token, refreshToken: r.refresh_token, expiresInSec: r.expires_in };
  }
  protected buildCredentials(accessToken: string): AuthCredentials {
    return { accessToken };
  }
}

/**
 * Auth (S-2) on the `auth` and `connections` systems: an OAuth state is single-use in Postgres; a grant is stored
 * encrypted and read back decrypted; a refresh through a strategy built on the store's reader and writer persists the
 * rotated tokens; the callback URL is the redirect base's.
 */
async function authCheck(
  auth: SystemApis['auth'],
  store: SystemApis['connections'],
  db: SystemApis['database']['db'],
): Promise<void> {
  const userId = '00000000-0000-4000-8000-000000000002';
  const state = await auth.oauthState.generate({ userId, redirect: '/settings' });
  const consumed = await auth.oauthState.consume(state);
  assert(consumed.userId === userId && consumed.redirect === '/settings', 'an OAuth state reads back once');
  let replay: unknown;
  try {
    await auth.oauthState.consume(state);
  } catch (err) {
    replay = err;
  }
  assert(replay instanceof OAuthStateError && replay.reason === 'missing', 'a consumed OAuth state is refused');
  assert(
    auth.callbackUrl('smoke') === 'http://localhost:3000/auth/smoke/callback',
    `the callback URL is the redirect base's: ${auth.callbackUrl('smoke')}`,
  );

  await store.grantSink.createOrUpdateFromOAuthGrant({ userId, provider: 'smoke', accessToken: 'a1', refreshToken: 'r1' });
  const row = await store.connections.findByUserAndProvider(userId, 'smoke');
  assert(row?.accessToken === 'a1' && row.refreshToken === 'r1', 'the grant reads back decrypted');
  const [raw] = await db.select().from(connections).where(eq(connections.id, row!.id));
  assert(raw?.accessTokenEncrypted && raw.accessTokenEncrypted !== 'a1', 'the stored token is ciphertext');

  const calls: string[] = [];
  const strategy = new SmokeOAuthStrategy({
    connectionReader: store.reader,
    tokenWriter: store.tokenWriter,
    fetch: async (_url, init) => {
      calls.push(String(init?.body));
      return new Response(JSON.stringify({ access_token: 'a2', refresh_token: 'r2', expires_in: 60 }), { status: 200 });
    },
  });
  const creds = await strategy.resolve(row!.id);
  assert(creds.accessToken === 'a2' && calls.length === 1 && calls[0]!.includes('refresh_token=r1'), 'an expired grant refreshes');
  const after = await store.reader.findByIdDecrypted(row!.id);
  assert(after?.accessToken === 'a2' && after.refreshToken === 'r2', 'the refreshed and rotated tokens are persisted');
  await store.connections.disconnect(row!.id);
  await db.delete(connections).where(eq(connections.id, row!.id));
}

if (import.meta.main) {
  const url = process.argv[2];
  if (!url) throw new Error('usage: bun src/crud-check.ts <postgres url> | --openapi');
  await openApiCheck();
  if (url !== '--openapi') await crudCheck(url);
  console.log('crud-check: OK');
}
