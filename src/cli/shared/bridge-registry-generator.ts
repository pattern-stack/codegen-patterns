/**
 * Bridge registry generator (BRIDGE-6, ADR-023 Phase 2).
 *
 * Walks the project's handler directory, parses each `.ts` file with the
 * TypeScript Compiler API, finds every class decorated with
 * `@JobHandler(type, { triggers: [...] })`, and emits
 * `runtime/subsystems/bridge/generated/registry.ts` — a `Record<EventType,
 * BridgeTriggerEntry[]>` keyed by event type and ordered by declaration.
 *
 * Build-time validation: every `triggers[].event` must appear in the
 * generated `eventRegistry` (read from
 * `runtime/subsystems/events/generated/registry.ts`). Unknown event type ⇒
 * hard error with file path + line, citing the spec's Decision 5.
 *
 * Empty case: no handler files / no `triggers:` arrays ⇒ emit
 * `bridgeRegistry = {} as BridgeRegistry`. Subsequent `just gen-all` runs
 * are byte-stable (idempotent).
 *
 * **Important authoring constraint** (ADR-023 §`bridgeRegistry` shape +
 * spec Open Question on `map:` serialization). The `map:` and `when:`
 * arrow-function bodies are copied verbatim from the handler source into
 * `registry.ts`. Helpers referenced from outside the arrow's parameter
 * scope WILL NOT be auto-imported and the generated file will fail to
 * compile. Authors must write self-contained expressions
 * (`(e) => ({ id: e.aggregateId })`) — calls to project helpers
 * (`(e) => buildInput(e)`) are unsupported in Phase 2. Documented in
 * `.claude/skills/bridge/SKILL.md` (BRIDGE-9). Phase 2.5 may add an
 * import-tracker; out of scope here.
 *
 * Pattern matches `event-codegen-generator.ts`: pure content-builders
 * unit-tested in isolation; one orchestrating entrypoint that handles
 * disk I/O with `dryRun` semantics.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import type { RuntimeMode } from './runtime-import.js';

// ---------------------------------------------------------------------------
// Mode-aware emission constants (ADR-037)
// ---------------------------------------------------------------------------

/**
 * The `BridgeRegistry` type-import specifier the package-mode registry uses.
 * The file lands in the consumer's `src/generated/`, so it can't reach the
 * package-internal `bridge.protocol`; it imports the type off the published
 * per-subsystem runtime index (the same subpath the subsystem schema barrel
 * uses).
 */
export const PACKAGE_BRIDGE_TYPE_IMPORT =
  '@pattern-stack/codegen/runtime/subsystems/bridge/index';

/** Output filename per mode. Package mode co-locates with the other
 * `src/generated/*` barrels (and must NOT collide with a vendored
 * `registry.ts`); vendored mode keeps the legacy name inside the vendored
 * `bridge/generated/` dir. */
