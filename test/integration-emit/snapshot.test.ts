/**
 * Integration emission snapshot (RFC-0001 §7, Track D · D7).
 *
 * Locks the full emitted `src/integrations/**` tree for the checked-in
 * integration-patterns fixture against drift — the capstone over the per-
 * generator unit tests (provider-module-generator / adapter-emission-generator).
 *
 * Regen flow when emission intentionally changes:
 *   bun test --update-snapshots test/integration-emit/snapshot.test.ts
 * Then review the snapshot diff — every line is load-bearing.
 *
 * Refresh the fixture YAML from a local integration-patterns checkout with:
 *   just refresh-integration-fixture
 * (never auto-synced — the fixture + snapshot are deliberate, reviewed artifacts.)
 */

import { describe, expect, test } from 'bun:test';
import { emitFixture, serializeTree } from './_emit';

describe('integration emission snapshot — integration-patterns fixture', () => {
  test('emitted src/integrations/** tree matches snapshot', () => {
    const { integrationsRoot } = emitFixture();
    expect(serializeTree(integrationsRoot)).toMatchSnapshot();
  });

  test('the crm surface emits the full provider + adapter + registry + typed-view set', () => {
    const { integrationsRoot } = emitFixture();
    const tree = serializeTree(integrationsRoot);
    // Provider module (D2)
    expect(tree).toContain('providers/salesforce/salesforce.provider.module.ts');
    // Adapter scaffold (emit-once) + module (D3)
    expect(tree).toContain('crm/adapters/salesforce/salesforce-crm.adapter.ts');
    expect(tree).toContain('crm/adapters/salesforce/salesforce-crm.adapter.module.ts');
    expect(tree).toContain('// <CODEGEN-SCAFFOLD-V1>');
    // Barrel + tokens + aggregator (D3/D4)
    expect(tree).toContain('crm/adapters/index.ts');
    expect(tree).toContain('crm/crm-adapters.tokens.ts');
    expect(tree).toContain('crm/crm-adapters.module.ts');
    // Typed view (D4 §5)
    expect(tree).toContain('crm/types.generated.ts');
    expect(tree).toContain("export type CrmProvider = 'salesforce';");
    expect(tree).toContain("export type CrmEntity = 'account' | 'contact' | 'opportunity';");
    // Capabilities entities derived from surface: crm
    expect(tree).toContain("entities: ['account', 'contact', 'opportunity']");
  });

  test('no non-crm surface is emitted (the fixture provider serves only crm)', () => {
    const { skippedSurfaces } = emitFixture();
    expect(skippedSurfaces).toEqual([]);
  });
});
