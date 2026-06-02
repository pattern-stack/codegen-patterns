/**
 * Unit tests for the bridge registry generator (BRIDGE-6, ADR-023 Phase 2).
 *
 * Fixture-driven: each test writes a temporary handlers directory + an
 * optional events/registry.ts stub, runs the generator, and asserts on
 * the emitted file content.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildBridgeRegistryContent,
  extractTriggersFromSourceFile,
  findHandlerFiles,
  generateBridgeRegistry,
  readKnownEventTypes,
  scanHandlerFiles,
  AuditEventTriggerError,
  DuplicateTriggerError,
  UnknownTriggerEventError,
  readEventTiers,
  validateAgainstEventRegistry,
  validateNoAuditTriggers,
  validateNoDuplicateTriggers,
  type ScannedTrigger,
} from '../../cli/shared/bridge-registry-generator';
import ts from 'typescript';

// ─── Fixture helpers ────────────────────────────────────────────────────────

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bridge-codegen-${prefix}-`));
}

function writeHandler(dir: string, file: string, content: string): string {
  const full = path.join(dir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function writeEventsRegistry(
  dir: string,
  eventTypes: Array<string | { type: string; tier: 'domain' | 'audit' }>,
): string {
  const generatedDir = path.join(dir, 'events/generated');
  fs.mkdirSync(generatedDir, { recursive: true });
  const entries = eventTypes.map((e) => {
    const obj = typeof e === 'string' ? { type: e, tier: 'domain' as const } : e;
    return `\t'${obj.type}': {\n\t\ttype: '${obj.type}',\n\t\ttier: '${obj.tier}',\n\t},`;
  });
  const lines: string[] = [
    "// AUTO-GENERATED",
    "import type { EventTypeName } from './types';",
    'export const eventRegistry = {',
    ...entries,
    '} as const satisfies Record<EventTypeName, unknown>;',
  ];
  fs.writeFileSync(path.join(generatedDir, 'registry.ts'), lines.join('\n'));
  return generatedDir;
}

const HANDLER_TEMPLATE = (jobType: string, body: string) => `
import { JobHandler } from '../jobs/job-handler.base';

@JobHandler<{}>('${jobType}', {
${body}
})
export class ${jobType
  .split('_')
  .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
  .join('')}Handler {
  async run() { /* stub */ }
}
`;

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('findHandlerFiles', () => {
  it('returns empty when the dir does not exist', () => {
    expect(findHandlerFiles('/nope/does/not/exist')).toEqual([]);
  });

  it('skips node_modules, dotfiles, and generated/', () => {
    const dir = makeTmpDir('walk');
    writeHandler(dir, 'a.ts', 'export const a = 1;');
    writeHandler(dir, 'node_modules/x.ts', 'export const x = 1;');
    writeHandler(dir, '.hidden/y.ts', 'export const y = 1;');
    writeHandler(dir, 'generated/z.ts', 'export const z = 1;');
    writeHandler(dir, 'sub/b.ts', 'export const b = 1;');
    const found = findHandlerFiles(dir).map((f) => path.relative(dir, f));
    expect(found.sort()).toEqual(['a.ts', 'sub/b.ts']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips .d.ts declaration files', () => {
    const dir = makeTmpDir('walk-dts');
    writeHandler(dir, 'a.ts', '');
    writeHandler(dir, 'a.d.ts', '');
    const found = findHandlerFiles(dir).map((f) => path.basename(f));
    expect(found).toEqual(['a.ts']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('extractTriggersFromSourceFile', () => {
  function parse(text: string): ts.SourceFile {
    return ts.createSourceFile(
      'test.ts',
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
  }

  it('extracts a single trigger with map only', () => {
    const sf = parse(
      HANDLER_TEMPLATE('send_welcome_email', `
  triggers: [
    { event: 'contact_created', map: (e) => ({ contactId: e.aggregateId }) },
  ],