const OUTPUT_FILE_BY_MODE: Record<RuntimeMode, string> = {
  vendored: 'registry.ts',
  package: 'bridge-registry.ts',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BridgeRegistryGeneratorOptions {
  /** Absolute path to the handlers directory. Walked recursively. */
  handlersDir: string;
  /**
   * Absolute path to the generated events directory; the generator reads
   * `registry.ts` from here to build the known-event-types set.
   * `undefined` ⇒ skip validation (fixtures, tests).
   */
  eventsGeneratedDir?: string;
  /** Absolute path to the output directory. Vendored mode: the vendored
   * `bridge/generated/`. Package mode: the consumer's `src/generated/`. */
  outputDir: string;
  /**
   * Runtime mode (ADR-037). Defaults to `'vendored'` so the existing
   * (fixture/test) callers and the legacy vendored emission are byte-stable.
   *   - vendored → writes `registry.ts` with a `'../bridge.protocol'` type
   *     import; "is bridge installed" is decided by the `bridge.protocol.ts`
   *     sibling check (a vendored tree means the runtime was vendored).
   *   - package  → writes `bridge-registry.ts` with the package type import;
   *     there is nothing vendored on disk, so installation is decided by the
   *     caller via `bridgeInstalled` (read from `subsystems.install`).
   */
  mode?: RuntimeMode;
  /**
   * Package-mode installation gate. Ignored in vendored mode (which uses the
   * `bridge.protocol.ts` sibling check). When `mode: 'package'` and this is
   * falsy, generation is skipped and any stray output file is removed —
   * mirroring the vendored "no bridge.protocol ⇒ skip" behavior.
   */
  bridgeInstalled?: boolean;
  /** If true, compute content but don't write to disk. */
  dryRun?: boolean;
  /**
   * Synthetic triggers contributed DECLARATIVELY by other generators (RFC-0005 #7:
   * the jobs definition-kind emitter feeds job→event bridge mappings here rather
   * than emitting `@JobHandler` source for the AST scan to re-parse). Concatenated
   * with the scanned triggers BEFORE the validators run, so they get the same
   * unknown-event / duplicate / audit checking and flow into the registry unchanged.
   */
  extraTriggers?: ScannedTrigger[];
}

/**
 * One trigger extracted from a handler decorator.
 *
 * `mapSource` and `whenSource` are the verbatim source text of the arrow
 * functions, copied from the handler file. These get inlined into the
 * generated registry as-is.
 */
export interface ScannedTrigger {
  /** The decorated handler's first decorator argument: the job type string. */
  jobType: string;
  /** `<jobType>#<index>` — stable across codegens. */
  triggerId: string;
  /** Event type literal (`triggers[i].event`). */
  event: string;
  /** Source text of `triggers[i].map` arrow function. */
  mapSource: string;
  /** Optional source text of `triggers[i].when` arrow function. */
  whenSource?: string;
  /** File path the trigger was found in (for error messages). */
  sourceFile: string;
  /** 1-based line number of the trigger entry (for error messages). */
  sourceLine: number;
}

export interface BridgeRegistryFileOutput {
  outputPath: string;
  name: string;
  content: string;
}

export interface BridgeRegistryResult {
  outputDir: string;
  triggerCount: number;
  triggers: ScannedTrigger[];
  /** Number of distinct event types referenced. */
  eventTypeCount: number;
  written: boolean;
  files: BridgeRegistryFileOutput[];
  /**
   * True when the bridge subsystem is not installed in the consumer tree
   * (no `bridge.protocol.ts` sibling to `outputDir`) and generation was
   * skipped to avoid emitting a file with a dangling import. Any stray
   * `registry.ts` left behind from a prior run is removed in this case.
   */
  skipped: boolean;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

const HEADER =
  `// AUTO-GENERATED by @pattern-stack/codegen. Do not edit.\n` +
  `// Run \`codegen entity new --all\` to refresh.\n`;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a `@JobHandler` trigger references an event type that does
 * not exist in the generated `eventRegistry`. ADR-023 §Decision 5
 * (build-time validation against `eventRegistry`).
 */
/**
 * Thrown when the registry would emit two triggers with the same
 * `(event, jobType)` pair. ADR-023 §`publishAndStart` + existing
 * `triggers:` collision: exactly one execution per `(event, trigger)`
 * pair. Two triggers with the same `(event, jobType)` would produce
 * two wrappers + two user-job spawns — the bridge ledger UNIQUE only
 * dedups by `triggerId`, which is `<jobType>#<index>` and therefore
 * differs between the two entries.
 *
 * The facade's Case B pre-write loop pre-writes one delivery per
 * matching trigger, so it stays correct even with duplicates. But the
 * codegen catching this at build time is the cleaner long-term fix
 * (lead decision 2026-04-22 — belt+suspenders): authors see the
 * mistake immediately rather than debugging double-spawned jobs.
 *
 * To resolve: either rename the second trigger's job type, or remove
 * one of the two `@JobHandler.triggers[]` entries pointing at the same
 * (event, job) pair.
 */
export class DuplicateTriggerError extends Error {
  override readonly name = 'DuplicateTriggerError';
  constructor(
    public readonly event: string,
    public readonly jobType: string,
    public readonly occurrences: ReadonlyArray<{
      sourceFile: string;
      sourceLine: number;
      triggerId: string;
    }>,
  ) {
    super(
      `DuplicateTriggerError: ${occurrences.length} @JobHandler.triggers ` +
        `entries declare event '${event}' → jobType '${jobType}'. ADR-023 ` +
        `requires exactly one execution per (event, trigger) pair; ` +
        `duplicates would double-spawn the user job. Occurrences:\n` +
        occurrences
          .map(
            (o) =>
              `  - ${o.triggerId} at ${o.sourceFile}:${o.sourceLine}`,
          )
          .join('\n') +
        `\nFix: rename the second job type, or remove one of the ` +
        `duplicate trigger entries.`,
    );
  }
}

/**
 * Thrown when a `@JobHandler` trigger references an event whose registry
 * entry has `tier: 'audit'`. Audit events are observational and not
 * bridge-eligible by design (AUDIT-2). See
 * `ai-docs/specs/issue-242/plan.md` §AUDIT-2.
 */
export class AuditEventTriggerError extends Error {
  override readonly name = 'AuditEventTriggerError';
  constructor(
    public readonly event: string,
    public readonly jobType: string,
    public readonly triggerId: string,
    public readonly sourceFile: string,
    public readonly sourceLine: number,
  ) {
    super(
      `AuditEventTriggerError: @JobHandler('${jobType}') trigger '${triggerId}' ` +
        `references audit-tier event '${event}'. Audit events are not ` +
        `bridge-eligible. Use a domain event, or remove the trigger. ` +
        `Source: ${sourceFile}:${sourceLine}. See ai-docs/specs/issue-242/plan.md §AUDIT-2.`,
    );
  }
}

export class UnknownTriggerEventError extends Error {
  override readonly name = 'UnknownTriggerEventError';
  constructor(
    public readonly event: string,
    public readonly jobType: string,
    public readonly sourceFile: string,
    public readonly sourceLine: number,
    public readonly knownEventTypes: string[],
  ) {
    super(
      `UnknownTriggerEventError: @JobHandler('${jobType}') trigger references ` +
        `event '${event}' which does not exist in the generated eventRegistry. ` +
        `Source: ${sourceFile}:${sourceLine}. ` +
        `Known event types (${knownEventTypes.length}): ` +
        (knownEventTypes.length > 0
          ? `[${knownEventTypes.slice(0, 10).join(', ')}` +
            (knownEventTypes.length > 10 ? ', …]' : ']')
          : '[]') +
        `. Either declare '${event}' under events/*.yaml and re-run ` +
        `\`codegen entity new --all\`, or remove the trigger.`,
    );
  }
}

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

/**
 * Recursively collect `.ts` files under `dir`. Skips `node_modules`,
 * `generated/`, `.git/`. Returns absolute paths sorted for deterministic
 * order across runs (matters for the byte-stable codegen guarantee).
 */
export function findHandlerFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules' || entry.name === 'generated') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findHandlerFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// AST extraction
// ---------------------------------------------------------------------------

/**
 * Walk a parsed source file and extract every `@JobHandler(type, {
 * triggers: [...] })` decorator. Returns a (possibly empty) flat list of
 * triggers, preserving declaration order both within a class and across
 * classes within the file.
 */
export function extractTriggersFromSourceFile(
  sourceFile: ts.SourceFile,
  filePath: string,
): ScannedTrigger[] {
  const triggers: ScannedTrigger[] = [];

  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node)) {
      const modifiers = ts.canHaveDecorators(node)
        ? ts.getDecorators(node) ?? []
        : [];
      for (const decorator of modifiers) {
        const call = decorator.expression;
        if (!ts.isCallExpression(call)) continue;
        if (!ts.isIdentifier(call.expression)) continue;
        if (call.expression.text !== 'JobHandler') continue;
        const [typeArg, metaArg] = call.arguments;
        if (!typeArg || !ts.isStringLiteralLike(typeArg)) continue;
        if (!metaArg || !ts.isObjectLiteralExpression(metaArg)) continue;

        const jobType = typeArg.text;
        const triggersProp = metaArg.properties.find(
          (p): p is ts.PropertyAssignment =>
            ts.isPropertyAssignment(p) &&
            ts.isIdentifier(p.name) &&
            p.name.text === 'triggers',
        );
        if (!triggersProp) continue;
        if (!ts.isArrayLiteralExpression(triggersProp.initializer)) continue;

        triggersProp.initializer.elements.forEach((el, index) => {
          if (!ts.isObjectLiteralExpression(el)) return;
          const eventProp = el.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) &&
              ts.isIdentifier(p.name) &&
              p.name.text === 'event',
          );
          const mapProp = el.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) &&
              ts.isIdentifier(p.name) &&
              p.name.text === 'map',
          );
          const whenProp = el.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) &&
              ts.isIdentifier(p.name) &&
              p.name.text === 'when',
          );
          if (!eventProp || !ts.isStringLiteralLike(eventProp.initializer)) return;
          if (!mapProp) return;

          const { line } = sourceFile.getLineAndCharacterOfPosition(el.getStart(sourceFile));

          triggers.push({
            jobType,
            triggerId: `${jobType}#${index}`,
            event: eventProp.initializer.text,
            mapSource: mapProp.initializer.getText(sourceFile),
            whenSource: whenProp?.initializer.getText(sourceFile),
            sourceFile: filePath,
            sourceLine: line + 1,
          });
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return triggers;
}

