import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// The package's import fences, as tests. Each rule is a
// bullet of AGENTS.md ("Layers and imports", "The framework adapters"): the core's only runtime dependency is zod;
// each framework is reached only under its own export path; production code never imports ./testing.

const SRC = resolve(import.meta.dir, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(path);
    return e.name.endsWith('.ts') ? [path] : [];
  });
}

/** Every module a file names, relative or bare, with whether the import is type-only. */
function specifiersOf(file: string): { spec: string; typeOnly: boolean }[] {
  const text = readFileSync(file, 'utf8');
  const out: { spec: string; typeOnly: boolean }[] = [];
  for (const m of text.matchAll(/^(import|export)(\s+type)?\s[^;]*?from\s+'([^']+)'/gms))
    out.push({ spec: m[3] as string, typeOnly: m[2] !== undefined });
  for (const m of text.matchAll(/^import\s+'([^']+)'/gm)) out.push({ spec: m[1] as string, typeOnly: false });
  for (const m of text.matchAll(/import\(\s*'([^']+)'\s*\)/g)) out.push({ spec: m[1] as string, typeOnly: false });
  return out;
}

const rel = (file: string) => relative(SRC, file);
const isRelative = (spec: string) => spec.startsWith('.');
const isNode = (spec: string) => spec.startsWith('node:');

/** The directory (or top-level barrel) each framework may be imported from, and only there. */
const FRAMEWORK_HOME: Record<string, readonly string[]> = {
  '@nestjs/': ['nest/', 'nest.ts'],
  '@opentelemetry/': ['nest/', 'nest.ts', 'host/', 'host.ts'],
  'drizzle-orm': ['postgres/', 'postgres.ts'],
  bullmq: ['bullmq/', 'bullmq.ts'],
};

/** The core: everything that is not a framework adapter. */
const CORE = ['model/', 'ports/', 'policy/', 'define/', 'engine/', 'adapters/', 'shapes/', 'testing/'];
const ADAPTERS = ['postgres/', 'bullmq/', 'redis/', 'nest/', 'host/'];

const files = sourceFiles(SRC);
const inside = (file: string, homes: readonly string[]) =>
  homes.some((h) => (h.endsWith('/') ? rel(file).startsWith(h) : rel(file) === h));

describe('import fences', () => {
  test("the core's only bare import is zod", () => {
    const wrong = files
      .filter((f) => inside(f, CORE) || ['index.ts', 'ports.ts', 'testing.ts', 'shapes.ts'].includes(rel(f)))
      .flatMap((f) =>
        specifiersOf(f)
          .filter((i) => !isRelative(i.spec) && i.spec !== 'zod')
          // The testing layer may read node's own modules (temp dirs, assertions), and the in-memory adapters
          // node:crypto for their ids (Node and Bun both have it); the engine never reads node.
          .filter((i) => !(rel(f).startsWith('testing/') && isNode(i.spec)))
          .filter((i) => !(rel(f).startsWith('adapters/') && i.spec === 'node:crypto'))
          .map((i) => `${rel(f)} -> ${i.spec}`),
      );
    expect(wrong).toEqual([]);
  });

  test('a framework is imported only under its own export path', () => {
    const wrong = files.flatMap((f) =>
      specifiersOf(f)
        .filter((i) => !isRelative(i.spec))
        .flatMap((i) => {
          const fw = Object.keys(FRAMEWORK_HOME).find((k) => i.spec === k || i.spec.startsWith(k));
          return fw && !inside(f, FRAMEWORK_HOME[fw] as readonly string[]) ? [`${rel(f)} -> ${i.spec}`] : [];
        }),
    );
    expect(wrong).toEqual([]);
  });

  test('nothing imports a workspace package, its own name, or a deep path past the exports map', () => {
    const wrong = files.flatMap((f) =>
      specifiersOf(f)
        .filter((i) => /^@repo\//.test(i.spec) || /^@pattern-stack\//.test(i.spec))
        .map((i) => `${rel(f)} -> ${i.spec}`),
    );
    expect(wrong).toEqual([]);
  });

  test('the core never imports an adapter path', () => {
    const wrong = files
      .filter((f) => inside(f, CORE))
      .flatMap((f) =>
        specifiersOf(f)
          .filter((i) => isRelative(i.spec))
          .map((i) => relative(SRC, resolve(dirname(f), i.spec)))
          .filter((target) => ADAPTERS.some((a) => target.startsWith(a)) || ['nest.ts', 'postgres.ts', 'bullmq.ts', 'redis.ts', 'host.ts'].includes(target))
          .map((target) => `${rel(f)} -> ${target}`),
      );
    expect(wrong).toEqual([]);
  });

  test('./host never reaches Nest: no host file imports nest/ or nest.ts (a plain host loads it with no @nestjs)', () => {
    const wrong = files
      .filter((f) => inside(f, ['host/', 'host.ts']))
      .flatMap((f) =>
        specifiersOf(f)
          .filter((i) => isRelative(i.spec))
          .map((i) => relative(SRC, resolve(dirname(f), i.spec)))
          .filter((target) => target.startsWith('nest/') || target === 'nest.ts')
          .map((target) => `${rel(f)} -> ${target}`),
      );
    expect(wrong).toEqual([]);
  });

  test('production code never imports the testing layer', () => {
    const wrong = files
      .filter((f) => !rel(f).startsWith('testing/') && rel(f) !== 'testing.ts')
      .flatMap((f) =>
        specifiersOf(f)
          .filter((i) => isRelative(i.spec))
          .map((i) => relative(SRC, resolve(dirname(f), i.spec)))
          .filter((target) => target.startsWith('testing/') || target === 'testing.ts')
          .map((target) => `${rel(f)} -> ${target}`),
      );
    expect(wrong).toEqual([]);
  });
});
