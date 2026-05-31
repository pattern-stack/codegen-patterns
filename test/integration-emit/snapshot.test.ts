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

  test('the interaction surfaces (google: calendar/mail/transcript) emit — nothing skipped', () => {
    const { integrationsRoot, skippedSurfaces } = emitFixture();
    const tree = serializeTree(integrationsRoot);
    // google is a multi-surface interaction provider; all three surfaces are
    // registered in SURFACE_REGISTRY (#418), so they emit rather than skip.
    expect(skippedSurfaces).toEqual([]);
    expect(tree).toContain('providers/google/google.provider.module.ts');
    for (const [surface, entity, Port] of [
      ['calendar', 'meeting', 'CalendarPort'],
      ['mail', 'email', 'MailPort'],
      ['transcript', 'transcript', 'TranscriptPort'],
    ] as const) {
      expect(tree).toContain(`${surface}/adapters/google/google-${surface}.adapter.ts`);
      expect(tree).toContain(`${surface}/${surface}-adapters.module.ts`);
      expect(tree).toContain(`${surface}/types.generated.ts`);
      expect(tree).toContain(`implements ${Port}`);
      expect(tree).toContain(`entities: ['${entity}']`);
    }
  });

  test('interaction adapters emit the RFC-0003 read primitive (IncrementalReadBase + changeSources)', () => {
    const { integrationsRoot } = emitFixture();
    const tree = serializeTree(integrationsRoot);
    for (const [entity, Canonical, Class] of [
      ['meeting', 'CanonicalMeeting', 'GoogleMeetingIncrementalRead'],
      ['email', 'CanonicalEmail', 'GoogleEmailIncrementalRead'],
      ['transcript', 'CanonicalTranscript', 'GoogleTranscriptIncrementalRead'],
    ] as const) {
      // fork #1: subclass typed on the surface package's canonical T + ResolvedFilter[]
      expect(tree).toContain(
        `export class ${Class} extends IncrementalReadBase<${Canonical}, ResolvedFilter[]>`,
      );
      // fork #2: static detection-filter const returned by filterFor (empty — fixtures carry no detection)
      expect(tree).toContain(`const ${entity.toUpperCase()}_DETECTION_FILTERS: ResolvedFilter[] = [];`);
      // registered in changeSources via the preserved 2-arg construction
      expect(tree).toContain(`${entity}: new ${Class}(this.auth, this.client),`);
    }
    // CRM (non-read-primitive) keeps the empty author-filled seam — no read primitive.
    expect(tree).not.toContain('SalesforceAccountIncrementalRead');
  });
});