/**
 * Scan every `.ts` file under `handlersDir` and aggregate the triggers.
 * Order: files sorted alphabetically; within a file, declaration order
 * is preserved.
 */
export function scanHandlerFiles(handlersDir: string): ScannedTrigger[] {
  const files = findHandlerFiles(handlersDir);
  const out: ScannedTrigger[] = [];
  for (const filePath of files) {
    const text = fs.readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      filePath,
      text,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      ts.ScriptKind.TS,
    );
    out.push(...extractTriggersFromSourceFile(sourceFile, filePath));
  }
  return out;
}

// ---------------------------------------------------------------------------
// eventRegistry validation
// ---------------------------------------------------------------------------

/**
 * Read the generated `events/registry.ts` file and extract the set of
 * known event-type string literals. Lightweight regex scan (the file is
 * codegen-stable and machine-emitted — no need to parse it as TS).
 *
 * Returns an empty array if the file doesn't exist (consumer hasn't run
 * `gen-all` yet, fixture-only test, etc.); validation is then skipped.
 */
export function readKnownEventTypes(eventsGeneratedDir?: string): string[] {
  if (!eventsGeneratedDir) return [];
  const registryPath = path.join(eventsGeneratedDir, 'registry.ts');
  if (!fs.existsSync(registryPath)) return [];
  const text = fs.readFileSync(registryPath, 'utf8');
  // The eventRegistry is keyed by string-literal event types:
  //   'contact_created': { ... },
  // Match the keys in the eventRegistry object literal.
  const out = new Set<string>();
  // Find each `\t'event_type': {` style line.
  const re = /^\s*'([a-zA-Z0-9_.-]+)':\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.add(m[1]!);
  }
  return Array.from(out).sort();
}

