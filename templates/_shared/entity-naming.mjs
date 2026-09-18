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
 * Readers: `templates/entity/new/prompt.js`, the clean-lite-ps extension, and
 * `templates/junction/new/prompt.js`.
 */

import fs from 'node:fs';
import path from 'node:path';
import pluralizePkg from 'pluralize';
import yaml from 'yaml';

/**
 * An entity's module naming, from its OWN `entity:` block: `plural:` (else
 * `pluralize(name)`, for raw YAML that bypassed the schema, which requires it)
 * is both the Drizzle table export and the module folder, nested under
 * `context:` when one is declared.
 *
 * `moduleDir` is the folder holding the entity's files;
 * `entityFile` is its entity module path without extension.
 */
export function entityModuleNaming(entityBlock, srcRoot) {
  const plural = entityBlock.plural || pluralizePkg.plural(entityBlock.name);
  const moduleGroupDir = entityBlock.context
    ? `${srcRoot}/modules/${entityBlock.context}`
    : `${srcRoot}/modules`;
  const moduleDir = `${moduleGroupDir}/${plural}`;
  return {
    plural,
    moduleGroupDir,
    moduleDir,
    entityFile: `${moduleDir}/${entityBlock.name}.entity`,
  };
}

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
 * Where entity YAMLs live: `paths.entities`, else `paths.entities_dir`, else
 * `entities` — relative to `cwd`. The CLI's own rule
 * (`src/cli/shared/context.ts` › `resolveEntitiesDir`).
 */
export function resolveEntitiesDir(cwd) {
  let configured = null;
  for (const name of ['codegen.config.yaml', 'codegen.config.yml']) {
    const configPath = path.resolve(cwd, name);
    if (!fs.existsSync(configPath)) continue;
    try {
      const paths = yaml.parse(fs.readFileSync(configPath, 'utf-8'))?.paths ?? {};
      const dir = paths.entities ?? paths.entities_dir;
      if (typeof dir === 'string' && dir.length > 0) configured = dir;
    } catch {
      // A malformed config is reported by the CLI's own loader.
    }
    break;
  }
  return path.resolve(cwd, configured ?? 'entities');
}

/**
 * Look up another entity's `entity:` block from the project's entity YAMLs.
 * Lazy and cached: the directory is read on the first lookup. Parsed with
 * `yaml` directly, as the prompts parse every entity.
 *
 * Returns a function `(name) => entityBlock | null`, with `.byPlural(plural)`
 * for a field-level `foreign_key: <table>.<column>`, which names the table.
 */
export function createEntityLookup(entitiesDir) {
  let byName = null;
  let byPlural = null;
  const load = () => {
    byName = new Map();
    byPlural = new Map();
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.ya?ml$/.test(e.name)) {
          try {
            const doc = yaml.parse(fs.readFileSync(full, 'utf-8'));
            if (doc && doc.entity && typeof doc.entity.name === 'string') {
              byName.set(doc.entity.name, doc.entity);
              byPlural.set(entityModuleNaming(doc.entity, '').plural, doc.entity);
            }
          } catch {
            // A malformed YAML is reported by the CLI's own validation; it is
            // simply not resolvable here.
          }
        }
      }
    };
    walk(entitiesDir);
  };
  const lookup = (name) => {
    if (!byName) load();
    return byName.get(name) ?? null;
  };
  lookup.byPlural = (plural) => {
    if (!byPlural) load();
    return byPlural.get(plural) ?? null;
  };
  return lookup;
}

/**
 * A lookup over entity blocks already in hand — for callers that build locals
 * without an entities directory (unit tests).
 */
export function entityLookupFrom(entityBlocks) {
  const byName = new Map(entityBlocks.map((b) => [b.name, b]));
  const byPlural = new Map(entityBlocks.map((b) => [entityModuleNaming(b, '').plural, b]));
  const lookup = (name) => byName.get(name) ?? null;
  lookup.byPlural = (plural) => byPlural.get(plural) ?? null;
  return lookup;
}
