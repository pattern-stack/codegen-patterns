/**
 * `fkUnique` on the graph payload ≡ what the generator emits (STUDIO-3).
 *
 * `serialize-graph.ts`'s `fkColumnUnique` is a temporary second copy of a rule
 * the generator applies where it emits the constraints —
 * `fieldUniqueEntries` + `processUniqueIndexes` in
 * `templates/entity/new/backend/entity-locals.js`. Until one owner holds both,
 * this test holds them equal, read from GENERATED output: for every
 * `belongs_to`, `fkUnique` is true exactly when the emitted Drizzle entity
 * declares a unique on that FK column — a single-column unique, or the
 * tenant-prefixed `(tenant_id, fk)` one a `tenant_scoped` entity gets.
 *
 * Two inputs: (a) the checked-in baseline (`test/baseline/**`), and (b) the
 * render matrix plus this file's own unique-FK cases, rendered in-process
 * through `entity.ejs.t` the way `src/__tests__/backend/eav-templates.test.ts`
 * renders.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ejs from 'ejs';
import yaml from 'yaml';

import { buildBackendLocals } from '../../../templates/entity/new/backend/entity-locals.js';
import { entityLookupFrom } from '../../../templates/_shared/entity-naming.mjs';
import { buildDomainGraph } from '../../analyzer/graph-builder';
import { serializeDomainGraph } from '../../analyzer/serialize-graph';
import type { SerializedDomainGraph } from '../../analyzer/serialize-graph';
import { kebab } from '../../config/file-naming';
import { loadCodegenConfig } from '../../config/project-config';
import { runtimeImportLocals } from '../../config/runtime-mode.mjs';
import { loadEntities, resolveReferences } from '../../parser/load-entities';
import { deriveRoleRelationships } from '../../roles/derive';
import type { EntityDefinitionInput } from '../../derived/api/entity';
import { PROJECT_CONFIG_LOCALS } from '../backend/_entity-lookup';
import { BASELINE_CONFIG_FILE, BASELINE_ENTITIES_DIR, BASELINE_ROOT, REPO_ROOT, type DefinitionSet } from '../derived/_inputs';
import { RENDER_MATRIX } from '../derived/_render-matrix';

// ---------------------------------------------------------------------------
// The generator's answer, read from an emitted `*.entity.ts`
// ---------------------------------------------------------------------------

/** The Drizzle property a SQL column is declared under — `accountId: uuid('account_id')…`. */
function propOf(source: string, column: string): string | undefined {
  return new RegExp(`^\\s*(\\w+):\\s*\\w+\\('${column}'`, 'm').exec(source)?.[1];
}

/**
 * Whether the emitted entity declares `column` unique: an inline `.unique()` on
 * its column, or a `unique(…)` / `uniqueIndex(…)` over that column alone or
 * over the tenant column then it.
 */