/**
 * Read the generated `events/registry.ts` file and extract the `tier`
 * field for each event entry. Returns a Map keyed by event type. Events
 * without a `tier` field (older registries pre-AUDIT-2) are reported as
 * `domain` for safety.
 *
 * Lightweight regex scan — same approach as `readKnownEventTypes`. The
 * file is codegen-stable and machine-emitted.
 */
export function readEventTiers(
  eventsGeneratedDir?: string,
): Map<string, 'domain' | 'audit'> {
  const out = new Map<string, 'domain' | 'audit'>();
  if (!eventsGeneratedDir) return out;
  const registryPath = path.join(eventsGeneratedDir, 'registry.ts');
  if (!fs.existsSync(registryPath)) return out;
  const text = fs.readFileSync(registryPath, 'utf8');
  // Match each entry block:
  //   'event_type': {
  //     type: 'event_type',
  //     tier: 'audit',
  //     ...
  //   },
  // The tier line, when present, is the first or second line after the key.
  const re =
    /'([a-zA-Z0-9_.-]+)':\s*\{[^}]*?tier:\s*'(domain|audit)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.set(m[1]!, m[2] as 'domain' | 'audit');
  }
  return out;
}

/**
 * Throws `AuditEventTriggerError` on the first trigger whose event has
 * `tier: 'audit'` in the events registry. AUDIT-2: audit events are not
 * bridge-eligible.
 */
