/**
 * Bridge end-to-end integration tests (BRIDGE-8, ADR-023 Phase 2).
 *
 * **Status: skipped pending scaffold fixture work** — see TODO at
 * bottom. Unit-level coverage in
 * `src/__tests__/runtime/subsystems/bridge.module.spec.ts`,
 * `bridge-delivery-handler.spec.ts`, `event-flow.service.spec.ts`,
 * `bridge-outbox-drain-hook.spec.ts`, and
 * `bridge-delivery.drizzle-backend.spec.ts` already pins:
 *   - Drain → bridge_delivery + wrapper insert (BRIDGE-4 hook spec).
 *   - Wrapper handler → user job spawn + parent_run_id + trigger_source
 *     + trigger_ref + tenant_id threading (BRIDGE-5 handler spec).
 *   - Case B pre-write + ON CONFLICT skip (BRIDGE-7 facade spec, both
 *     against a faked tx and a memory-backed repo).
 *   - Multi-tenancy enforcement at all three sites (BRIDGE-7,
 *     BRIDGE-5, BRIDGE-8 specs respectively).
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 — see ./_skip-guard.ts.
 */
import { test, expect } from 'bun:test';
import { d } from './_skip-guard';

// The full e2e path requires:
//   (1) an event type registered in the scaffold project's generated
//       event registry,
//   (2) a `@JobHandler({ triggers: [{ on: <type>, map: ... }] })`
//       registered on a user job in the scaffold,
//   (3) `BridgeModule.forRoot({ backend: 'drizzle' })` wired into the
//       scaffold's AppModule alongside `EventsModule` + `JobWorkerModule`
//       with all three reserved pools active,
//   (4) the codegen-emitted `bridgeRegistry` populated by step (2)'s
//       trigger declaration.
//
// The current `test/scaffold/contact-scaffold.yaml` is intentionally
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
    'eventFlow.publish() → drain → bridge_delivery + wrapper → user job spawn',
    async () => {
      // TODO(BRIDGE-followup): see file header. End-to-end fanout
      // assertion pending fixture event + triggered handler in the
      // scaffold project.
      expect(true).toBe(true);
    },
  );

  test.skip(
    'eventFlow.publishAndStart() Case B — eager run + pre-write + drain skip (single user job_run, no orphan wrapper)',
    async () => {
      // TODO(BRIDGE-followup): same fixture dependency. The unit-level
      // facade spec covers Case B against a faked tx; lifting that to
      // real Postgres requires the scaffold fixture above.
      expect(true).toBe(true);
    },
  );
});
