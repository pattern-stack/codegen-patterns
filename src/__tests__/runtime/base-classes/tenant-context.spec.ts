/**
 * TEN-1 (#585) — the tenant axis of the requester ALS (ADR-042).
 *
 * The three-state contract is the load-bearing part, and it is the part
 * ADR-042's sketch got wrong: a context that carries NO tenant must throw under
 * strict, not return `undefined`. `undefined` would flow into the predicate,
 * produce no filter, and read the union of every tenant — the exact failure the
 * feature exists to prevent, arriving silently.
 */
import { describe, expect, it } from 'bun:test';

import {
  MissingTenantIdError,
  SYSTEM_ACTOR_ID,
  getTenantId,
  requireRequester,
  tryGetRequester,
  withAllTenants,
  withRequester,
  withTenantScope,
} from '../../../../runtime/base-classes/tenant-context';

const OWNER = 'WidgetRepository';

describe('getTenantId — three states × two enforcement modes', () => {
  describe('lenient', () => {
    it('no context at all → undefined (unscoped, pre-scoping behaviour)', () => {
      expect(getTenantId('lenient', OWNER)).toBeUndefined();
    });

    it('a context with no tenantId → undefined', async () => {
      await withRequester({ userId: 'u1', organizationId: null }, async () => {
        expect(getTenantId('lenient', OWNER)).toBeUndefined();
      });
    });

    it('a tenant string passes through', async () => {
      await withRequester(
        { userId: 'u1', organizationId: null, tenantId: 't-a' },
        async () => {
          expect(getTenantId('lenient', OWNER)).toBe('t-a');
        },
      );
    });

    it('an explicit null passes through — it is a partition, not an absence', async () => {
      await withRequester(
        { userId: 'u1', organizationId: null, tenantId: null },
        async () => {
          expect(getTenantId('lenient', OWNER)).toBeNull();
        },
      );
    });
  });

  describe('strict', () => {
    it('no context at all → throws (missing boundary)', () => {
      expect(() => getTenantId('strict', OWNER)).toThrow(
        /No requester context active/,
      );
    });

    it('a context with no tenantId → MissingTenantIdError, NOT undefined', async () => {
      await withRequester({ userId: 'u1', organizationId: null }, async () => {
        expect(() => getTenantId('strict', OWNER)).toThrow(MissingTenantIdError);
      });
    });

    it('the error names the repository that raised it', async () => {
      await withRequester({ userId: 'u1', organizationId: null }, async () => {
        try {
          getTenantId('strict', OWNER);
          throw new Error('expected a throw');
        } catch (err) {
          expect(err).toBeInstanceOf(MissingTenantIdError);
          expect((err as MissingTenantIdError).owner).toBe(OWNER);
          expect((err as Error).message).toContain(OWNER);
          expect((err as Error).name).toBe('MissingTenantIdError');
        }
      });
    });

    it('a tenant string passes', async () => {
      await withRequester(
        { userId: 'u1', organizationId: null, tenantId: 't-a' },
        async () => {
          expect(getTenantId('strict', OWNER)).toBe('t-a');
        },
      );
    });

    it('an explicit null passes — cross-tenant background work is legal', async () => {
      await withRequester(
        { userId: 'u1', organizationId: null, tenantId: null },
        async () => {
          expect(getTenantId('strict', OWNER)).toBeNull();
        },
      );
    });
  });
});

describe('escape hatches', () => {
  it('withTenantScope swaps the tenant and keeps the user identity', async () => {
    await withRequester(
      { userId: 'u1', organizationId: 'org-1', tenantId: 't-a' },
      async () => {
        await withTenantScope('t-b', async () => {
          const ctx = requireRequester();
          expect(ctx.tenantId).toBe('t-b');
          expect(ctx.userId).toBe('u1');
          expect(ctx.organizationId).toBe('org-1');
          expect(ctx.tenantScope).toBe('tenant');
        });
        // The outer context is untouched once the callback returns.
        expect(requireRequester().tenantId).toBe('t-a');
      },
    );
  });

  it('withTenantScope(null) selects the null partition', async () => {
    await withRequester(
      { userId: 'u1', organizationId: null, tenantId: 't-a' },
      async () => {
        await withTenantScope(null, async () => {
          expect(getTenantId('strict', OWNER)).toBeNull();
        });
      },
    );
  });

  it('withAllTenants sets tenantScope: all and keeps the tenant readable', async () => {
    await withRequester(
      { userId: 'u1', organizationId: null, tenantId: 't-a' },
      async () => {
        await withAllTenants(async () => {
          const ctx = requireRequester();
          expect(ctx.tenantScope).toBe('all');
          expect(ctx.tenantId).toBe('t-a');
        });
      },
    );
  });

  // Both hatches read `requireRequester()` while building the new context, so
  // they throw SYNCHRONOUSLY rather than returning a rejected promise — the
  // same shape as calling `requireRequester()` directly. A caller that only
  // attaches `.catch()` would miss it, which is why it is pinned here.
  it('withTenantScope requires an outer context — a boundary is still a boundary', () => {
    expect(() => withTenantScope('t-b', async () => 1)).toThrow(
      /No requester context active/,
    );
  });

  it('withAllTenants requires an outer context', () => {
    expect(() => withAllTenants(async () => 1)).toThrow(
      /No requester context active/,
    );
  });

  it('withAllTenants nested inside withTenantScope keeps the inner tenant', async () => {
    await withRequester(
      { userId: 'u1', organizationId: null, tenantId: 't-a' },
      async () => {
        await withTenantScope('t-b', async () => {
          await withAllTenants(async () => {
            expect(requireRequester().tenantId).toBe('t-b');
            expect(requireRequester().tenantScope).toBe('all');
          });
        });
      },
    );
  });
});

describe('propagation', () => {
  it('the tenant survives an await boundary', async () => {
    await withRequester(
      { userId: 'u1', organizationId: null, tenantId: 't-a' },
      async () => {
        await new Promise((r) => setTimeout(r, 1));
        expect(tryGetRequester()?.tenantId).toBe('t-a');
      },
    );
  });

  it('leaves no context behind once the callback returns', async () => {
    await withRequester(
      { userId: 'u1', organizationId: null, tenantId: 't-a' },
      async () => undefined,
    );
    expect(tryGetRequester()).toBeUndefined();
  });
});

describe('SYSTEM_ACTOR_ID', () => {
  it('is a stable sentinel that cannot collide with a real user id', () => {
    expect(SYSTEM_ACTOR_ID).toBe('__system__');
  });
});
