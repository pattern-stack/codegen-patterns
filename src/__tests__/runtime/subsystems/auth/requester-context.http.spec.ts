/**
 * RequesterContext boundary — real HTTP integration.
 *
 * Boots an actual `node:http` server whose only middleware is
 * `makeRequesterContextMiddleware`, then drives it with real `fetch` requests
 * carrying `Authorization: Bearer <token>` headers. Proves the boundary works
 * over the wire — including AsyncLocalStorage isolation across CONCURRENT,
 * overlapping requests (each observes only its own requester, even across an
 * `await` inside the handler).
 *
 * This is the "via HTTP" end-to-end proof for ADR-0002. (Plain HTTP on
 * localhost — TLS adds no signal to what's under test: header → ambient scope.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeRequesterContextMiddleware } from '../../../../../runtime/subsystems/auth/middleware/requester-context';
import { tryGetRequester } from '../../../../../runtime/base-classes/tenant-context';
import type { IUserContext } from '../../../../../runtime/subsystems/auth/protocols/user-context';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fake auth: decode the bearer token to a userId, mapping `bad`→empty,
 * missing→throw. Mirrors `decode(req.headers.authorization).sub` shape.
 */
const userContext: IUserContext = {
  async getCurrentUserId(req: unknown): Promise<string> {
    const auth = (req as http.IncomingMessage).headers.authorization;
    if (!auth) throw new Error('missing Authorization header');
    const token = auth.replace(/^Bearer\s+/i, '');
    if (token === 'bad') return '';
    return `user-${token}`;
  },
};

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const middleware = makeRequesterContextMiddleware(userContext);
  server = http.createServer((req, res) => {
    middleware(req, res, async () => {
      // Cross an await to prove the context survives async continuations.
      await delay(15);
      const ctx = tryGetRequester();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ scope: ctx ?? null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function getScope(token?: string): Promise<unknown> {
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;
  const res = await fetch(baseUrl, { headers });
  return (await res.json()).scope;
}

describe('RequesterContext over HTTP', () => {
  it('scopes a request to its bearer-derived user', async () => {
    expect(await getScope('alice')).toEqual({ userId: 'user-alice', organizationId: null });
  });

  it('proceeds unscoped (null) when no Authorization header is present', async () => {
    expect(await getScope()).toBeNull();
  });

  it('proceeds unscoped when the requester resolves to an empty userId', async () => {
    expect(await getScope('bad')).toBeNull();
  });

  it('isolates concurrent overlapping requests (no ALS cross-talk)', async () => {
    const [a, b, c, none] = await Promise.all([
      getScope('alice'),
      getScope('bob'),
      getScope('carol'),
      getScope(),
    ]);
    expect(a).toEqual({ userId: 'user-alice', organizationId: null });
    expect(b).toEqual({ userId: 'user-bob', organizationId: null });
    expect(c).toEqual({ userId: 'user-carol', organizationId: null });
    expect(none).toBeNull();
  });
});
