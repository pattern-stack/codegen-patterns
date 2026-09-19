/**
 * Junction naming + parent fan-out for the hygen prompts (JUNC-0, #678).
 *
 * A junction (`pattern: Junction`, `between: [left, right]`) is mirrored onto
 * both parent services: attach / detach / list / setPrimary, delegating to the
 * one junction service (`docs/relationship-pattern-audit.md` §1). The parent's
 * OWN clean-lite-ps service + module templates render that fan-out from the
 * junction YAML set — never an inject into a file another command owns, so
 * `entity new` and `junction new` in any order give the same bytes (charter I2).
 *
 * Readers: `templates/junction/new/prompt.js` (the junction's own files) and
 * `templates/entity/new/clean-lite-ps/prompt-extension.js` (the parents' fan-out
 * and the Communication capability's `via:` junction). One naming rule for all
 * of them (charter I1). The name + plural rule itself is
 * `src/config/junction-naming.ts`, shared with the CLI (schema, roles, barrels).
 *
 * The CLI validates every junction YAML before hygen runs (`entity new` and
 * `junction new` pre-flights), so this module reads the raw YAML.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { junctionName, junctionPlural } from '../../src/config/junction-naming.js';
import { junctionsDirFor } from '../../src/config/junctions-dir.js';
import { findYamlFiles } from '../../src/utils/find-yaml-files.js';
import { entityModuleNaming, relativeModuleDir } from './entity-naming.mjs';

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const camelCase = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const pascalCase = (s) => capitalize(camelCase(s));

/** A junction's name: its endpoints in `between:` order (`src/config/junction-naming.ts`). */
export { junctionName };

/**
 * Everything a junction is called, from its name: table / folder `plural`
 * (`pluralize(name)`, no YAML override), the flat module folder under
 * `modulesDir` (a junction has no `context:`), its files, classes and the
 * property a parent service holds it under.
 */
export function junctionNaming(name, modulesDir) {
  const plural = junctionPlural(name);
  const tree = entityModuleNaming({ name, plural }, modulesDir);
  const moduleDir = path.posix.normalize(tree.moduleDir);
  const pascal = pascalCase(name);
  return {
    name,
    plural,
    moduleDir,
    entityFile: path.posix.normalize(tree.entityFile),
    repositoryFile: path.posix.normalize(tree.repositoryFile),
    serviceFile: `${moduleDir}/${name}.service.ts`,
    moduleFile: path.posix.normalize(tree.moduleFile),
    tableVar: camelCase(plural),
    entityClass: pascal,
    serviceClass: `${pascal}Service`,
    moduleClass: `${pascalCase(plural)}Module`,
    linkInputType: `${pascal}LinkInput`,
    serviceProperty: `${camelCase(name)}Service`,
  };
}

/**
 * Every junction YAML under the project's junctions directory
 * (`src/config/junctions-dir.ts`), raw-parsed, sorted by junction name. A
 * missing directory is an empty set.
 */
export function loadJunctionDefinitions(cwd) {
  const dir = junctionsDirFor(cwd);
  if (!fs.existsSync(dir)) return [];
  const defs = [];
  for (const file of findYamlFiles(dir)) {
    let doc;
    try {
      doc = yaml.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      // Unreachable through the CLI: `entity new` / `junction new` reject any
      // file under junctions/ that does not parse or is not `pattern: Junction`
      // (src/parser/load-junctions.ts › loadJunctionSet) before hygen runs.
      continue;
    }
    if (doc && doc.pattern === 'Junction' && Array.isArray(doc.between)) defs.push(doc);
  }
  return defs.sort((a, b) => junctionName(a.between).localeCompare(junctionName(b.between)));
}

/**
 * The fan-out blocks `entityName`'s service + module carry: one per junction
 * naming it in `between:` whose side is exposed (`expose_on_parent.<side>`,
 * default true), in junction-name order.
 *
 * `ctx`: `{ junctions, modulesDir, entityLookup, selfModuleDir }` — the
 * counterparty's module folder comes from its own YAML (NAME-0); import paths
 * are relative to `selfModuleDir`.
 */
export function junctionFanOutFor(entityName, ctx) {
  const { junctions, modulesDir, entityLookup, selfModuleDir } = ctx;
  const blocks = [];
  for (const def of junctions) {
    const [left, right] = def.between;
    if (left !== entityName && right !== entityName) continue;
    const side = left === entityName ? 'left' : 'right';
    if ((def.expose_on_parent ?? {})[side] === false) continue;

    const name = junctionName(def.between);
    const counterparty = side === 'left' ? right : left;
    const block = entityLookup ? entityLookup(counterparty) : null;
    if (!block) {
      const why = entityLookup ? entityLookup.missingEntity(counterparty) : 'no entity lookup was supplied';
      throw new Error(
        `[codegen] junction '${name}': endpoint '${counterparty}' has no entity YAML — ${why}.`,
      );
    }
    const counterpartyNaming = entityModuleNaming(block, modulesDir);
    const junction = junctionNaming(name, modulesDir);
    const junctionDir = relativeModuleDir(selfModuleDir, junction.moduleDir);
    const counterpartyPascal = pascalCase(counterparty);
    const counterpartyPlural = counterpartyNaming.plural;

    blocks.push({
      side,
      junction,
      leftIdParam: `${camelCase(left)}Id`,
      rightIdParam: `${camelCase(right)}Id`,
      selfIdParam: `${camelCase(entityName)}Id`,
      counterpartyIdParam: `${camelCase(counterparty)}Id`,
      counterpartyPascal,
      counterpartyEntityImport:
        `${relativeModuleDir(selfModuleDir, counterpartyNaming.moduleDir)}/${counterparty}.entity`,
      junctionServiceImport: `${junctionDir}/${name}.service`,
      junctionEntityImport: `${junctionDir}/${name}.entity`,
      junctionModuleImport: `${junctionDir}/${junction.plural}.module`,
      attachMethod: side === 'left' ? `attach${counterpartyPascal}` : `addTo${counterpartyPascal}`,
      detachMethod: side === 'left' ? `detach${counterpartyPascal}` : `removeFrom${counterpartyPascal}`,
      listMethod: `${counterpartyPlural}List`,
      setPrimaryMethod: `${counterpartyPlural}SetPrimary`,
    });
  }
  return blocks;
}
