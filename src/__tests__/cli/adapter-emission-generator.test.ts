/**
 * Template-emission tests for D3 adapter emission (RFC-0001 §2/§4).
 *
 * Baseline covers clean-arch only, so these explicitly assert the emitted
 * adapter scaffold / module / barrel / tokens / surface-aggregator, the
 * emit-once sentinel behaviour, and the surface-without-a-port skip. Reuses the
 * D1 provider fixtures (hubspot → crm; google → calendar/mail/transcript).
 */

import { describe, it, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import {
  emitAdapters,
  generateAdapterScaffold,
  collectEntitiesBySurface,
  type EmitAdaptersResult,
} from '../../cli/shared/adapter-emission-generator';
import { loadProviderFromYaml } from '../../utils/yaml-loader';

const FIX = resolve(import.meta.dir, '../parser/fixtures/providers');

function loadDef(name: string) {
  const r = loadProviderFromYaml(resolve(FIX, name));
  if (!r.success) throw new Error(`fixture ${name} failed`);
  return r.definition;
}

const ENTITIES = [
  { entity: { name: 'deal' }, surface: 'crm' },
  { entity: { name: 'account' }, surface: 'crm' },
  { entity: { name: 'calendar_event' }, surface: 'calendar' },
  { entity: { name: 'email' }, surface: 'mail' },
  { entity: { name: 'no_surface' } },
];

function loadedProviders() {
  return [
    { definition: loadDef('hubspot.yaml'), filePath: resolve(FIX, 'hubspot.yaml') },
    { definition: loadDef('google.yaml'), filePath: resolve(FIX, 'google.yaml') },
  ];
}

describe('collectEntitiesBySurface', () => {
  it('groups entity names by surface, sorted, ignoring surfaceless entities', () => {
    const m = collectEntitiesBySurface(ENTITIES);
    expect(m.get('crm')).toEqual(['account', 'deal']);
    expect(m.get('calendar')).toEqual(['calendar_event']);
    expect(m.has('undefined')).toBe(false);
  });
});

describe('generateAdapterScaffold', () => {
  const out = generateAdapterScaffold(loadDef('hubspot.yaml'), 'crm', ['account', 'deal']);

  it('carries the emit-once sentinel as the first line', () => {
    expect(out.startsWith('// <CODEGEN-SCAFFOLD-V1>')).toBe(true);
  });

  it('implements CrmPort and names the class <Provider><Surface>Adapter', () => {
    expect(out).toContain('export class HubspotCrmAdapter implements CrmPort');
  });

  it('imports the port + L2 vocab from the surface package and L1 from codegen', () => {
    expect(out).toContain("from '@pattern-stack/codegen-crm'");
    expect(out).toContain("from '@pattern-stack/codegen/subsystems'");
    expect(out).toContain('IFieldDefinitionReader');
  });

  it('declares capabilities with entities derived from surface:', () => {
    expect(out).toContain('fieldDefinitions: true');
    expect(out).toContain("entities: ['account', 'deal']");
    expect(out).toContain('...NO_CRM_CAPABILITIES');
  });

  it('injects L1 strategy + client + entity sources registry', () => {
    expect(out).toContain('@Inject(HUBSPOT_AUTH_STRATEGY) readonly auth: IAuthStrategy');
    expect(out).toContain('@Inject(HUBSPOT_CLIENT) private readonly client: HubspotClient');
    expect(out).toContain(
      '@Inject(CRM_ENTITY_SOURCES) readonly sources: IEntityChangeSourceRegistry',
    );
  });

  it('stubs every L2 method with a not-implemented throw', () => {
    expect(out).toContain("throw new Error('not implemented: HubspotCrmAdapter.fields.list')");
    expect(out).toContain("throw new Error('not implemented: HubspotCrmAdapter.picklists.values')");
    expect(out).toContain(
      "throw new Error('not implemented: HubspotCrmAdapter.associations.list')",
    );
  });

  it('emits the surface-only methods marker', () => {
    expect(out).toContain('// surface-only methods (optional on CrmPort): add here');
  });
});

describe('emitAdapters — orchestration', () => {
  function run(outRoot: string, dryRun = false): EmitAdaptersResult {
    return emitAdapters({
      providers: loadedProviders(),
      entities: ENTITIES,
      outputRoot: outRoot,
      dryRun,
    });
  }

  it('emits the crm surface and skips surfaces with no port package', () => {
    const outRoot = mkdtempSync(join(tmpdir(), 'cgp-d3-'));
    const res = run(outRoot);

    // hubspot serves crm (emittable); google serves calendar/mail/transcript (skipped).
    expect(res.scaffoldsWritten).toHaveLength(1);
    expect(existsSync(join(outRoot, 'crm/adapters/hubspot/hubspot-crm.adapter.ts'))).toBe(true);
    expect(existsSync(join(outRoot, 'crm/adapters/hubspot/hubspot-crm.adapter.module.ts'))).toBe(
      true,
    );
    expect(existsSync(join(outRoot, 'crm/adapters/index.ts'))).toBe(true);
    expect(existsSync(join(outRoot, 'crm/crm-adapters.tokens.ts'))).toBe(true);
    expect(existsSync(join(outRoot, 'crm/crm-adapters.module.ts'))).toBe(true);

    const skippedSurfaces = res.skippedSurfaces.map((s) => `${s.provider}:${s.surface}`).sort();
    expect(skippedSurfaces).toEqual(['google:calendar', 'google:mail', 'google:transcript']);
    // No calendar/mail/transcript tree emitted.
    expect(existsSync(join(outRoot, 'calendar'))).toBe(false);
  });

  it('barrel + aggregator + tokens reference the adapter and registry tokens', () => {
    const outRoot = mkdtempSync(join(tmpdir(), 'cgp-d3-'));
    run(outRoot);
    const barrel = readFileSync(join(outRoot, 'crm/adapters/index.ts'), 'utf-8');
    expect(barrel).toContain(
      "export { HubspotCrmAdapterModule } from './hubspot/hubspot-crm.adapter.module'",
    );
    const tokens = readFileSync(join(outRoot, 'crm/crm-adapters.tokens.ts'), 'utf-8');
    expect(tokens).toContain('CRM_ADAPTER_CONTRIBUTIONS');
    expect(tokens).toContain('CRM_ENTITY_SOURCES');
    const agg = readFileSync(join(outRoot, 'crm/crm-adapters.module.ts'), 'utf-8');
    expect(agg).toContain('export class CrmAdaptersModule');
    expect(agg).toContain('provideCrmEntitySources');
    expect(agg).toContain('MemoryEntityChangeSourceRegistry');
  });

  it('all @generated files carry the banner; the scaffold does NOT', () => {
    const outRoot = mkdtempSync(join(tmpdir(), 'cgp-d3-'));
    run(outRoot);
    const mod = readFileSync(join(outRoot, 'crm/adapters/hubspot/hubspot-crm.adapter.module.ts'), 'utf-8');
    expect(mod).toContain('@generated by @pattern-stack/codegen');
    const scaffold = readFileSync(join(outRoot, 'crm/adapters/hubspot/hubspot-crm.adapter.ts'), 'utf-8');
    expect(scaffold).not.toContain('@generated by @pattern-stack/codegen');
  });

  it('EMIT-ONCE: a second run skips the existing scaffold but re-emits @generated files', () => {
    const outRoot = mkdtempSync(join(tmpdir(), 'cgp-d3-'));
    run(outRoot);
    // Author edits the scaffold.
    const scaffoldPath = join(outRoot, 'crm/adapters/hubspot/hubspot-crm.adapter.ts');
    const edited = readFileSync(scaffoldPath, 'utf-8') + '\n// author edit\n';
    writeFileSync(scaffoldPath, edited);

    const res2 = run(outRoot);
    expect(res2.scaffoldsSkipped).toContain(scaffoldPath);
    expect(res2.scaffoldsWritten).toHaveLength(0);
    // Author edit preserved.
    expect(readFileSync(scaffoldPath, 'utf-8')).toBe(edited);
  });

  it('idempotent: @generated files are byte-identical on re-emit', () => {
    const outRoot = mkdtempSync(join(tmpdir(), 'cgp-d3-'));
    run(outRoot);
    const aggPath = join(outRoot, 'crm/crm-adapters.module.ts');
    const first = readFileSync(aggPath, 'utf-8');
    run(outRoot);
    expect(readFileSync(aggPath, 'utf-8')).toBe(first);
  });

  it('dryRun writes nothing', () => {
    const outRoot = mkdtempSync(join(tmpdir(), 'cgp-d3-'));
    const res = run(outRoot, true);
    expect(res.written.length).toBeGreaterThan(0);
    expect(existsSync(join(outRoot, 'crm'))).toBe(false);
  });
});