`),
    );
    const t = extractTriggersFromSourceFile(sf, '/tmp/test.ts');
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({
      jobType: 'send_welcome_email',
      triggerId: 'send_welcome_email#0',
      event: 'contact_created',
      sourceFile: '/tmp/test.ts',
    });
    expect(t[0]!.mapSource).toContain('contactId');
    expect(t[0]!.whenSource).toBeUndefined();
    expect(t[0]!.sourceLine).toBeGreaterThan(0);
  });

  it('extracts multiple triggers with stable triggerId indices', () => {
    const sf = parse(
      HANDLER_TEMPLATE('handler_x', `
  triggers: [
    { event: 'a_event', map: (e) => ({ x: e.aggregateId }) },
    { event: 'b_event', map: (e) => ({ y: e.aggregateId }), when: (e) => true },
    { event: 'c_event', map: (e) => ({ z: e.aggregateId }) },
  ],
`),
    );
    const t = extractTriggersFromSourceFile(sf, '/tmp/test.ts');
    expect(t).toHaveLength(3);
    expect(t.map((x) => x.triggerId)).toEqual([
      'handler_x#0',
      'handler_x#1',
      'handler_x#2',
    ]);
    expect(t[1]!.whenSource).toContain('true');
  });

  it('ignores classes with no @JobHandler decorator', () => {
    const sf = parse(`
      export class NotAHandler {
        async run() {}
      }
    `);
    expect(extractTriggersFromSourceFile(sf, '/tmp/test.ts')).toEqual([]);
  });

  it('ignores @JobHandler with no triggers field', () => {
    const sf = parse(`
      import { JobHandler } from '../jobs/job-handler.base';
      @JobHandler<{}>('plain_job', { pool: 'internal' })
      export class PlainHandler { async run() {} }
    `);
    expect(extractTriggersFromSourceFile(sf, '/tmp/test.ts')).toEqual([]);
  });
});

describe('scanHandlerFiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir('scan');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('aggregates triggers across files in alphabetical file order', () => {
    writeHandler(dir, 'b-handler.ts', HANDLER_TEMPLATE('b_job', `
  triggers: [{ event: 'evt_x', map: (e) => ({}) }],
`));
    writeHandler(dir, 'a-handler.ts', HANDLER_TEMPLATE('a_job', `
  triggers: [{ event: 'evt_y', map: (e) => ({}) }],