export function validateNoAuditTriggers(
  triggers: ScannedTrigger[],
  eventTiers: Map<string, 'domain' | 'audit'>,
): void {
  if (eventTiers.size === 0) return;
  for (const t of triggers) {
    if (eventTiers.get(t.event) === 'audit') {
      throw new AuditEventTriggerError(
        t.event,
        t.jobType,
        t.triggerId,
        t.sourceFile,
        t.sourceLine,
      );
    }
  }
}

/**
 * Throws `UnknownTriggerEventError` on first unknown trigger event.
 * Skips validation when `knownEventTypes` is empty (no registry to
 * validate against).
 */
/**
 * Throws `DuplicateTriggerError` on the first `(event, jobType)` pair
 * that appears in two or more scanned triggers. Codegen-time guard for
 * the facade's same-tx invariant (BRIDGE-7).
 */
export function validateNoDuplicateTriggers(
  triggers: ScannedTrigger[],
): void {
  // Group by `${event}\u0000${jobType}` (NUL separator avoids any
  // collision with string contents).
  const grouped = new Map<
    string,
    Array<{ sourceFile: string; sourceLine: number; triggerId: string }>
  >();
  for (const t of triggers) {
    const key = `${t.event}\u0000${t.jobType}`;
    const list = grouped.get(key) ?? [];
    list.push({
      sourceFile: t.sourceFile,
      sourceLine: t.sourceLine,
      triggerId: t.triggerId,
    });
    grouped.set(key, list);
  }
  for (const [key, occurrences] of grouped) {
    if (occurrences.length < 2) continue;
    const [event, jobType] = key.split('\u0000');
    throw new DuplicateTriggerError(event!, jobType!, occurrences);
  }
}

