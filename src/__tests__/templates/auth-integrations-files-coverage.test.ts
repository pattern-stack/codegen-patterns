/**
 * Prevention test for #303 — assert that the `examples/auth-integrations/`
 * starter is included in the published tarball.
 *
 * Background: 0.6.5 / 0.6.6 shipped `cdp subsystem install auth-integrations`,
 * which copies `examples/auth-integrations/runtime/connections/**` and
 * `examples/auth-integrations/definitions/entities/connection.yaml`
 * out of `node_modules/@pattern-stack/codegen/examples/auth-integrations/`
 * into the consumer's project. But `package.json:files` did not list
 * `examples/auth-integrations/**`, so npm consumers ran into a missing
 * source tree on first invocation.
 *
 * This test ensures every file the install logic copies is covered by
 * the `files` manifest. It mirrors `files-manifest-coverage.test.ts`
 * (#266) but is anchored to the explicit auth-integrations source paths
 * referenced from `src/cli/commands/subsystem.ts`.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../../..');

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

function isCoveredByFiles(absPath: string, filesPatterns: string[]): boolean {
  const rel = relative(REPO_ROOT, absPath);
  for (const pattern of filesPatterns) {
    const dirCandidate = resolve(REPO_ROOT, pattern);
    if (existsSync(dirCandidate) && statSync(dirCandidate).isDirectory()) {
      const insideRel = relative(dirCandidate, absPath);
      if (insideRel && !insideRel.startsWith('..')) return true;
      continue;
    }
    if (globToRegExp(pattern).test(rel)) return true;
  }
  return false;
}

function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

describe('package.json:files covers examples/auth-integrations/ (#303)', () => {
  const pkg = JSON.parse(
    readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'),
  );
  const filesPatterns: string[] = pkg.files;
  const examplesRoot = resolve(REPO_ROOT, 'examples', 'auth-integrations');

  it('starter source exists on disk', () => {
    expect(existsSync(examplesRoot)).toBe(true);
    expect(
      existsSync(
        join(examplesRoot, 'runtime', 'connections', 'connections-auth.module.ts'),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(examplesRoot, 'definitions', 'entities', 'connection.yaml'),
      ),
    ).toBe(true);
  });

  it('every file under examples/auth-integrations/ is covered by `files`', () => {
    const uncovered: string[] = [];
    for (const file of walk(examplesRoot)) {
      if (!isCoveredByFiles(file, filesPatterns)) {
        uncovered.push(relative(REPO_ROOT, file));
      }
    }
    if (uncovered.length > 0) {
      throw new Error(
        `examples/auth-integrations files not covered by package.json:files ` +
          `(install will fail in npm consumers):\n` +
          uncovered.map((p) => `  - ${p}`).join('\n') +
          `\n\nFix: add "examples/auth-integrations/**" to "files".`,
      );
    }
  });
});