`));
    const triggers = scanHandlerFiles(dir);
    expect(triggers.map((t) => t.jobType)).toEqual(['a_job', 'b_job']);
  });

  it('returns empty list when handlers dir does not exist', () => {
    expect(scanHandlerFiles('/no/such/dir')).toEqual([]);
  });

  it('returns empty list when no handlers carry triggers', () => {
    writeHandler(dir, 'x.ts', `export const x = 1;`);
    expect(scanHandlerFiles(dir)).toEqual([]);
  });
});

describe('readKnownEventTypes', () => {
  it('returns empty when no eventsGeneratedDir is provided', () => {
    expect(readKnownEventTypes()).toEqual([]);
  });

  it('returns empty when registry.ts does not exist', () => {
    const dir = makeTmpDir('events-missing');
    expect(readKnownEventTypes(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('extracts event-type literals from a generated registry', () => {
    const root = makeTmpDir('events-present');
    const generatedDir = writeEventsRegistry(root, [
      'contact_created',
      'deal_stage_changed',
    ]);
    const known = readKnownEventTypes(generatedDir);
    expect(known.sort()).toEqual(['contact_created', 'deal_stage_changed']);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('validateAgainstEventRegistry', () => {
  it('skips validation when knownEventTypes is empty', () => {
    const triggers: ScannedTrigger[] = [
      {
        jobType: 'x',
        triggerId: 'x#0',
        event: 'unknown_event',
        mapSource: '() => ({})',
        sourceFile: '/tmp/x.ts',
        sourceLine: 1,
      },
    ];
    expect(() => validateAgainstEventRegistry(triggers, [])).not.toThrow();
  });

  it('throws UnknownTriggerEventError on first unknown event', () => {
    const triggers: ScannedTrigger[] = [
      {
        jobType: 'x',
        triggerId: 'x#0',
        event: 'contact_created',
        mapSource: '() => ({})',
        sourceFile: '/tmp/x.ts',
        sourceLine: 1,
      },
      {
        jobType: 'y',
        triggerId: 'y#0',
        event: 'made_up_event',
        mapSource: '() => ({})',
        sourceFile: '/tmp/y.ts',
        sourceLine: 7,
      },
    ];
    let caught: unknown;
    try {
      validateAgainstEventRegistry(triggers, ['contact_created']);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnknownTriggerEventError);
    const err = caught as UnknownTriggerEventError;
    expect(err.event).toBe('made_up_event');
    expect(err.jobType).toBe('y');
    expect(err.sourceFile).toBe('/tmp/y.ts');
    expect(err.sourceLine).toBe(7);
    expect(err.message).toContain('made_up_event');
    expect(err.message).toContain('y');
    expect(err.message).toContain('/tmp/y.ts:7');
  });
});

describe('readEventTiers', () => {
  it('parses tier per event from the generated registry', () => {
    const root = makeTmpDir('tiers');
    const generatedDir = writeEventsRegistry(root, [
      'contact_created',
      { type: 'crm_sync_started', tier: 'audit' },
    ]);
    const tiers = readEventTiers(generatedDir);
    expect(tiers.get('contact_created')).toBe('domain');
    expect(tiers.get('crm_sync_started')).toBe('audit');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns empty map when registry missing', () => {
    expect(readEventTiers()).toEqual(new Map());
    expect(readEventTiers('/nope/does/not/exist')).toEqual(new Map());
  });
});

describe('validateNoAuditTriggers (AUDIT-2)', () => {
  it('throws AuditEventTriggerError when a trigger references an audit event', () => {
    const triggers: ScannedTrigger[] = [
      {
        jobType: 'log_sync_start',
        triggerId: 'log_sync_start#0',
        event: 'crm_sync_started',
        mapSource: '() => ({})',
        sourceFile: '/tmp/log.ts',
        sourceLine: 5,
      },
    ];
    const tiers = new Map<string, 'domain' | 'audit'>([
      ['crm_sync_started', 'audit'],
    ]);
    let caught: unknown;
    try {
      validateNoAuditTriggers(triggers, tiers);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AuditEventTriggerError);
    const err = caught as AuditEventTriggerError;
    expect(err.event).toBe('crm_sync_started');
    expect(err.jobType).toBe('log_sync_start');
    expect(err.triggerId).toBe('log_sync_start#0');
    expect(err.message).toContain(
      "@JobHandler('log_sync_start') trigger 'log_sync_start#0' references audit-tier event 'crm_sync_started'",
    );
    expect(err.message).toContain('Audit events are not bridge-eligible');
    expect(err.message).toContain('§AUDIT-2');
  });

  it('does not throw for domain-tier triggers', () => {
    const triggers: ScannedTrigger[] = [
      {
        jobType: 'send_welcome',
        triggerId: 'send_welcome#0',
        event: 'contact_created',
        mapSource: '() => ({})',
        sourceFile: '/tmp/x.ts',
        sourceLine: 1,
      },
    ];
    const tiers = new Map<string, 'domain' | 'audit'>([
      ['contact_created', 'domain'],
    ]);
    expect(() => validateNoAuditTriggers(triggers, tiers)).not.toThrow();
  });

  it('skips validation when tier map is empty', () => {
    const triggers: ScannedTrigger[] = [
      {
        jobType: 'x',
        triggerId: 'x#0',
        event: 'whatever',
        mapSource: '() => ({})',
        sourceFile: '/tmp/x.ts',
        sourceLine: 1,
      },
    ];
    expect(() =>
      validateNoAuditTriggers(triggers, new Map()),
    ).not.toThrow();
  });
});

describe('buildBridgeRegistryContent', () => {
  it('emits empty registry when no triggers', () => {
    const out = buildBridgeRegistryContent([]);
    expect(out).toContain('AUTO-GENERATED');
    expect(out).toContain("import type { BridgeRegistry } from '../bridge.protocol';");
    expect(out).toContain('export const bridgeRegistry: BridgeRegistry = {};');
  });

  it('groups triggers by event type, sorts keys, preserves declaration order per type', () => {
    const triggers: ScannedTrigger[] = [
      {
        jobType: 'b_job',
        triggerId: 'b_job#0',
        event: 'z_event',
        mapSource: '(e) => ({ b: e.aggregateId })',
        sourceFile: '/tmp/b.ts',
        sourceLine: 1,
      },
      {
        jobType: 'a_job',
        triggerId: 'a_job#0',
        event: 'a_event',
        mapSource: '(e) => ({ a1: e.aggregateId })',
        sourceFile: '/tmp/a.ts',
        sourceLine: 1,
      },
      {
        jobType: 'c_job',
        triggerId: 'c_job#0',
        event: 'a_event',
        mapSource: '(e) => ({ a2: e.aggregateId })',
        whenSource: '(e) => Boolean(e.aggregateId)',
        sourceFile: '/tmp/c.ts',
        sourceLine: 1,
      },
    ];
    const out = buildBridgeRegistryContent(triggers);
    // Keys sorted alphabetically: a_event before z_event
    const aIdx = out.indexOf("'a_event'");
    const zIdx = out.indexOf("'z_event'");
    expect(aIdx).toBeGreaterThan(0);
    expect(zIdx).toBeGreaterThan(aIdx);

    // Within a_event, declaration order: a_job#0 before c_job#0
    const aJobIdx = out.indexOf("'a_job#0'");
    const cJobIdx = out.indexOf("'c_job#0'");
    expect(aJobIdx).toBeLessThan(cJobIdx);
    expect(aJobIdx).toBeLessThan(zIdx);

    // map + when bodies inlined verbatim
    expect(out).toContain('a1: e.aggregateId');
    expect(out).toContain('a2: e.aggregateId');
    expect(out).toContain('Boolean(e.aggregateId)');
  });
});

describe('generateBridgeRegistry — orchestration', () => {
  let root: string;
  let handlersDir: string;
  let outputDir: string;
  beforeEach(() => {
    root = makeTmpDir('orch');
    handlersDir = path.join(root, 'src/jobs');
    outputDir = path.join(root, 'runtime/subsystems/bridge/generated');
    fs.mkdirSync(handlersDir, { recursive: true });
    // Simulate bridge subsystem installed (issue #191 gate).
    fs.mkdirSync(path.dirname(outputDir), { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(outputDir), 'bridge.protocol.ts'),
      'export type BridgeRegistry = Record<string, unknown>;\n',
    );
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes empty registry when no handlers + no events registry', async () => {
    const result = await generateBridgeRegistry({
      handlersDir,
      outputDir,
    });
    expect(result.triggerCount).toBe(0);
    expect(result.eventTypeCount).toBe(0);
    expect(result.written).toBe(true);
    const out = fs.readFileSync(path.join(outputDir, 'registry.ts'), 'utf8');
    expect(out).toContain('bridgeRegistry: BridgeRegistry = {};');
  });

  it('emits expected registry for a fixture with two handlers / three triggers', async () => {
    writeHandler(handlersDir, 'welcome.ts', HANDLER_TEMPLATE('send_welcome_email', `
  triggers: [
    { event: 'contact_created', map: (e) => ({ contactId: e.aggregateId }) },
  ],
