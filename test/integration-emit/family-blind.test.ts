/**
 * S7c (#917) — a provider sync has no opinion on an entity's family hierarchy.
 *
 * Renders the integration layer for `mail_message` twice, same provider, same surface, same entity name:
 *   A. a plain `pattern: Integrated` entity carrying the child's flat shape (`fixtures/integrated-child-flat`);
 *   B. the S7a family, where it is a joined-table child of `inbox_item` (`fixtures/integrated-child`).
 * The two trees must be byte-identical, file for file. No line is filtered.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadEntitiesFromYaml, loadProvidersFromYaml } from '../../src/utils/yaml-loader';
import { findYamlFiles } from '../../src/utils/find-yaml-files';
import { generateProviderModules, collectEntitySurfaces } from '../../src/cli/shared/provider-module-generator';
import { emitAdapters } from '../../src/cli/shared/adapter-emission-generator';
import { TenancyConfigSchema } from '../../src/schema/codegen-config.schema';
import { serializeTree } from './_emit';

const FIX = resolve(import.meta.dir, '../fixtures');
const PROVIDERS = join(FIX, 'integrated-child/definitions/providers');

/** The whole entity set, as `entity new` passes it (the family fixture also holds the base and a sibling kind). */
function emitLayer(entitiesDir: string): string {
  const providerLoads = loadProvidersFromYaml(findYamlFiles(PROVIDERS));
  if (providerLoads.failures.length) throw new Error(providerLoads.failures.map((f) => f.error).join('; '));
  const entityLoads = loadEntitiesFromYaml(findYamlFiles(entitiesDir));
  if (entityLoads.failures.length) throw new Error(entityLoads.failures.map((f) => f.error).join('; '));
  const entities = entityLoads.successes.map((e) => e.definition);

  const tmp = mkdtempSync(join(tmpdir(), 'cgp-s7c-'));
  const root = join(tmp, 'src', 'integrations');
  // The CLI hands the emitters the whole set; `only` narrows what is compared, not what is passed.
  const surfaced = entities;
  const providerResult = generateProviderModules({
    providersDir: PROVIDERS,
    outputRoot: join(root, 'providers'),
    entitySurfaces: collectEntitySurfaces(entities),
    skipImportCheck: true,
    mode: 'package',
  });
  if (providerResult.issues.length) throw new Error(providerResult.issues.map((i) => i.message).join('; '));
  emitAdapters({
    providers: providerLoads.successes.map((p) => ({ definition: p.definition, filePath: p.filePath })),
    entities: surfaced,
    outputRoot: root,
    backendSrcAbs: join(tmp, 'src'),
    modulesAbs: join(tmp, 'src', 'modules'),
    aliases: { '@modules': join(tmp, 'src', 'modules') },
    mode: 'package',
    tenancyColumn: TenancyConfigSchema.parse({}).column,
  });
  return root;
}

function files(tree: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of tree.split(/^\/\/ ===== FILE: /m).slice(1)) {
    const nl = part.indexOf(' =====\n');
    out.set(part.slice(0, nl), part.slice(nl + 7));
  }
  return out;
}

describe('S7c — the integration layer is family-blind', () => {
  const flat = files(serializeTree(emitLayer(join(FIX, 'integrated-child-flat/entities'))));
  const familyTree = serializeTree(emitLayer(join(FIX, 'integrated-child/entities')));
  const family = files(familyTree);

  test('the layer is not empty (the gate has a subject)', () => {
    expect([...flat.keys()].some((k) => k.endsWith('mail-message.sink.generated.ts'))).toBe(true);
    expect([...flat.keys()].some((k) => k.endsWith('mail-message-integration.module.ts'))).toBe(true);
  });

  test('same file set', () => {
    expect([...family.keys()].sort()).toEqual([...flat.keys()].sort());
  });

  test('same bytes, file for file', () => {
    for (const [path, bytes] of flat) expect(family.get(path)).toBe(bytes);
  });

  test('the family layer matches its snapshot (new files only; bytes equal the flat layer above)', () => {
    expect(familyTree).toMatchSnapshot();
  });
});
