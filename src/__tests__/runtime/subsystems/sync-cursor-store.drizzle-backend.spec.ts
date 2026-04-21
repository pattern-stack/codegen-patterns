/**
 * Unit tests for PostgresCursorStore (SYNC-4).
 *
 * Pure bun:test with `drizzle-orm/pg-proxy` — no Postgres, no Docker. The
 * pg-proxy callback captures every SQL + params pair so we can assert both
 * the operation shape (SELECT/UPDATE, WHERE clauses) and the values
 * written.
 *
 * Note on param shapes: pg-proxy serializes params to strings before
 * handing them to the callback (cursors → JSON strings, Dates → ISO
 * strings). This is pg-proxy-specific; real node-postgres handles typed
 * params directly. Our assertions target the stringified forms since
 * that's what this test harness produces — the Drizzle query builder
 * generates the same SQL shape regardless of driver.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { drizzle } from 'drizzle-orm/pg-proxy';
import type { DrizzleClient } from '../../../../runtime/types/drizzle';
import { PostgresCursorStore } from '../../../../runtime/subsystems/sync/sync-cursor-store.drizzle-backend';
import { MissingTenantIdError } from '../../../../runtime/subsystems/sync/sync-errors';

interface Captured {
  sql: string;
  params: unknown[];
  method: string;
}

function makeCapturingDb(response: { rows: unknown[][] } | { rows: unknown[] }) {
  const captures: Captured[] = [];
  const db = drizzle(async (sql, params, method) => {
    captures.push({ sql, params, method });
    return response;
  }) as unknown as DrizzleClient;
  return { db, captures };
}

/** ISO-8601 UTC timestamp in pg-proxy's stringified form. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/;

describe('PostgresCursorStore — single-tenant', () => {
  let store: PostgresCursorStore;
  let captures: Captured[];
  let db: DrizzleClient;

  beforeEach(() => {
    ({ db, captures } = makeCapturingDb({ rows: [] }));
    store = new PostgresCursorStore(db);
  });

  describe('get', () => {
    it('SELECTs cursor scoped by id only', async () => {
      ({ db, captures } = makeCapturingDb({
        rows: [['{"systemModstamp":"2026-04-21"}']] as unknown as unknown[],
      }));
      store = new PostgresCursorStore(db);

      const result = await store.get('sub-1');

      expect(result).toEqual({ systemModstamp: '2026-04-21' });
      expect(captures).toHaveLength(1);
      const [{ sql, params }] = captures;
      expect(sql.toLowerCase()).toContain('select');
      expect(sql).toContain('"sync_subscriptions"');
      expect(sql).toContain('"cursor"');
      expect(sql).toContain('"id"');
      // Single-tenant WHERE does not reference tenant_id.
      expect(sql.toLowerCase()).not.toContain('tenant_id');
      expect(params).toContain('sub-1');
    });

    it('returns null when no row exists', async () => {
      const result = await store.get('missing');
      expect(result).toBeNull();
    });

    it('returns null when the row has a null cursor column', async () => {
      ({ db, captures } = makeCapturingDb({ rows: [[null]] as unknown as unknown[] }));
      store = new PostgresCursorStore(db);
      const result = await store.get('sub-1');
      expect(result).toBeNull();
    });

    it('ignores tenantId when multi-tenant mode is off', async () => {
      await store.get('sub-1', 'tenant-a');
      const [{ sql, params }] = captures;
      expect(sql.toLowerCase()).not.toContain('tenant_id');
      // tenantId is not bound as a param either — single-tenant path
      // drops the argument entirely.
      expect(params).not.toContain('tenant-a');
    });
  });

  describe('put', () => {
    it('UPDATEs cursor, last_sync_at, and updated_at in one statement', async () => {
      await store.put('sub-1', { systemModstamp: '2026-04-21T13:00:00Z' });

      expect(captures).toHaveLength(1);
      const [{ sql, params }] = captures;
      expect(sql.toLowerCase()).toContain('update');
      expect(sql).toContain('"sync_subscriptions"');
      // All three stamped columns referenced in the SET clause.
      expect(sql).toContain('"cursor"');
      expect(sql).toContain('"last_sync_at"');
      expect(sql).toContain('"updated_at"');
      // Single-tenant WHERE scopes by id only.
      expect(sql.toLowerCase()).not.toContain('tenant_id');
      // id param present.
      expect(params).toContain('sub-1');
      // Cursor serialized as a JSON string containing the key. pg-proxy
      // passes jsonb params through as stringified JSON.
      const cursorParam = params.find(
        (p) => typeof p === 'string' && p.includes('systemModstamp'),
      );
      expect(cursorParam).toBeDefined();
    });

    it('stamps last_sync_at and updated_at with ISO timestamps around now', async () => {
      const before = Date.now();
      await store.put('sub-1', { v: 1 });
      const after = Date.now();

      const [{ params }] = captures;
      // ISO-shaped timestamps (pg-proxy stringifies Date params).
      const isoParams = params.filter(
        (p): p is string => typeof p === 'string' && ISO_RE.test(p),
      );
      expect(isoParams.length).toBeGreaterThanOrEqual(2);
      for (const iso of isoParams) {
        const t = new Date(iso).getTime();
        expect(t).toBeGreaterThanOrEqual(before);
        expect(t).toBeLessThanOrEqual(after + 100);
      }
    });
  });
});

describe('PostgresCursorStore — multi-tenant', () => {
  let store: PostgresCursorStore;
  let captures: Captured[];
  let db: DrizzleClient;

  beforeEach(() => {
    ({ db, captures } = makeCapturingDb({ rows: [] }));
    store = new PostgresCursorStore(db, true);
  });

  describe('strict tenancy enforcement', () => {
    it('throws MissingTenantIdError when get() has no tenantId', async () => {
      await expect(store.get('sub-1')).rejects.toBeInstanceOf(
        MissingTenantIdError,
      );
      // No DB call fired.
      expect(captures).toHaveLength(0);
    });

    it('throws MissingTenantIdError when get() has explicit null', async () => {
      await expect(store.get('sub-1', null)).rejects.toBeInstanceOf(
        MissingTenantIdError,
      );
    });

    it('throws MissingTenantIdError when put() has no tenantId', async () => {
      await expect(
        store.put('sub-1', { v: 1 }),
      ).rejects.toBeInstanceOf(MissingTenantIdError);
      expect(captures).toHaveLength(0);
    });

    it('throws MissingTenantIdError when put() has explicit null', async () => {
      await expect(
        store.put('sub-1', { v: 1 }, null),
      ).rejects.toBeInstanceOf(MissingTenantIdError);
    });
  });

  describe('queries scoped by tenant', () => {
    it('get() WHERE includes tenant_id and both params bind', async () => {
      await store.get('sub-1', 'tenant-a');
      expect(captures).toHaveLength(1);
      const [{ sql, params }] = captures;
      expect(sql.toLowerCase()).toContain('tenant_id');
      expect(params).toContain('sub-1');
      expect(params).toContain('tenant-a');
    });

    it('put() WHERE includes tenant_id and both params bind', async () => {
      await store.put('sub-1', { v: 1 }, 'tenant-a');
      expect(captures).toHaveLength(1);
      const [{ sql, params }] = captures;
      expect(sql.toLowerCase()).toContain('tenant_id');
      expect(params).toContain('sub-1');
      expect(params).toContain('tenant-a');
    });
  });
});

describe('PostgresCursorStore — multiTenant constructor default', () => {
  it('defaults multiTenant to false when the token is not provided', async () => {
    // When the @Optional() inject yields undefined, the store falls back
    // to single-tenant mode. Exercising via the omitted constructor arg
    // mirrors what DI will produce when `SYNC_MULTI_TENANT` is unbound.
    const { db, captures } = makeCapturingDb({ rows: [] });
    const store = new PostgresCursorStore(db, undefined);
    await store.get('sub-1');
    const [{ sql }] = captures;
    expect(sql.toLowerCase()).not.toContain('tenant_id');
  });
});