`));
    writeHandler(handlersDir, 'integration.ts', HANDLER_TEMPLATE('integration_contact_to_hubspot', `
  triggers: [
    { event: 'contact_created', map: (e) => ({ contactId: e.aggregateId }) },
    { event: 'contact_merged', map: (e) => ({ contactId: e.aggregateId }), when: (e) => true },
  ],
`));
    const eventsGeneratedDir = writeEventsRegistry(root, [
      'contact_created',
      'contact_merged',
    ]);
    const result = await generateBridgeRegistry({
      handlersDir,
      eventsGeneratedDir,
      outputDir,
    });
    expect(result.triggerCount).toBe(3);
    expect(result.eventTypeCount).toBe(2);
    const out = fs.readFileSync(path.join(outputDir, 'registry.ts'), 'utf8');
    expect(out).toContain("'contact_created'");
    expect(out).toContain("'contact_merged'");
    expect(out).toContain("'send_welcome_email#0'");
    expect(out).toContain("'integration_contact_to_hubspot#0'");
    expect(out).toContain("'integration_contact_to_hubspot#1'");
  });

  it('throws AuditEventTriggerError when a handler triggers on an audit-tier event', async () => {
    writeHandler(handlersDir, 'audit-trigger.ts', HANDLER_TEMPLATE('log_sync_start', `
  triggers: [
    { event: 'crm_sync_started', map: (e) => ({}) },
  ],
