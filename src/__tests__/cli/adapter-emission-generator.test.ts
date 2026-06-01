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
  generateAdapterModule,
  generateSurfaceAggregator,
  generateSurfaceTokens,
  generateTypedView,
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
  { entity: { name: 'deal', surface: 'crm' } },
  { entity: { name: 'account', surface: 'crm' } },
  { entity: { name: 'calendar_event', surface: 'calendar' } },
  { entity: { name: 'email', surface: 'mail' } },
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

  it('injects L1 strategy + client (no registry back-edge)', () => {
    expect(out).toContain('@Inject(HUBSPOT_AUTH_STRATEGY) readonly auth: IAuthStrategy');
    expect(out).toContain('@Inject(HUBSPOT_CLIENT) private readonly client: HubspotClient');
    // E0: the vestigial registry back-edge is gone — the adapter no longer
    // injects CRM_ENTITY_SOURCES / IEntityChangeSourceRegistry, nor imports
    // the registry type or the *-adapters.tokens module. (The descriptive
    // changeSources doc comment still names the registry it feeds — that prose
    // is accurate and is not the back-edge.)
    expect(out).not.toContain('@Inject(CRM_ENTITY_SOURCES)');
    expect(out).not.toContain('readonly sources: IEntityChangeSourceRegistry');
    expect(out).not.toContain("from '../../crm-adapters.tokens'");
    expect(out).not.toMatch(/import[^;]*IEntityChangeSourceRegistry/);
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

  it('emits every registered surface — crm (hubspot) + calendar/mail/transcript (google)', () => {
    const outRoot = mkdtempSync(join(tmpdir(), 'cgp-d3-'));
    const res = run(outRoot);

    // All four surfaces are registered in SURFACE_REGISTRY, so both providers
    // emit: hubspot→crm, google→calendar/mail/transcript. One scaffold each.
    expect(res.scaffoldsWritten).toHaveLength(4);
    expect(existsSync(join(outRoot, 'crm/adapters/hubspot/hubspot-crm.adapter.ts'))).toBe(true);
    expect(existsSync(join(outRoot, 'crm/crm-adapters.module.ts'))).toBe(true);
    for (const surface of ['calendar', 'mail', 'transcript']) {
      expect(
        existsSync(join(outRoot, `${surface}/adapters/google/google-${surface}.adapter.ts`)),
      ).toBe(true);
      expect(existsSync(join(outRoot, `${surface}/${surface}-adapters.module.ts`))).toBe(true);
      expect(existsSync(join(outRoot, `${surface}/types.generated.ts`))).toBe(true);
    }
    // Nothing skipped — every served surface has a registered port package.
    expect(res.skippedSurfaces).toEqual([]);
  });

  it('skips a surface with no registered port package (with a clear reason)', () => {
    const outRoot = mkdtempSync(join(tmpdir(), 'cgp-d3-'));
    // Synthesize a provider serving an unregistered surface.
    const base = loadDef('hubspot.yaml');
    const smsProvider = {
      definition: { ...base, slug: 'twilio', surfaces: ['sms'] },
      filePath: '/x/twilio.yaml',
    };
    const res = emitAdapters({
      providers: [smsProvider],
      entities: ENTITIES,
      outputRoot: outRoot,
    });
    expect(res.scaffoldsWritten).toEqual([]);
    expect(res.skippedSurfaces).toHaveLength(1);
    expect(res.skippedSurfaces[0]).toMatchObject({ provider: 'twilio', surface: 'sms' });
    expect(res.skippedSurfaces[0].reason).toContain("no surface package for 'sms'");
    expect(existsSync(join(outRoot, 'sms'))).toBe(false);
  });

  it('an interaction-surface scaffold (no L2 ports) emits the read primitive (RFC-0003 R3)', () => {
    const calendar = generateAdapterScaffold(loadDef('google.yaml'), 'calendar', ['meeting']);
    expect(calendar).toContain('export class GoogleCalendarAdapter implements CalendarPort');
    expect(calendar).toContain("from '@pattern-stack/codegen-calendar'");
    expect(calendar).toContain("entities: ['meeting']");
    // No L2 readers/flags on an incremental-read surface.
    expect(calendar).not.toContain('IFieldDefinitionReader');
    expect(calendar).not.toContain('fieldDefinitions: true');
    // no registry back-edge (E0)
    expect(calendar).not.toContain('readonly sources: IEntityChangeSourceRegistry');
    expect(calendar).not.toMatch(/import[^;]*IEntityChangeSourceRegistry/);

    // RFC-0003 R3: per-entity IncrementalReadBase subclass + changeSources registration.
    expect(calendar).toContain(
      'import { IncrementalReadBase } from \'@pattern-stack/codegen/subsystems\'',
    );
    expect(calendar).toContain('  CanonicalMeeting,'); // fork #1: T from the surface package
    expect(calendar).toContain(
      'export class GoogleMeetingIncrementalRead extends IncrementalReadBase<CanonicalMeeting, ResolvedFilter[]>',
    );
    expect(calendar).toContain("readonly label = 'google-calendar-meeting';");
    expect(calendar).toContain('protected override readonly filterPushdown = false;');
    // fork #2: static detection-filter const + filterFor returning it
    expect(calendar).toContain('const MEETING_DETECTION_FILTERS: ResolvedFilter[] = [];');
    expect(calendar).toContain('return MEETING_DETECTION_FILTERS;');
    // RFC-0003 R5: auth-only construction (no provider-level singleton client);
    // assigned in the constructor BODY (not a field init).
    expect(calendar).toContain('this.changeSources = {');
    expect(calendar).toContain('meeting: new GoogleMeetingIncrementalRead(this.auth),');
    expect(calendar).toContain('readonly changeSources: Record<string, IChangeSource<unknown>>;');
    // the subclass ctor injects auth only; no client import/injection.
    expect(calendar).toContain('constructor(private readonly auth: IAuthStrategy) {');
    expect(calendar).not.toContain('@Inject(GOOGLE_CLIENT)');
    expect(calendar).not.toContain('GoogleClient');
    // RFC-0003 R5: ctx?: ReadContext threaded through enumerate + hydrate.
    expect(calendar).toContain('  ReadContext,');
    expect(calendar).toContain('_ctx?: ReadContext,');
    // the three vendor methods are stubbed for the author to fill
    expect(calendar).toContain('not implemented: GoogleMeetingIncrementalRead.enumerate');
    expect(calendar).toContain('not implemented: GoogleMeetingIncrementalRead.hydrate');
    expect(calendar).toContain('not implemented: GoogleMeetingIncrementalRead.toCanonical');
    // no detection ⇒ no cursorDivisible override (defaults to divisible)
    expect(calendar).not.toContain('cursorDivisible');
  });

  it('threads detection → static filter const + atomic cursorDivisible (RFC-0003 R3 / R2)', () => {
    // Synthetic detection for google/email: Gmail historyId (atomic) + one filter.
    const detection = new Map([
      [
        'email',
        {
          mode: 'poll' as const,
          poll: { cursor: { kind: 'historyId' as const, field: 'historyId' } },
          mapping: [{ source: 'id', target: 'external_id' }],
          filters: [{ field: 'labelIds', op: 'in' as const, value: ['INBOX'] }],
        },
      ],
    ]);
    const mail = generateAdapterScaffold(loadDef('google.yaml'), 'mail', ['email'], detection);
    // fork #2: filters emitted verbatim into the static const
    expect(mail).toContain("{ field: \"labelIds\", op: \"in\", value: [\"INBOX\"] }");
    expect(mail).toContain('const EMAIL_DETECTION_FILTERS: ResolvedFilter[] = [');
    // R2 wiring: historyId is atomic ⇒ cursorDivisible override emitted
    expect(mail).toContain('protected override readonly cursorDivisible = false;');
    expect(mail).toContain('historyId');
  });

  it('a divisible cursor (timestamp) emits NO cursorDivisible override', () => {
    const detection = new Map([
      [
        'transcript',
        {
          mode: 'poll' as const,
          poll: { cursor: { kind: 'timestamp' as const, field: 'modifiedAt' } },
          mapping: [{ source: 'id', target: 'external_id' }],
          filters: [],
        },
      ],
    ]);
    const out = generateAdapterScaffold(loadDef('google.yaml'), 'transcript', ['transcript'], detection);
    expect(out).toContain('export class GoogleTranscriptIncrementalRead');
    expect(out).not.toContain('cursorDivisible'); // timestamp is divisible (the base default)
  });

  it('a non-read-primitive surface (crm) keeps the empty author-filled changeSources seam', () => {
    const crm = generateAdapterScaffold(loadDef('hubspot.yaml'), 'crm', ['account', 'deal']);
    expect(crm).toContain('readonly changeSources: Record<string, IChangeSource<unknown>> = {};');
    expect(crm).not.toContain('IncrementalReadBase');
    expect(crm).not.toContain('IncrementalRead<');
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

  it('emits the per-surface typed view (D4 §5)', () => {
    const outRoot = mkdtempSync(join(tmpdir(), 'cgp-d4-'));
    run(outRoot);
    expect(existsSync(join(outRoot, 'crm/types.generated.ts'))).toBe(true);
  });
});

// ── D4: full registry contract + typed view + scaffold contribution seam ─────

describe('D4 — registry token contract + multi-assembly', () => {
  it('the scaffold exposes a changeSources map feeding the contribution', () => {
    const scaffold = generateAdapterScaffold(loadDef('hubspot.yaml'), 'crm', ['deal']);
    expect(scaffold).toContain('readonly changeSources: Record<string, IChangeSource<unknown>> = {}');
    expect(scaffold).toContain('IChangeSource');
  });

  it('the adapter module just provides + exports the adapter (no D3 placeholder)', () => {
    const mod = generateAdapterModule(loadDef('hubspot.yaml'), 'crm');
    expect(mod).toContain('providers: [HubspotCrmAdapter]');
    expect(mod).toContain('exports: [HubspotCrmAdapter]');
    expect(mod).not.toContain('sources: {}'); // the D3 // D4: placeholder is gone
    expect(mod).not.toContain('CRM_ADAPTER_CONTRIBUTIONS'); // assembled centrally now
  });

  it('tokens file exports the full contract', () => {
    const tokens = generateSurfaceTokens('crm');
    expect(tokens).toContain('export const CRM_ADAPTER_CONTRIBUTIONS');
    expect(tokens).toContain('export const CRM_ENTITY_SOURCES');
    expect(tokens).toContain('export interface AdapterContribution');
    expect(tokens).not.toContain('D4 owns'); // no longer a placeholder
  });

  it('the aggregator assembles contributions by direct adapter injection and folds', () => {
    const agg = generateSurfaceAggregator('crm', ['hubspot', 'salesforce']);
    // imports each adapter class + module
    expect(agg).toContain("import { HubspotCrmAdapter } from './adapters/hubspot/hubspot-crm.adapter'");
    expect(agg).toContain('HubspotCrmAdapterModule');
    // provides the assembled CONTRIBUTIONS array...
    expect(agg).toContain('provide: CRM_ADAPTER_CONTRIBUTIONS');
    expect(agg).toContain("{ provider: 'hubspot', sources: hubspotCrmAdapter.changeSources }");
    expect(agg).toContain("{ provider: 'salesforce', sources: salesforceCrmAdapter.changeSources }");
    expect(agg).toContain('inject: [HubspotCrmAdapter, SalesforceCrmAdapter]');
    // ...and the folded registry
    expect(agg).toContain('provide: CRM_ENTITY_SOURCES');
    expect(agg).toContain('inject: [CRM_ADAPTER_CONTRIBUTIONS]');
    // entity-keyed collision is an ambiguous-source boot error
    expect(agg).toContain('ambiguous change source');
    expect(agg).toContain('new MemoryEntityChangeSourceRegistry');
  });
});

describe('D4 — per-consumer typed view (§5)', () => {
  it('emits surface-scoped provider + entity unions and a validity map', () => {
    const view = generateTypedView('crm', ['hubspot', 'salesforce'], ['deal', 'account']);
    expect(view).toContain("export type CrmProvider = 'hubspot' | 'salesforce';");
    expect(view).toContain("export type CrmEntity = 'account' | 'deal';"); // sorted
    expect(view).toContain('export interface CrmProviderEntities {');
    expect(view).toContain('hubspot: CrmEntity;');
    expect(view).toContain('@generated by @pattern-stack/codegen');
  });

  it('degrades to never-unions when a surface has no providers/entities', () => {
    const view = generateTypedView('crm', [], []);
    expect(view).toContain('export type CrmProvider = never;');
    expect(view).toContain('export type CrmEntity = never;');
  });

  it('quotes kebab-slug keys in the validity map', () => {
    const view = generateTypedView('crm', ['hubspot-crm'], ['deal']);
    expect(view).toContain("'hubspot-crm': CrmEntity;");
  });
});

describe('E2 — per-entity assembly + sink + integration tokens', () => {
  // Mix Integrated + non-Integrated surface entities to cover both the emit
  // path and the recorded-skip path. Provide backend_src + an `@modules` alias.
  const ASSEMBLY_ENTITIES = [
    {
      entity: { name: 'meeting', surface: 'calendar', pattern: 'Integrated', plural: 'meetings' },
      fields: { title: { type: 'string' }, starts_at: { type: 'datetime', nullable: true } },
    },
    // calendar entity WITHOUT pattern: Integrated → recorded skip, not a crash.
    { entity: { name: 'reminder', surface: 'calendar', plural: 'reminders' } },
  ];

  function runAssembly(outRoot: string) {
    return emitAdapters({
      providers: [{ definition: loadDef('google.yaml'), filePath: resolve(FIX, 'google.yaml') }],
      entities: ASSEMBLY_ENTITIES,
      outputRoot: outRoot,
      backendSrcAbs: '/proj/src',
      aliases: { '@modules': '/proj/src/modules' },
      dryRun: true,
    });
  }

  it('emits an assembly module + sink + tokens for an Integrated entity', () => {
    const outRoot = mkdtempSync(join(tmpdir(), 'cgp-e2-'));
    const res = emitAdapters({
      providers: [{ definition: loadDef('google.yaml'), filePath: resolve(FIX, 'google.yaml') }],
      entities: [ASSEMBLY_ENTITIES[0]],
      outputRoot: outRoot,
      backendSrcAbs: '/proj/src',
      aliases: { '@modules': '/proj/src/modules' },
    });

    const assemblyPath = join(outRoot, 'calendar/modules/google/meeting-integration.module.ts');
    expect(existsSync(assemblyPath)).toBe(true);
    expect(res.assembliesWritten).toContain(assemblyPath);
    const mod = readFileSync(assemblyPath, 'utf-8');
    expect(mod).toContain('export class MeetingIntegrationModule__Google {}');
    expect(mod).toContain(
      "useFactory: (adapter: GoogleCalendarAdapter) => adapter.changeSources.meeting,",
    );
    expect(mod).toContain(
      "import { MeetingRepository } from '@modules/meetings/meeting.repository';",
    );
    expect(mod).toContain(
      "import { MeetingsModule } from '@modules/meetings/meetings.module';",
    );

    // Sink (emit-once) + tokens file.
    const sinkPath = join(outRoot, 'calendar/sinks/meeting.sink.ts');
    expect(existsSync(sinkPath)).toBe(true);
    expect(res.scaffoldsWritten).toContain(sinkPath);
    const sink = readFileSync(sinkPath, 'utf-8');
    expect(sink).toContain('export class MeetingSink');
    expect(sink).toContain('title: record.title,');

    const tokensPath = join(outRoot, 'calendar/calendar-integration.tokens.ts');
    expect(existsSync(tokensPath)).toBe(true);
    expect(res.tokensWritten).toContain(tokensPath);
    expect(readFileSync(tokensPath, 'utf-8')).toContain(
      "export const MEETING_INTEGRATION_USE_CASE__GOOGLE = Symbol.for('@app/integrations/calendar.meeting-integration-use-case.google');",
    );
  });

  it('records a non-Integrated surface entity as a skip (read side still emits)', () => {
    const res = runAssembly('/unused');
    expect(res.skippedAssemblies).toHaveLength(1);
    expect(res.skippedAssemblies[0]).toMatchObject({ surface: 'calendar', entity: 'reminder' });
    expect(res.skippedAssemblies[0].reason).toContain("not 'pattern: Integrated'");
    // The Integrated entity still produced an assembly + token in the same run.
    expect(res.assembliesWritten.some((p) => p.includes('meeting-integration.module.ts'))).toBe(true);
  });

  it('skips the assembly loop entirely when no backend_src root is supplied', () => {
    const outRoot = mkdtempSync(join(tmpdir(), 'cgp-e2-'));
    const res = emitAdapters({
      providers: [{ definition: loadDef('google.yaml'), filePath: resolve(FIX, 'google.yaml') }],
      entities: [ASSEMBLY_ENTITIES[0]],
      outputRoot: outRoot,
      // no backendSrcAbs
    });
    expect(res.assembliesWritten).toEqual([]);
    expect(res.tokensWritten).toEqual([]);
    expect(existsSync(join(outRoot, 'calendar/modules'))).toBe(false);
  });
});
