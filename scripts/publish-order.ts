/**
 * The publishable packages, in the order they build and publish: the one list `just publish-ci` and the tarball
 * smoke (`test/post-publish/run-tarball-smoke.ts`) both read.
 *
 * Publishable: the root (`@pattern-stack/codegen`) and every `packages/*` opted in with `publishConfig.access:
 * public` and not `private`. The order comes from the manifests: a package builds after every publishable package it
 * names in `dependencies` or `peerDependencies`, because its build type-checks against their `dist/` (the root's
 * runtime imports `@pattern-stack/jobs`; a surface package's `.d.ts` resolves `@pattern-stack/codegen/subsystems`,
 * ADR-036 §8). `devDependencies` are not build edges: the root's on the surface packages are for its tests, and
 * counting them would make a cycle. A real cycle is refused by name. A new workspace package the root imports
 * (`@pattern-stack/wiring`) takes its place by its manifest alone.
 *
 * `bun scripts/publish-order.ts` prints one `dir|name|version` line per package, in order.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface PublishPkg {
  /** Absolute path of the package's folder. */
  dir: string;
  name: string;
  version: string;
}

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  publishConfig?: { access?: string };
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const manifestAt = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));

/** The publishable packages under `root`, each after the publishable packages it builds against. */
export function publishOrder(root: string): PublishPkg[] {
  const candidates = [
    root,
    ...readdirSync(join(root, 'packages'))
      .sort()
      .map((entry) => join(root, 'packages', entry))
      .filter((dir) => existsSync(join(dir, 'package.json'))),
  ]
    .map((dir) => ({ dir, manifest: manifestAt(dir) }))
    .filter(({ dir, manifest }) => dir === root || (manifest.private !== true && manifest.publishConfig?.access === 'public'));

  const byName = new Map(candidates.map((c) => [c.manifest.name, c]));
  const buildsAgainst = (m: Manifest) =>
    Object.keys({ ...m.dependencies, ...m.peerDependencies }).filter((dep) => dep !== m.name && byName.has(dep));

  // Depth-first, in discovery order (the root, then packages/* by folder name), so the order is stable.
  const ordered: PublishPkg[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string, path: string[]): void => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      throw new Error(`publish order: the packages build against each other in a cycle: ${[...path, name].join(' → ')}`);
    }
    state.set(name, 'visiting');
    const { dir, manifest } = byName.get(name)!;
    for (const dep of buildsAgainst(manifest)) visit(dep, [...path, name]);
    state.set(name, 'done');
    ordered.push({ dir, name: manifest.name, version: manifest.version });
  };
  for (const c of candidates) visit(c.manifest.name, []);
  return ordered;
}

if (import.meta.main) {
  const root = process.cwd();
  for (const pkg of publishOrder(root)) console.log(`${relative(root, pkg.dir) || '.'}|${pkg.name}|${pkg.version}`);
}