`));
    const eventsGeneratedDir = writeEventsRegistry(root, [
      { type: 'crm_sync_started', tier: 'audit' },
    ]);
    expect(
      generateBridgeRegistry({
        handlersDir,
        eventsGeneratedDir,
        outputDir,
      }),
    ).rejects.toBeInstanceOf(AuditEventTriggerError);
  });

  it('throws UnknownTriggerEventError when handler references unknown event', async () => {
    writeHandler(handlersDir, 'broken.ts', HANDLER_TEMPLATE('broken_job', `
  triggers: [
    { event: 'i_do_not_exist', map: (e) => ({}) },
  ],
`));
    const eventsGeneratedDir = writeEventsRegistry(root, ['contact_created']);
    expect(
      generateBridgeRegistry({
        handlersDir,
        eventsGeneratedDir,
        outputDir,
      }),
    ).rejects.toBeInstanceOf(UnknownTriggerEventError);
  });

  it('is idempotent — second run emits byte-identical output', async () => {
    writeHandler(handlersDir, 'a.ts', HANDLER_TEMPLATE('a_job', `
  triggers: [{ event: 'evt_x', map: (e) => ({ x: e.aggregateId }) }],
`));
    const eventsGeneratedDir = writeEventsRegistry(root, ['evt_x']);
    await generateBridgeRegistry({ handlersDir, eventsGeneratedDir, outputDir });
    const first = fs.readFileSync(path.join(outputDir, 'registry.ts'), 'utf8');
    await generateBridgeRegistry({ handlersDir, eventsGeneratedDir, outputDir });
    const second = fs.readFileSync(path.join(outputDir, 'registry.ts'), 'utf8');
    expect(second).toBe(first);
  });

  describe('bridge subsystem not installed (issue #191)', () => {
    beforeEach(() => {
      // Remove the stub installed by the outer beforeEach.
      fs.rmSync(path.join(path.dirname(outputDir), 'bridge.protocol.ts'));
    });

    it('skips generation and does not write registry.ts', async () => {
      writeHandler(handlersDir, 'a.ts', HANDLER_TEMPLATE('a_job', `
  triggers: [{ event: 'evt_x', map: (e) => ({}) }],
`));
      const result = await generateBridgeRegistry({ handlersDir, outputDir });
      expect(result.skipped).toBe(true);
      expect(result.written).toBe(false);
      expect(result.triggerCount).toBe(0);
      expect(result.files).toHaveLength(0);
      expect(fs.existsSync(path.join(outputDir, 'registry.ts'))).toBe(false);
    });

    it('removes a stray registry.ts left by a prior run', async () => {
      fs.mkdirSync(outputDir, { recursive: true });
      const stray = path.join(outputDir, 'registry.ts');
      fs.writeFileSync(stray, '// stray\n');
      const result = await generateBridgeRegistry({ handlersDir, outputDir });
      expect(result.skipped).toBe(true);
      expect(fs.existsSync(stray)).toBe(false);
    });

    it('dryRun=true leaves stray registry.ts alone', async () => {
      fs.mkdirSync(outputDir, { recursive: true });
      const stray = path.join(outputDir, 'registry.ts');
      fs.writeFileSync(stray, '// stray\n');
      const result = await generateBridgeRegistry({
        handlersDir,
        outputDir,
        dryRun: true,
      });
      expect(result.skipped).toBe(true);
      expect(fs.existsSync(stray)).toBe(true);
    });
  });

  it('dryRun=true does not write', async () => {
    writeHandler(handlersDir, 'a.ts', HANDLER_TEMPLATE('a_job', `
  triggers: [{ event: 'evt_x', map: (e) => ({}) }],
