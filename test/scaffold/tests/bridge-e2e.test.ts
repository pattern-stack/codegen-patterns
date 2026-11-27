/**
 * Bridge end-to-end integration tests (BRIDGE-8, ADR-023 Phase 2).
 *
 * **Status: skipped pending scaffold fixture work** — see TODO at
 * bottom. Unit-level coverage in
 * `src/__tests__/runtime/subsystems/bridge.module.spec.ts`,
 * `event-flow.service.spec.ts`, `bridge-outbox-drain-hook.spec.ts`, and
 * `bridge-delivery.drizzle-backend.spec.ts` already pins:
 *   - Drain → bridge_delivery row + the user run started with `JobStarter`
 *     in the event's transaction, trigger 'event', the event's tenant
 *     (JOBS-3; drain hook spec).
 *   - Case B pre-write + ON CONFLICT skip (BRIDGE-7 facade spec, both
 *     against a faked tx and a memory-backed repo).
 *   - Multi-tenancy enforcement at the facade and the Drizzle repo.
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 — see ./_skip-guard.ts.
 */
import { test, expect } from 'bun:test';
import { d } from './_skip-guard';

// The full e2e path requires:
//   (1) an event type registered in the scaffold project's generated
//       event registry,
//   (2) a `defineJob` user job in the scaffold with
//       `jobTriggers('<key>', [{ event: <type>, map: ... }])` beside it,
//   (3) `BridgeModule.forRoot({ backend: 'drizzle' })` wired into the
//       scaffold's AppModule alongside `EventsModule` + `JobsEngineModule`,
//   (4) the codegen-emitted `bridgeRegistry` populated by step (2)'s
//       trigger declaration.
//
// The current `test/scaffold/entities/contact-scaffold.yaml` is intentionally
// minimal (`pattern: Base`, no events, no queries — see header comment
// in that file). Adding a triggered handler + event fixture would
// require either:
//   (a) extending the scaffold YAML to declare a new event type and a
//       triggered handler module, OR
//   (b) writing a parallel `bridge-fixture-scaffold.yaml` and teaching
//       `test/scaffold/run-integration.ts` to mount it alongside the
//       contact scaffold.
//
// Both options exceed the scope of BRIDGE-8 itself (the spec was
// designed around lighter unit coverage). Filing the fixture work as a
// follow-up so the smoke + family integration suites can pick it up.

d('BridgeModule end-to-end (Docker Postgres)', () => {
  test.skip(
    'eventFlow.publish() → drain → bridge_delivery + user run started in the event tx',
    async () => {
      // TODO(BRIDGE-followup): see file header. End-to-end fanout
      // assertion pending fixture event + triggered handler in the
      // scaffold project.
      expect(true).toBe(true);
    },
  );

  test.skip(
    'eventFlow.publishAndStart() Case B — eager run + pre-write + drain skip (single user run)',
    async () => {
      // TODO(BRIDGE-followup): same fixture dependency. The unit-level
      // facade spec covers Case B against a faked tx; lifting that to
      // real Postgres requires the scaffold fixture above.
      expect(true).toBe(true);
    },
  );
});
