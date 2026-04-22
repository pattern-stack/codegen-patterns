/**
 * Compile-time + runtime tests for the bridge protocols (BRIDGE-2).
 *
 * The interfaces have no runtime code — these tests assert that:
 *   1. Stub implementations of `IJobBridge` and `IEventFlow` typecheck
 *      against the contract WITHOUT casts (catches accidental signature
 *      drift).
 *   2. The DI tokens are string-valued (token convention from EVT-6).
 *   3. `MissingTenantIdError` carries the call-site name in its message.
 */
import { describe, it, expect } from 'bun:test';

import {
  BRIDGE_DELIVERY_REPO,
  BRIDGE_MODULE_OPTIONS,
  BRIDGE_MULTI_TENANT,
  BRIDGE_REGISTRY,
  EVENT_FLOW,
  MissingTenantIdError,
  type BridgeDeliveryInsert,
  type BridgeDeliveryRecord,
  type IEventFlow,
  type IJobBridge,
  type PublishAndStartResult,
} from '../../../../runtime/subsystems/bridge';
import type { EventOfType } from '../../../../runtime/subsystems/events/generated/types';

describe('bridge.tokens — DI tokens', () => {
  it('all tokens are string-valued (matches events-subsystem convention)', () => {
    // Per EVT-6, string tokens compare by value across import boundaries.
    // The bridge subsystem follows that convention rather than the jobs
    // subsystem's Symbols (the file-local consistency call is documented
    // in bridge.tokens.ts).
    expect(typeof BRIDGE_DELIVERY_REPO).toBe('string');
    expect(typeof EVENT_FLOW).toBe('string');
    expect(typeof BRIDGE_MULTI_TENANT).toBe('string');
    expect(typeof BRIDGE_MODULE_OPTIONS).toBe('string');
    expect(typeof BRIDGE_REGISTRY).toBe('string');
  });

  it('token values match their identifier names (grep-friendly)', () => {
    expect(BRIDGE_DELIVERY_REPO).toBe('BRIDGE_DELIVERY_REPO');
    expect(EVENT_FLOW).toBe('EVENT_FLOW');
    expect(BRIDGE_MULTI_TENANT).toBe('BRIDGE_MULTI_TENANT');
    expect(BRIDGE_MODULE_OPTIONS).toBe('BRIDGE_MODULE_OPTIONS');
    expect(BRIDGE_REGISTRY).toBe('BRIDGE_REGISTRY');
  });
});

describe('MissingTenantIdError', () => {
  it('carries the call-site name in its message and exposes it as a field', () => {
    const err = new MissingTenantIdError('EventFlowService.publishAndStart');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MissingTenantIdError');
    expect(err.callSite).toBe('EventFlowService.publishAndStart');
    expect(err.message).toContain('EventFlowService.publishAndStart');
    expect(err.message).toContain('multiTenant=true');
  });
});

describe('IJobBridge — stub implementation typechecks', () => {
  // The stub does not need to do anything; the test value is the type
  // constraint. If any method signature drifts in the protocol, this stub
  // will stop compiling.
  class StubBridge implements IJobBridge {
    private rows: BridgeDeliveryRecord[] = [];
    async insertDelivery(_row: BridgeDeliveryInsert): Promise<void> {
      // intentionally empty
    }
    async findDelivery(
      _eventId: string,
      _triggerId: string,
    ): Promise<BridgeDeliveryRecord | null> {
      return null;
    }
    async markDelivered(_id: string, _userRunId: string): Promise<void> {
      // intentionally empty
    }
    async markSkipped(_id: string, _reason: string): Promise<void> {
      // intentionally empty
    }
    async markFailed(
      _id: string,
      _error: Record<string, unknown>,
    ): Promise<void> {
      // intentionally empty
    }
  }

  it('instantiates and implements every method', () => {
    const stub: IJobBridge = new StubBridge();
    expect(typeof stub.insertDelivery).toBe('function');
    expect(typeof stub.findDelivery).toBe('function');
    expect(typeof stub.markDelivered).toBe('function');
    expect(typeof stub.markSkipped).toBe('function');
    expect(typeof stub.markFailed).toBe('function');
  });
});

describe('IEventFlow — stub implementation typechecks', () => {
  class StubFlow implements IEventFlow {
    async publish<T extends import('../../../../runtime/subsystems/events/generated/types').EventTypeName>(
      _event: EventOfType<T>,
    ): Promise<void> {
      // intentionally empty
    }
    async publishAndStart<T extends import('../../../../runtime/subsystems/events/generated/types').EventTypeName>(
      _event: EventOfType<T>,
      _jobType: string,
      _input: unknown,
    ): Promise<PublishAndStartResult> {
      return { runId: 'stub-run' };
    }
  }

  it('instantiates and returns a runId from publishAndStart', async () => {
    const flow: IEventFlow = new StubFlow();
    expect(typeof flow.publish).toBe('function');
    const result = await flow.publishAndStart(
      // Use a real generated event shape to prove the typing flows through.
      {
        id: '00000000-0000-0000-0000-000000000000',
        type: 'contact_created',
        aggregateId: 'agg',
        aggregateType: 'contact',
        payload: {
          accountId: null,
          contactId: 'c1',
          createdBy: 'system',
        },
        occurredAt: new Date(),
      },
      'send_welcome_email',
      { contactId: 'c1' },
      { tenantId: null },
    );
    expect(result.runId).toBe('stub-run');
  });

  it('publishAndStart accepts explicit null tenantId for cross-tenant work', async () => {
    // Compile-time check: the option must accept `null` as well as
    // `string` and `undefined`. JOB-8 contract.
    const flow: IEventFlow = new StubFlow();
    await flow.publishAndStart(
      {
        id: '00000000-0000-0000-0000-000000000001',
        type: 'contact_created',
        aggregateId: 'agg',
        aggregateType: 'contact',
        payload: { accountId: null, contactId: 'c1', createdBy: 'system' },
        occurredAt: new Date(),
      },
      'job-x',
      {},
      { tenantId: null, parentRunId: 'parent-1' },
    );
  });
});