`));
    const result = await generateBridgeRegistry({
      handlersDir,
      outputDir,
      dryRun: true,
    });
    expect(result.written).toBe(false);
    expect(fs.existsSync(path.join(outputDir, 'registry.ts'))).toBe(false);
  });
});


describe('validateNoDuplicateTriggers (BRIDGE-7 follow-up)', () => {
  // ADR-023 §`publishAndStart` + `triggers:` collision: exactly one
  // execution per (event, trigger) pair. Two triggers with the same
  // (event, jobType) double-spawn the user job because triggerId differs
  // by index. The codegen catches this at build time so authors don't
  // debug double-spawned jobs in production.
  it('passes when no duplicates', () => {
    const triggers: ScannedTrigger[] = [
      {
        jobType: 'a_job',
        triggerId: 'a_job#0',
        event: 'evt_x',
        mapSource: '() => ({})',
        sourceFile: '/tmp/a.ts',
        sourceLine: 1,
      },
      {
        jobType: 'b_job',
        triggerId: 'b_job#0',
        event: 'evt_x',
        mapSource: '() => ({})',
        sourceFile: '/tmp/b.ts',
        sourceLine: 1,
      },
    ];
    expect(() => validateNoDuplicateTriggers(triggers)).not.toThrow();
  });

  it('throws DuplicateTriggerError on (event, jobType) duplicate', () => {
    const triggers: ScannedTrigger[] = [
      {
        jobType: 'a_job',
        triggerId: 'a_job#0',
        event: 'evt_x',
        mapSource: '() => ({})',
        sourceFile: '/tmp/file_one.ts',
        sourceLine: 5,
      },
      {
        jobType: 'a_job',
        triggerId: 'a_job#1',
        event: 'evt_x',
        mapSource: '() => ({})',
        sourceFile: '/tmp/file_two.ts',
        sourceLine: 12,
      },
    ];
    let caught: unknown;
    try {
      validateNoDuplicateTriggers(triggers);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DuplicateTriggerError);
    const err = caught as DuplicateTriggerError;
    expect(err.event).toBe('evt_x');
    expect(err.jobType).toBe('a_job');
    expect(err.occurrences).toHaveLength(2);
    expect(err.message).toContain('a_job#0');
    expect(err.message).toContain('a_job#1');
    expect(err.message).toContain('/tmp/file_one.ts:5');
    expect(err.message).toContain('/tmp/file_two.ts:12');
  });

  it('allows the same jobType to map a different event (no false collision)', () => {
    const triggers: ScannedTrigger[] = [
      {
        jobType: 'a_job',
        triggerId: 'a_job#0',
        event: 'evt_x',
        mapSource: '() => ({})',
        sourceFile: '/tmp/a.ts',
        sourceLine: 1,
      },
      {
        jobType: 'a_job',
        triggerId: 'a_job#1',
        event: 'evt_y',
        mapSource: '() => ({})',
        sourceFile: '/tmp/a.ts',
        sourceLine: 5,
      },
    ];
    expect(() => validateNoDuplicateTriggers(triggers)).not.toThrow();
  });

  it('generateBridgeRegistry surfaces DuplicateTriggerError end-to-end', async () => {
    const root = makeTmpDir('orch-dup');
    const handlersDir = path.join(root, 'src/jobs');
    const outputDir = path.join(root, 'runtime/subsystems/bridge/generated');
    fs.mkdirSync(handlersDir, { recursive: true });
    fs.mkdirSync(path.dirname(outputDir), { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(outputDir), 'bridge.protocol.ts'),
      'export type BridgeRegistry = Record<string, unknown>;\n',
    );
    writeHandler(handlersDir, 'dup.ts', HANDLER_TEMPLATE('dup_job', `
  triggers: [
    { event: 'evt_x', map: (e) => ({}) },
    { event: 'evt_x', map: (e) => ({}) },
  ],