function generatedUnique(source: string, column: string, tenantColumn: string | null): boolean {
  const prop = propOf(source, column);
  if (prop === undefined) throw new Error(`no column '${column}' in the generated entity`);
  const line = new RegExp(`^\\s*${prop}:.*$`, 'm').exec(source)?.[0] ?? '';
  if (/\.unique\(\)/.test(line)) return true;
  const tenantProp = tenantColumn !== null ? propOf(source, tenantColumn) : undefined;
  for (const m of source.matchAll(/\b(?:unique|uniqueIndex)\('[^']*'\)\.on\(([^)]*)\)/g)) {
    const cols = m[1]!.split(',').map((c) => c.trim().replace(/^t\./, ''));
    if (cols.length === 1 && cols[0] === prop) return true;
    if (tenantProp !== undefined && cols.length === 2 && cols[0] === tenantProp && cols[1] === prop) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The payload's answer
// ---------------------------------------------------------------------------

/** Parse a definition set the way the CLI does — YAML files on disk through `loadEntities` — and serialize it. */
function serializedOf(set: DefinitionSet, tablePrefix: string): SerializedDomainGraph {
  const dir = mkdtempSync(join(tmpdir(), 'fk-unique-parity-'));
  try {
    for (const d of set.entities) writeFileSync(join(dir, `${d.entity.name}.yaml`), yaml.stringify(d));
    return serializeGraphOfDir(dir, tablePrefix);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function serializeGraphOfDir(dir: string, tablePrefix: string): SerializedDomainGraph {
  const { entities, issues } = loadEntities(dir, { tablePrefix });
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) throw new Error(errors.map((i) => i.message).join('\n'));
  resolveReferences(entities);
  return serializeDomainGraph(buildDomainGraph(entities));
}

interface Fk {
  entity: string;
  column: string;
  fkUnique: boolean | undefined;
}

function belongsToFks(graph: SerializedDomainGraph): Fk[] {
  return Object.values(graph.entities).flatMap((e) =>
    Object.values(e.relationships)
      .filter((r) => r.type === 'belongs_to')
      .map((r) => ({ entity: e.name, column: r.foreignKey, fkUnique: r.fkUnique })),
  );
}

function tenantColumnOf(definition: { tenant_scoped?: unknown }): string | null {
  const t = definition.tenant_scoped;
  if (t === true) return 'tenant_id';
  if (t !== null && typeof t === 'object' && 'column' in t && typeof t.column === 'string') return t.column;
  return null;
}

/** Every disagreement, both directions, each naming the entity, the FK and the file. */
function mismatches(fks: Fk[], generated: (entity: string) => { source: string; file: string; tenant: string | null }): string[] {
  return fks.flatMap((fk) => {
    const { source, file, tenant } = generated(fk.entity);
    const emitted = generatedUnique(source, fk.column, tenant);
    if (fk.fkUnique === emitted) return [];
    return [
      `${fk.entity}.${fk.column} (${file}): fkUnique=${String(fk.fkUnique)} but the generated entity ${
        emitted ? 'declares' : 'does not declare'
      } a unique on it`,
    ];
  });
}

// ---------------------------------------------------------------------------
// (a) The baseline
// ---------------------------------------------------------------------------

function findEntityFile(dir: string, name: string): string | undefined {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findEntityFile(path, name);
      if (found) return found;
    } else if (entry.name === `${kebab(name)}.entity.ts`) {
      return path;
    }
  }
  return undefined;
}

describe('fkUnique ≡ the generated Drizzle entity — the checked-in baseline', () => {
  it('agrees for every belongs_to FK', () => {
    const config = loadCodegenConfig(BASELINE_CONFIG_FILE);
    const graph = serializeGraphOfDir(BASELINE_ENTITIES_DIR, config.tables.prefix);
    const modules = join(REPO_ROOT, BASELINE_ROOT, config.paths.modules_dir);
    const fks = belongsToFks(graph);
    expect(fks.length).toBeGreaterThan(0);

    const bad = mismatches(fks, (entity) => {
      const file = findEntityFile(modules, entity);
      if (file === undefined) throw new Error(`no generated entity file for '${entity}' under ${modules}`);
      const raw = yaml.parse(readFileSync(join(BASELINE_ENTITIES_DIR, sourceFileOf(graph, entity)), 'utf-8'));
      return { source: readFileSync(file, 'utf-8'), file, tenant: tenantColumnOf(raw) };
    });
    expect(bad).toEqual([]);
  });
});

function sourceFileOf(graph: SerializedDomainGraph, entity: string): string {
  const path = graph.entities[entity]!.sourcePath;
  return path.slice(path.lastIndexOf('/') + 1);
}

// ---------------------------------------------------------------------------
// (b) The render matrix, plus the unique-FK shapes
// ---------------------------------------------------------------------------

const ENTITY_TEMPLATE = (() => {
  const lines = readFileSync(join(REPO_ROOT, 'templates/entity/new/backend/entity.ejs.t'), 'utf-8').split('\n');
  return lines.slice(lines.indexOf('---', 1) + 1).join('\n');
})();

/** `entity.ejs.t` for one entity of a set, with the locals `prompt.js` owns. */
function renderEntityFile(set: DefinitionSet, name: string): string {
  const raw = set.entities.find((d) => d.entity.name === name);
  if (!raw) throw new Error(`'${name}' is not in the set`);
  const definition = structuredClone(raw);
  if (definition.roles) {
    definition.relationships = { ...(definition.relationships ?? {}), ...deriveRoleRelationships(definition.roles) };
  }
  const locals = buildBackendLocals(definition, {
    generatedBanner: '',
    runtimeMode: 'vendored',
    ...runtimeImportLocals('vendored'),
    processedQueries: [],
    hasDetection: false,
    detectionConfigsLiteral: '{}',
    hasEmits: false,
    emitsEvents: [],
    createEventType: null,
    updateEventType: null,
    deleteEventType: null,
    ...PROJECT_CONFIG_LOCALS,
    entityLookup: entityLookupFrom(set.entities.map((d) => d.entity)),
    junctions: set.junctions,
    renderSet: set.entities.map((d) => d.entity.name),
  });
  return ejs.render(ENTITY_TEMPLATE, locals, { rmWhitespace: false });
}

const def = (d: Record<string, unknown>): EntityDefinitionInput => d as unknown as EntityDefinitionInput;

const shelf = def({ entity: { name: 'shelf', plural: 'shelves' }, fields: { label: { type: 'string', required: true } } });
const bin = def({ entity: { name: 'bin', plural: 'bins' }, fields: { label: { type: 'string', required: true } } });
const onShelf = { type: 'belongs_to', target: 'shelf', foreign_key: 'shelf_id' };
const onBin = { type: 'belongs_to', target: 'bin', foreign_key: 'bin_id' };

/** Each FK shape the spine's tier 2 reads, beside the ones it must not. */
const UNIQUE_FK_SET: DefinitionSet = {
  entities: [
    shelf,
    bin,
    // field-level `unique: true` on the FK column → unique
    def({
      entity: { name: 'crate', plural: 'crates' },
      fields: { shelf_id: { type: 'uuid', required: true, unique: true } },
      relationships: { shelf: onShelf, bin: onBin },
    }),
    // a single-column `unique_indexes:` entry → unique
    def({
      entity: { name: 'tray', plural: 'trays' },
      fields: { label: { type: 'string' } },
      relationships: { shelf: onShelf, bin: onBin },
      unique_indexes: [{ fields: ['bin_id'] }],
    }),
    // a composite entry over both FKs → neither is unique
    def({
      entity: { name: 'pallet', plural: 'pallets' },
      fields: { label: { type: 'string' } },
      relationships: { shelf: onShelf, bin: onBin },
      unique_indexes: [{ fields: ['shelf_id', 'bin_id'] }],
    }),
    // tenant_scoped: the field unique lowers to (tenant_id, shelf_id) — still unique per parent
    def({
      entity: { name: 'drawer', plural: 'drawers' },
      fields: { shelf_id: { type: 'uuid', required: true, unique: true } },
      relationships: { shelf: onShelf, bin: onBin },
      tenant_scoped: true,
    }),
    // tenant_scoped, through `unique_indexes:`
    def({
      entity: { name: 'locker', plural: 'lockers' },
      fields: { label: { type: 'string' } },
      relationships: { bin: onBin },
      tenant_scoped: true,
      unique_indexes: [{ fields: ['bin_id'] }],
    }),
  ],
  junctions: [],
};

const CASES: { id: string; set: DefinitionSet }[] = [
  ...RENDER_MATRIX.map((c) => ({ id: c.id, set: { entities: c.entities, junctions: c.junctions } })),
  { id: 'unique-fk-shapes', set: UNIQUE_FK_SET },
];

describe('fkUnique ≡ the generated Drizzle entity — the render matrix and the unique-FK shapes', () => {
  for (const c of CASES) {
    it(`${c.id}: agrees for every belongs_to FK`, () => {
      const graph = serializedOf(c.set, '');
      const fks = belongsToFks(graph);
      const bad = mismatches(fks, (entity) => {
        const raw = c.set.entities.find((d) => d.entity.name === entity)!;
        return {
          source: renderEntityFile(c.set, entity),
          file: `${c.id}: ${entity}.entity.ts`,
          tenant: tenantColumnOf(raw as { tenant_scoped?: unknown }),
        };
      });
      expect(bad).toEqual([]);
    });
  }

  it('the unique-FK shapes exercise both answers — the gate cannot pass vacuously', () => {
    const fks = belongsToFks(serializedOf(UNIQUE_FK_SET, ''));
    const unique = fks.filter((f) => f.fkUnique === true).map((f) => `${f.entity}.${f.column}`).sort();
    expect(unique).toEqual(['crate.shelf_id', 'drawer.shelf_id', 'locker.bin_id', 'tray.bin_id']);
    expect(fks.some((f) => f.fkUnique === false)).toBe(true);
  });
});
