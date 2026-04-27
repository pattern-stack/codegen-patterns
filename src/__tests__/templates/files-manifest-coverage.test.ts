/**
 * Prevention test for issue #266 — assert that every cross-package import
 * from a template (`templates/**\/*.{js,mjs,cjs}` reaching into `../**\/src/...`)
 * resolves to a file that the published `package.json:files` manifest will
 * include in the npm tarball.
 *
 * Background: 0.6.0 shipped `templates/entity/new/prompt.js` which imports
 * `../../../src/config/paths.mjs` at runtime, but the `files` manifest
 * only listed `["dist", "runtime", "templates", ...]`. Every consumer's
 * `entity new` invocation died with `Cannot find module '../../../src/config/paths.mjs'`.
 *
 * The smoke + baseline tests didn't catch this because they run from the
 * source checkout, where `../../../src/config/paths.mjs` resolves directly.
 * Only `npm pack && npm install ./pack.tgz && entity new` exposes the gap.
 *
 * This test enumerates the imports statically and proves each touched path
 * matches at least one entry in `files`. A new template that adds a
 * cross-package import without updating `files` will fail here pre-publish.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { glob } from 'glob';
import { resolve, relative, dirname, join } from 'node:path';

/**
 * Tiny glob → RegExp converter sufficient for `package.json:files` patterns.
 * Supports:
 *   *       — match anything except `/`
 *   **      — match across path separators
 *   ?       — single non-`/` char
 *   {a,b}   — alternation
 * No extglob, no character classes — none of those appear in `files`.
 */
function globToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      re += '.*';
      i += 2;
      if (pattern[i] === '/') i++;
    } else if (c === '*') {
      re += '[^/]*';
      i++;
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      const alts = pattern.slice(i + 1, end).split(',').map((a) => a.replace(/[.+^$|()[\]\\]/g, '\\$&'));
      re += `(?:${alts.join('|')})`;
      i = end + 1;
    } else if (/[.+^$|()[\]\\]/.test(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

const REPO_ROOT = resolve(import.meta.dir, '../../..');

interface CrossPackageImport {
  templateFile: string; // absolute path
  importSpecifier: string; // e.g. '../../../src/config/paths.mjs'
  resolvedAbsolute: string; // absolute path the specifier resolves to
}

/**
 * Extract every import/from "..." or import("...") with a relative
 * specifier that escapes the `templates/` tree (i.e. resolves outside it).
 */
function findCrossPackageImports(): CrossPackageImport[] {
  const templatesDir = resolve(REPO_ROOT, 'templates');
  const files = glob.sync('**/*.{js,mjs,cjs}', {
    cwd: templatesDir,
    absolute: true,
  });

  const out: CrossPackageImport[] = [];
  // Match `from "..."`, `from '...'`, `import "..."`, `import '...'`,
  // and `require("...")`. Only relative specifiers (start with '.').
  const importRegex = /(?:from|import|require)\s*\(?\s*["'](\.\.?\/[^"']+)["']\)?/g;

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = importRegex.exec(src)) !== null) {
      const spec = m[1];
      // Resolve relative to the template file's directory.
      let resolved = resolve(dirname(file), spec);

      // The specifier may use a `.js` extension that refers to a `.ts`
      // sibling (Bun's TS-aware ESM resolution). Normalize by checking
      // the common rewrites.
      if (!existsSync(resolved)) {
        const candidates = [
          resolved.replace(/\.js$/, '.ts'),
          resolved.replace(/\.mjs$/, '.mts'),
        ];
        for (const c of candidates) {
          if (existsSync(c)) {
            resolved = c;
            break;
          }
        }
      }

      // Skip imports that resolve back inside templates/ — those are
      // intra-package and don't depend on the files manifest.
      const rel = relative(templatesDir, resolved);
      if (!rel.startsWith('..')) continue;

      out.push({
        templateFile: file,
        importSpecifier: spec,
        resolvedAbsolute: resolved,
      });
    }
  }
  return out;
}

/**
 * Approximate `npm pack`'s behavior for the `files` field. We don't
 * implement the full ignore-rules cascade; instead, for each pattern we
 * resolve it against the repo root using `minimatch` (with directory
 * patterns expanding to all descendants) and assert that the candidate
 * path falls inside the resulting set.
 *
 * This is a conservative shape — patterns like "dist" cover everything
 * under `dist/`, while patterns like "src/config/*.mjs" cover only the
 * matching glob.
 */
function isCoveredByFiles(absPath: string, filesPatterns: string[]): boolean {
  const rel = relative(REPO_ROOT, absPath);
  for (const pattern of filesPatterns) {
    // Bare directory entry: matches anything under that directory.
    const dirCandidate = resolve(REPO_ROOT, pattern);
    if (existsSync(dirCandidate) && statSync(dirCandidate).isDirectory()) {
      const insideRel = relative(dirCandidate, absPath);
      if (insideRel && !insideRel.startsWith('..')) return true;
      continue;
    }
    // Glob pattern.
    if (globToRegExp(pattern).test(rel)) return true;
    // Pattern with directory prefix (e.g. "src/patterns/library/*.ts")
    // and absPath being the same — minimatch handles this above. Done.
  }
  return false;
}

describe('package.json:files covers all cross-package template imports (#266)', () => {
  const pkg = JSON.parse(
    readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'),
  );
  const filesPatterns: string[] = pkg.files;

  const imports = findCrossPackageImports();

  it('finds at least the known #266 cross-package imports', () => {
    // Sanity: if we ever get to zero, the regex broke. The known offenders
    // from #266 (prompt.js + clean-lite-ps prompt-extension.js) ensure a
    // non-zero floor today.
    expect(imports.length).toBeGreaterThan(0);
  });

  it('every cross-package import resolves to a file shipped by `files`', () => {
    const uncovered: { spec: string; from: string; resolved: string }[] = [];
    for (const imp of imports) {
      // The resolution may map to a file that doesn't exist on disk if
      // the import is dead — flag those too.
      if (!existsSync(imp.resolvedAbsolute)) {
        uncovered.push({
          spec: imp.importSpecifier,
          from: relative(REPO_ROOT, imp.templateFile),
          resolved: '<does not exist>: ' + relative(REPO_ROOT, imp.resolvedAbsolute),
        });
        continue;
      }
      if (!isCoveredByFiles(imp.resolvedAbsolute, filesPatterns)) {
        uncovered.push({
          spec: imp.importSpecifier,
          from: relative(REPO_ROOT, imp.templateFile),
          resolved: relative(REPO_ROOT, imp.resolvedAbsolute),
        });
      }
    }

    if (uncovered.length > 0) {
      const lines = uncovered.map(
        (u) => `  - ${u.from}\n      imports "${u.spec}"\n      → ${u.resolved}`,
      );
      throw new Error(
        `Templates import paths not covered by package.json:files (will break npm consumers):\n` +
          lines.join('\n') +
          `\n\nFix: add narrow paths to "files" in package.json. See #266.`,
      );
    }
  });
});