`));
    expect(
      generateBridgeRegistry({
        handlersDir,
        eventsGeneratedDir: undefined,
        outputDir,
      }),
    ).rejects.toBeInstanceOf(DuplicateTriggerError);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ─── Package mode (ADR-037) ──────────────────────────────────────────────────
//
// In package mode the bridge runtime lives in node_modules (read-only), so the
// generated registry lands beside the consumer's other `src/generated/*`
// barrels as `bridge-registry.ts`, imports the `BridgeRegistry` TYPE off the
// published runtime subpath (not a vendored `../bridge.protocol` that doesn't
// exist), and the "is bridge installed" gate is decided by the caller
// (`bridgeInstalled`, read from `subsystems.install`) — there is no
// `bridge.protocol.ts` file to probe.
describe('generateBridgeRegistry — package mode (ADR-037)', () => {
  let root: string;
  let handlersDir: string;
  let outputDir: string;
  const PKG_TYPE_IMPORT =
    '@pattern-stack/codegen/runtime/subsystems/bridge/index';

  beforeEach(() => {
    root = makeTmpDir('pkg');
    handlersDir = path.join(root, 'src/jobs');
    // Package mode writes into the consumer's `src/generated/` — NOT a vendored
    // subsystems tree. No `bridge.protocol.ts` exists anywhere.
    outputDir = path.join(root, 'src/generated');
    fs.mkdirSync(handlersDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes bridge-registry.ts (not registry.ts) with the package type import', async () => {
    writeHandler(handlersDir, 'welcome.ts', HANDLER_TEMPLATE('send_welcome_email', `
  triggers: [
    { event: 'contact_created', map: (e) => ({ contactId: e.aggregateId }) },
  ],
`));
    const eventsGeneratedDir = writeEventsRegistry(root, ['contact_created']);
    const result = await generateBridgeRegistry({
      handlersDir,
      eventsGeneratedDir,
      outputDir,
      mode: 'package',
      bridgeInstalled: true,
    });
    expect(result.skipped).toBe(false);
    expect(result.written).toBe(true);
    expect(result.triggerCount).toBe(1);
    // The mode-specific filename.
    expect(result.files[0]!.name).toBe('bridge-registry.ts');
    expect(fs.existsSync(path.join(outputDir, 'bridge-registry.ts'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'registry.ts'))).toBe(false);
    const out = fs.readFileSync(path.join(outputDir, 'bridge-registry.ts'), 'utf8');
    // Type import resolves off the published runtime subpath, NOT the vendored
    // relative protocol path.
    expect(out).toContain(
      `import type { BridgeRegistry } from '${PKG_TYPE_IMPORT}';`,
    );
    expect(out).not.toContain("from '../bridge.protocol'");
    expect(out).toContain("'send_welcome_email#0'");
  });

  it('emits an empty registry (still package-shaped) when there are no triggers', async () => {
    const result = await generateBridgeRegistry({
      handlersDir,
      outputDir,
      mode: 'package',
      bridgeInstalled: true,
    });
    expect(result.skipped).toBe(false);
    const out = fs.readFileSync(path.join(outputDir, 'bridge-registry.ts'), 'utf8');
    expect(out).toContain('bridgeRegistry: BridgeRegistry = {};');
    expect(out).toContain(
      `import type { BridgeRegistry } from '${PKG_TYPE_IMPORT}';`,
    );
  });

  it('skips + cleans up a stray bridge-registry.ts when bridge not in install set', async () => {
    const stray = path.join(outputDir, 'bridge-registry.ts');
    fs.writeFileSync(stray, '// stale');
    writeHandler(handlersDir, 'a.ts', HANDLER_TEMPLATE('a_job', `
  triggers: [{ event: 'evt_x', map: (e) => ({}) }],
`));
    const result = await generateBridgeRegistry({
      handlersDir,
      outputDir,
      mode: 'package',
      bridgeInstalled: false,
    });
    expect(result.skipped).toBe(true);
    expect(result.written).toBe(false);
    expect(fs.existsSync(stray)).toBe(false);
  });

  it('does NOT consult bridge.protocol.ts in package mode (gate is config-driven)', async () => {
    // No bridge.protocol.ts anywhere, yet bridgeInstalled:true ⇒ it generates.
    // (Vendored mode would skip here.)
    const result = await generateBridgeRegistry({
      handlersDir,
      outputDir,
      mode: 'package',
      bridgeInstalled: true,
    });
    expect(result.skipped).toBe(false);
    expect(fs.existsSync(path.join(outputDir, 'bridge-registry.ts'))).toBe(true);
  });
});

describe('buildBridgeRegistryContent — type import is parameterized', () => {
  it('defaults to the vendored ../bridge.protocol specifier', () => {
    const out = buildBridgeRegistryContent([]);
    expect(out).toContain("import type { BridgeRegistry } from '../bridge.protocol';");
  });

  it('honors a package type-import specifier', () => {
    const out = buildBridgeRegistryContent(
      [],
      '@pattern-stack/codegen/runtime/subsystems/bridge/index',
    );
    expect(out).toContain(
      "import type { BridgeRegistry } from '@pattern-stack/codegen/runtime/subsystems/bridge/index';",
    );
    expect(out).not.toContain("'../bridge.protocol'");
  });
});
