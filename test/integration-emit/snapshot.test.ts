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
  test('emitted src/integrations/** tree matches snapshot (package mode)', () => {
    const { integrationsRoot } = emitFixture('package');
    expect(serializeTree(integrationsRoot)).toMatchSnapshot();
  });

  // ADR-037: the emitter now depends on `runtime` mode. The default `package`
  // mode (above) emits `@pattern-stack/codegen/...`; `vendored` mode emits
  // `@shared/...`. Both are snapshotted so neither shape can regress silently.
  test('emitted src/integrations/** tree matches snapshot (vendored mode)', () => {
    const { integrationsRoot } = emitFixture('vendored');
    expect(serializeTree(integrationsRoot)).toMatchSnapshot();
  });

  test('package mode emits @pattern-stack/codegen/subsystems; vendored emits @shared/subsystems (ADR-037)', () => {
    const pkg = serializeTree(emitFixture('package').integrationsRoot);
    const vend = serializeTree(emitFixture('vendored').integrationsRoot);

    // Package mode: the single published barrel; never the vendored alias.
    expect(pkg).toContain("from '@pattern-stack/codegen/subsystems'");
    expect(pkg).not.toContain('@shared/subsystems');

    // Vendored mode: the per-subsystem vendored barrels; never the package.
    expect(vend).toContain("from '@shared/subsystems/auth'");
    expect(vend).toContain("from '@shared/subsystems/integration'");
    expect(vend).not.toContain('@pattern-stack/codegen/subsystems');

    // The R5 load-bearing value import (STRATEGY_REGISTRY) honors the mode in
    // the registry-backed google provider module.
    expect(pkg).toContain("STRATEGY_REGISTRY,\n} from '@pattern-stack/codegen/subsystems'");
    expect(vend).toContain("STRATEGY_REGISTRY,\n} from '@shared/subsystems/auth'");
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
      // registered in changeSources via the auth-only construction (RFC-0003 R5:
      // no provider-level singleton client — adapters build per-connection
      // clients inside enumerate/hydrate from ctx.subscription.externalRef)
      expect(tree).toContain(`${entity}: new ${Class}(this.auth),`);
    }
    // CRM (non-read-primitive) keeps the empty author-filled seam — no read primitive.
    expect(tree).not.toContain('SalesforceAccountIncrementalRead');
  });

  test('RFC-0003 R5: read scaffold threads ctx?: ReadContext through enumerate/hydrate', () => {
    const { integrationsRoot } = emitFixture();
    const tree = serializeTree(integrationsRoot);
    // ReadContext is imported into the read-primitive scaffold's subsystem types.
    expect(tree).toContain('ReadContext,');
    // enumerate gains ctx as the 4th (last) optional param.
    expect(tree).toContain('_ctx?: ReadContext,\n  ): AsyncIterable<Ref[]>');
    // hydrate gains ctx as the 2nd (last) optional param (single-line, biome-clean
    // under lineWidth: 100).
    expect(tree).toContain('protected async hydrate(_ids: string[], _ctx?: ReadContext): Promise<Map<string, unknown>>');
    // The auth-only subclass ctor (no client) is emitted.
    expect(tree).toContain('constructor(private readonly auth: IAuthStrategy) {');
  });

  test('RFC-0003 R5: read-primitive provider module is registry-backed + client-less', () => {
    const { integrationsRoot } = emitFixture();
    const tree = serializeTree(integrationsRoot);
    // google serves only read-primitive surfaces → client-less, registry-backed.
    expect(tree).toContain('export const GOOGLE_AUTH_STRATEGY = Symbol(\'GOOGLE_AUTH_STRATEGY\');');
    expect(tree).toContain("const PROVIDER_SLUG = 'google';");
    expect(tree).toContain('useFactory: (registry: ProviderStrategyRegistry) =>');
    expect(tree).toContain('inject: [STRATEGY_REGISTRY],');
    // The singleton client token is dropped entirely from the google provider module.
    expect(tree).not.toContain('GOOGLE_CLIENT');
    // google adapters inject auth only — no client import/injection.
    expect(tree).not.toContain('@Inject(GOOGLE_CLIENT)');
  });

  test('CRM (salesforce) keeps the client-ful, bare-class provider-module shape — UNCHANGED by R5', () => {
    const { integrationsRoot } = emitFixture();
    const tree = serializeTree(integrationsRoot);
    // salesforce serves crm (not read-primitive) → singleton client retained.
    expect(tree).toContain('export const SALESFORCE_CLIENT = Symbol(\'SALESFORCE_CLIENT\');');
    expect(tree).toContain('{ provide: SALESFORCE_CLIENT, useExisting: SalesforceClient },');
    // The crm adapter still injects the client.
    expect(tree).toContain('@Inject(SALESFORCE_CLIENT) private readonly client: SalesforceClient,');
    // The crm provider module is NOT registry-backed.
    expect(tree).not.toContain('SALESFORCE_AUTH_STRATEGY = Symbol(\'SALESFORCE_AUTH_STRATEGY\');\n\nconst PROVIDER_SLUG');
  });
});
