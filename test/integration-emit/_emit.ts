/**
 * Integration-emit snapshot harness (RFC-0001 §7, Track D · D7).
 *
 * Drives the same emission entry points `cdp gen` invokes for the integration
 * tree — `generateProviderModules` (D2) + `emitAdapters` (D3/D4) — against the
 * checked-in `test/fixtures/integration-patterns/definitions/{entities,providers}`
 * fixture, into a tmp dir, and serializes the emitted `src/integrations/**`
 * subtree for snapshotting.
 *
 * Hermetic by design: no `bun init`, no dependency install, no Hygen subprocess
 * (unlike the junction bootstrap) — the emitters are pure string-builders, so
 * the snapshot is deterministic and fast. The pre-flight import check is skipped
 * (the fixture has no consumer source tree; that check has its own D1 unit
 * tests). The entity.ts pipeline that wires these emitters is exercised by the
 * smoke suite.
 *
 * Surface-extensible: providers + entities are read from the fixture dir, so
 * adding a second crm provider — or a new surface once its `codegen-<surface>`
 * package is registered in `SURFACE_REGISTRY` — is a YAML add + snapshot refresh,
 * never a harness change.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import {
  loadProvidersFromYaml,
  loadEntitiesFromYaml,
} from '../../src/utils/yaml-loader';
import { findYamlFiles } from '../../src/utils/find-yaml-files';
import {
  generateProviderModules,
  collectEntitySurfaces,
} from '../../src/cli/shared/provider-module-generator';
import { emitAdapters } from '../../src/cli/shared/adapter-emission-generator';

export const FIXTURE_ROOT = resolve(
  import.meta.dir,
  '../fixtures/integration-patterns/definitions',
);

export interface EmitResult {
  /** Absolute path to the emitted `src/integrations` root. */
  integrationsRoot: string;
  /** Skipped (provider, surface) pairs — surfaces with no registered package. */
  skippedSurfaces: Array<{ provider: string; surface: string }>;
}

/** Runtime mode (ADR-037) the emitters resolve runtime import specifiers off. */
export type RuntimeMode = 'package' | 'vendored';

/**
 * Run provider + adapter emission against the fixture into a fresh tmp dir.
 * `mode` (ADR-037) selects which runtime import specifier the emitters write —
 * `package` (default) ⇒ `@pattern-stack/codegen/subsystems`; `vendored` ⇒
 * `@shared/subsystems/<name>`. Both shapes are snapshotted (snapshot.test.ts).
 */
export function emitFixture(mode: RuntimeMode = 'package'): EmitResult {
  const providersDir = join(FIXTURE_ROOT, 'providers');
  const entitiesDir = join(FIXTURE_ROOT, 'entities');

  const { successes: providerLoads, failures: providerFails } =
    loadProvidersFromYaml(findYamlFiles(providersDir));
  if (providerFails.length) {
    throw new Error(
      `fixture providers failed to load: ${providerFails.map((f) => f.error).join('; ')}`,
    );
  }
  const { successes: entityLoads, failures: entityFails } =
    loadEntitiesFromYaml(findYamlFiles(entitiesDir));
  if (entityFails.length) {
    throw new Error(
      `fixture entities failed to load: ${entityFails.map((f) => f.error).join('; ')}`,
    );
  }

  const entityDefs = entityLoads.map((e) => e.definition);
  const providers = providerLoads.map((p) => ({
    definition: p.definition,
    filePath: p.filePath,
  }));

  const tmp = mkdtempSync(join(tmpdir(), 'cgp-d7-fixture-'));
  const integrationsRoot = join(tmp, 'src', 'integrations');

  // Mirror the entity.ts pipeline: provider modules, then adapters.
  const providerResult = generateProviderModules({
    providersDir,
    outputRoot: join(integrationsRoot, 'providers'),
    entitySurfaces: collectEntitySurfaces(entityDefs),
    skipImportCheck: true,
    mode,
  });
  if (providerResult.issues.length) {
    throw new Error(
      `fixture provider validation failed: ${providerResult.issues.map((i) => i.message).join('; ')}`,
    );
  }

  // Assembly emission (E2) needs the `<backend_src>` root + tsconfig aliases to
  // resolve each entity's repo/module import. The fixture has no consumer tree,
  // so we synthesize the swe-brain-style `@modules` alias (target `<src>/modules`)
  // to lock the proven alias-import form; the backend src root is `<tmp>/src`.
  const backendSrcAbs = join(tmp, 'src');
  const adapterResult = emitAdapters({
    providers,
    entities: entityDefs,
    outputRoot: integrationsRoot,
    backendSrcAbs,
    aliases: { '@modules': join(backendSrcAbs, 'modules') },
    mode,
  });

  return {
    integrationsRoot,
    skippedSurfaces: adapterResult.skippedSurfaces.map((s) => ({
      provider: s.provider,
      surface: s.surface,
    })),
  };
}

/**
 * Serialize a directory tree to a single deterministic string: each file under
 * a `// ===== FILE: <relpath> =====` header, files sorted by path, POSIX
 * separators. One snapshot captures the whole emitted tree — a reviewed
 * artifact that grows by addition as surfaces/providers are added.
 */
export function serializeTree(root: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (statSync(full).isFile()) files.push(full);
    }
  };
  walk(root);
  files.sort();
  return files
    .map((f) => {
      const rel = relative(root, f).split(sep).join('/');
      return `// ===== FILE: ${rel} =====\n${readFileSync(f, 'utf8')}`;
    })
    .join('\n');
}
