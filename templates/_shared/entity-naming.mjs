/**
 * Cross-entity naming for the hygen prompts (NAME-0, #630 / #611).
 *
 * A generator that references another entity — a `belongs_to` FK, a `has_many`
 * repository, a junction endpoint — needs that entity's table export and module
 * folder. Both are stated once, in the target's own YAML (`plural:`,
 * `context:`), and the target's own emission derives them with
 * `entityModuleNaming`. Every reference goes through the same function, so the
 * two agree by construction — never by re-pluralizing the target's name at the
 * referencing site (charter I1; CLAUDE.md › Frontend Emitter, ADR-038).
 *
 * The zod-backed `loadEntityRegistry` (src/parser/entity-registry.ts) is the
 * same rule for the TS emitters; it cannot be imported here because its import
 * graph does not ship in the package's `files` (CAP-3 Found #9). This module
 * ships with `templates/`.
 *
 * Readers: `templates/entity/new/prompt.js`, the backend extension, and
 * `templates/junction/new/prompt.js`. Where the YAMLs live, and how the tree
 * is walked, is the CLI's own rule — imported, not restated
 * (`src/config/entities-dir.ts`, `src/utils/find-yaml-files.ts`), as is the
 * module tree (`src/config/module-tree.ts`).
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { entitiesDirPath, resolveEntitiesDir } from '../../src/config/entities-dir.js';
import { configOrDefaults, loadProjectConfig } from '../../src/config/project-config.js';
import { findYamlFiles } from '../../src/utils/find-yaml-files.js';
import { entityModuleNaming } from '../../src/config/module-tree.js';

/**
 * An entity's module naming — `plural`, `moduleDir`,
 * `entityFile` (no extension), `moduleFile`, `repositoryFile` — from its OWN
 * `entity:` block and the resolved `paths.modules_dir`. The module-tree rule is
 * the CLI's own (`src/config/module-tree.ts`, GEN-0 #649): the barrels and the
 * integration assemblies read the same function.
 */
export { entityModuleNaming };

/**
 * The import directory of `toDir` as seen from a file in `fromDir` — both
 * module folders from `entityModuleNaming`. Sibling flat folders give
 * `../<plural>`; a `context:` on either side adds the segments it needs.
 */
export function relativeModuleDir(fromDir, toDir) {
  const rel = path.posix.relative(fromDir, toDir);
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/**
 * Attach the lookup surface to a pair of maps. `where` describes what was
 * searched, for error messages: the resolved directory, or the candidates
 * when none exists.
 */
function makeLookup(load, where) {
  let maps = null;
  const get = () => (maps ??= load());
  const lookup = (name) => get().byName.get(name) ?? null;
  lookup.byPlural = (plural) => get().byPlural.get(plural) ?? null;
  /** Why `name` did not resolve: the directory searched and the file expected. */
  lookup.missingEntity = (name) =>
    where.dir
      ? `no YAML under ${where.dir} declares \`entity: { name: ${name} }\` (expected e.g. ${path.join(where.dir, `${name}.yaml`)})`
      : `no entities directory exists (looked for ${where.candidates.join(', ')}; expected e.g. <entities>/${name}.yaml)`;
  /** Why a table named by `foreign_key:` did not resolve. */
  lookup.missingPlural = (plural) =>
    where.dir
      ? `no YAML under ${where.dir} declares \`plural: ${plural}\``
      : `no entities directory exists (looked for ${where.candidates.join(', ')})`;
  return lookup;
}

/**
 * Index blocks by name and by plural. Two entities declaring the same plural
 * own the same table: a load error naming both, never last-write-wins.
 */
function indexBlocks(entries) {
  const byName = new Map();
  const byPlural = new Map();
  const pluralSource = new Map();
  for (const { block, source } of entries) {
    byName.set(block.name, block);
    const plural = entityModuleNaming(block, '').plural;
    if (pluralSource.has(plural)) {
      throw new Error(
        `[codegen] two entity YAMLs declare the table '${plural}': ` +
          `${pluralSource.get(plural)} and ${source}. A table has one owning entity.`,
      );
    }
    pluralSource.set(plural, source);
    byPlural.set(plural, block);
  }
  return { byName, byPlural };
}

/**
 * Look up another entity's `entity:` block from the entity YAMLs under
 * `entitiesDir` (walked with the CLI's `findYamlFiles`: recursive, dot-dirs
 * skipped). Lazy: the directory is read on the first lookup. `entitiesDir`
 * null (no directory exists) resolves nothing. `candidates` names what was
 * tried, for the error messages.
 *
 * Returns a function `(name) => entityBlock | null`, with `.byPlural(plural)`
 * for a field-level `foreign_key: <table>.<column>` (which names the table),
 * and `.missingEntity(name)` / `.missingPlural(plural)` message fragments.
 */
export function createEntityLookup(entitiesDir, candidates = []) {
  return makeLookup(
    () => {
      const entries = [];
      if (entitiesDir && fs.existsSync(entitiesDir)) {
        for (const file of findYamlFiles(entitiesDir)) {
          let doc;
          try {
            doc = yaml.parse(fs.readFileSync(file, 'utf-8'));
          } catch {
            // A malformed YAML is reported by the CLI's own validation; it is
            // simply not resolvable here.
            continue;
          }
          if (doc && doc.entity && typeof doc.entity.name === 'string') {
            entries.push({ block: doc.entity, source: file });
          }
        }
      }
      return indexBlocks(entries);
    },
    { dir: entitiesDir, candidates },
  );
}

const projectLookups = new Map();

/**
 * The entity lookup for the project at `cwd`, resolved with the CLI's rule
 * (the config the CLI resolved, else `codegen.config.yaml` found upward —
 * parsed by `project-config.ts`; the resolved `paths.entities`). Cached per resolved directory for the
 * life of the process, so every prompt call in one process shares one walk.
 * (Each `entity new` runs hygen in its own process — see NAME-0 Found.)
 */
export function projectEntityLookup(cwd) {
  const paths = configOrDefaults(loadProjectConfig(cwd)).paths;
  const dir = resolveEntitiesDir(cwd, paths);
  const candidates = [entitiesDirPath(cwd, paths)];
  const key = dir ?? `<none>:${candidates.join('|')}`;
  if (!projectLookups.has(key)) projectLookups.set(key, createEntityLookup(dir, candidates));
  return projectLookups.get(key);
}

/**
 * A lookup over entity blocks already in hand — for callers that build locals
 * without an entities directory (unit tests).
 */
export function entityLookupFrom(entityBlocks) {
  return makeLookup(
    () => indexBlocks(entityBlocks.map((block) => ({ block, source: `<${block.name}>` }))),
    { dir: '<in-memory>', candidates: [] },
  );
}