export function validateAgainstEventRegistry(
  triggers: ScannedTrigger[],
  knownEventTypes: string[],
): void {
  if (knownEventTypes.length === 0) return;
  const known = new Set(knownEventTypes);
  for (const t of triggers) {
    if (!known.has(t.event)) {
      throw new UnknownTriggerEventError(
        t.event,
        t.jobType,
        t.sourceFile,
        t.sourceLine,
        knownEventTypes,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Content builder
// ---------------------------------------------------------------------------

export function buildBridgeRegistryContent(
  triggers: ScannedTrigger[],
  /**
   * Where the `BridgeRegistry` type is imported FROM, mode-aware (ADR-037):
   *   - vendored → `'../bridge.protocol'` (the file sits in the vendored
   *     `bridge/generated/` dir, one level under the protocol). Default, so
   *     existing callers/tests are byte-stable.
   *   - package  → `'@pattern-stack/codegen/runtime/subsystems/bridge/index'`
   *     (the file lands in the consumer's `src/generated/`, which has no
   *     relative line of sight to the package-internal protocol).
   */
  typeImport = '../bridge.protocol',
): string {
  const chunks: string[] = [];
  chunks.push(HEADER);
  chunks.push('');
  chunks.push(`import type { BridgeRegistry } from '${typeImport}';`);
  chunks.push('');

  if (triggers.length === 0) {
    chunks.push(`export const bridgeRegistry: BridgeRegistry = {};`);
    chunks.push('');
    return chunks.join('\n');
  }

  // Group by event type, preserving declaration order within each group.
  const grouped = new Map<string, ScannedTrigger[]>();
  for (const t of triggers) {
    const list = grouped.get(t.event) ?? [];
    list.push(t);
    grouped.set(t.event, list);
  }

  // Sort event types for deterministic key order; per-type triggers stay
  // in declaration order (matters for triggerId stability).
  const sortedEventTypes = Array.from(grouped.keys()).sort();

  chunks.push(`export const bridgeRegistry: BridgeRegistry = {`);
  for (const eventType of sortedEventTypes) {
    chunks.push(`\t'${eventType}': [`);
    for (const t of grouped.get(eventType)!) {
      chunks.push(`\t\t{`);
      chunks.push(`\t\t\ttriggerId: '${t.triggerId}',`);
      chunks.push(`\t\t\tjobType: '${t.jobType}',`);
      chunks.push(`\t\t\tmap: ${t.mapSource},`);
      if (t.whenSource) {
        chunks.push(`\t\t\twhen: ${t.whenSource},`);
      }
      chunks.push(`\t\t},`);
    }
    chunks.push(`\t],`);
  }
  chunks.push(`};`);
  chunks.push('');

  return chunks.join('\n');
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function generateBridgeRegistry(
  opts: BridgeRegistryGeneratorOptions,
): Promise<BridgeRegistryResult> {
  const {
    handlersDir,
    eventsGeneratedDir,
    outputDir,
    mode = 'vendored',
    bridgeInstalled = false,
    dryRun = false,
  } = opts;

  const outputFileName = OUTPUT_FILE_BY_MODE[mode];
  const typeImport =
    mode === 'package' ? PACKAGE_BRIDGE_TYPE_IMPORT : '../bridge.protocol';

  // 0. Gate on bridge subsystem installation (issue #191). The emitted file
  //    imports the `BridgeRegistry` type; in vendored mode that type comes
  //    from `../bridge.protocol`, which only exists after `subsystem install
  //    bridge` vendored the runtime — so the file's presence IS the gate. In
  //    package mode nothing is vendored on disk, so the caller decides via
  //    `bridgeInstalled` (from `subsystems.install`). Either way: not
  //    installed ⇒ skip and clean up any stray artifact from a prior run.
  const installed =
    mode === 'package'
      ? bridgeInstalled
      : fs.existsSync(path.resolve(outputDir, '..', 'bridge.protocol.ts'));
  if (!installed) {
    const strayPath = path.join(outputDir, outputFileName);
    if (!dryRun && fs.existsSync(strayPath)) {
      fs.rmSync(strayPath);
    }
    return {
      outputDir,
      triggerCount: 0,
      triggers: [],
      eventTypeCount: 0,
      written: false,
      files: [],
      skipped: true,
    };
  }

  // 1. Scan handler files, then fold in any declaratively-contributed triggers
  //    (RFC-0005 #7 jobs emitter). They join BEFORE the validators so a job trigger
  //    referencing an unknown/audit event or colliding with a hand-authored
  //    (event, jobType) pair is caught the same way.
  const triggers = [
    ...scanHandlerFiles(handlersDir),
    ...(opts.extraTriggers ?? []),
  ];

  // 2a. Reject duplicate (event, jobType) pairs (BRIDGE-7 follow-up to
  //     BRIDGE-6: facade's same-tx invariant requires one trigger per
  //     such pair; without this guard, duplicates double-spawn).
  validateNoDuplicateTriggers(triggers);

  // 2b. Validate against eventRegistry (no-op if registry not present).
  const knownEventTypes = readKnownEventTypes(eventsGeneratedDir);
  validateAgainstEventRegistry(triggers, knownEventTypes);

  // 2c. Reject triggers on audit-tier events (AUDIT-2). Audit events
  //     are observational and not bridge-eligible by design.
  const eventTiers = readEventTiers(eventsGeneratedDir);
  validateNoAuditTriggers(triggers, eventTiers);

  // 3. Build content.
  const content = buildBridgeRegistryContent(triggers, typeImport);
  const file: BridgeRegistryFileOutput = {
    name: outputFileName,
    outputPath: path.join(outputDir, outputFileName),
    content,
  };

  // 4. Write (or not).
  let written = false;
  if (!dryRun) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(file.outputPath, file.content);
    written = true;
  }

  const eventTypeCount = new Set(triggers.map((t) => t.event)).size;
  return {
    outputDir,
    triggerCount: triggers.length,
    triggers,
    eventTypeCount,
    written,
    files: [file],
    skipped: false,
  };
}
