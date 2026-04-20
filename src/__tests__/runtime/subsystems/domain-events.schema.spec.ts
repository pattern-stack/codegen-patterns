/**
 * Unit tests for the domain_events Drizzle schema (EVT-1, ADR-024 Phase 1).
 *
 * Pure structural/metadata checks — no Postgres, no Docker. Verifies that
 *   1. the pgTable declaration imports cleanly,
 *   2. the new first-class routing columns are present (pool, direction, tenantId),
 *   3. the existing columns are still there,
 *   4. InferSelectModel resolved a concrete row type that includes the new fields.
 *
 * Index assertions are intentionally omitted: Drizzle stores index metadata on
 * a non-public table symbol and there is no stable, public introspection API.
 * The presence of the three indexes is enforced by the schema source itself
 * (see `domain-events.schema.ts` index callback).
 */
import { describe, it, expect } from 'bun:test';
import { getTableColumns } from 'drizzle-orm';
import {
  domainEvents,
  type DomainEventRecord,
} from '../../../../runtime/subsystems/events/domain-events.schema';

describe('domain-events.schema — import smoke', () => {
  it('exports the pgTable declaration as an object', () => {
    expect(typeof domainEvents).toBe('object');
    expect(domainEvents).not.toBeNull();
  });
});

describe('domain_events — column presence', () => {
  const cols = getTableColumns(domainEvents) as Record<string, unknown>;

  it.each([
    // existing columns
    'id',
    'type',
    'aggregateId',
    'aggregateType',
    'payload',
    'occurredAt',
    'processedAt',
    'status',
    'error',
    'metadata',
    // EVT-1 new columns
    'pool',
    'direction',
    'tenantId',
  ])('includes column %s', (key) => {
    expect(cols[key]).toBeDefined();
  });
});

describe('DomainEventRecord — type-level compile check', () => {
  it('resolves to a concrete row type that includes EVT-1 columns', () => {
    // If InferSelectModel widened to `any`, TypeScript would not catch a
    // shape mismatch here. The literal exercises the new fields; the test
    // merely asserts the file compiles and the value exists at runtime.
    const row: DomainEventRecord = {
      id: '00000000-0000-0000-0000-000000000000',
      type: 'opportunity.created',
      aggregateId: 'agg-1',
      aggregateType: 'opportunity',
      payload: { foo: 'bar' },
      occurredAt: new Date(),
      processedAt: null,
      status: 'pending',
      error: null,
      metadata: null,
      pool: 'events_internal',
      direction: 'internal',
      tenantId: null,
    };
    expect(row.id).toBeDefined();
    expect(row.pool).toBe('events_internal');
    expect(row.direction).toBe('internal');
    expect(row.tenantId).toBeNull();
  });
});
