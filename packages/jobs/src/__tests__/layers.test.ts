import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// The package's layering and the engine's determinism, read from the source: each rule here is one bullet of
// packages/jobs/AGENTS.md, and this file is its guard.

const SRC = resolve(import.meta.dir, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(path);
    return e.name.endsWith('.ts') ? [path] : [];
  });
}

/** A file's relative imports, as paths under src (`engine/context.ts`), each with whether it is type-only. */
function importsOf(file: string): { target: string; typeOnly: boolean }[] {
  const text = readFileSync(file, 'utf8');
  const out: { target: string; typeOnly: boolean }[] = [];
  for (const m of text.matchAll(
    /^(import|export)(\s+type)?\s[^;]*?from\s+'(\.[^']+)'/gms,
  )) {
    const spec = m[3] as string;
    out.push({
      target: relative(SRC, resolve(dirname(file), spec)),
      typeOnly: m[2] !== undefined,
    });
  }
  return out;
}

const layerOf = (path: string) => path.split('/')[0] as string;
const filesIn = (layer: string) => sourceFiles(join(SRC, layer));

describe('layers', () => {
  const allowed: Record<string, readonly string[]> = {
    model: ['model'],
    ports: ['model'],
    policy: ['model'],
    define: ['model', 'policy', 'define', 'ports'],
  };
  for (const [layer, may] of Object.entries(allowed))
    test(`src/${layer}/ imports only ${may.join(', ')}`, () => {
      const wrong = filesIn(layer).flatMap((file) =>
        importsOf(file)
          .filter((i) => !may.includes(layerOf(i.target)))
          .filter((i) => layerOf(i.target) !== layer)
          .map((i) => `${relative(SRC, file)} -> ${i.target}`),
      );
      expect(wrong).toEqual([]);
    });

  test('src/define/ reads the ports for the recorder types only', () => {
    const wrong = filesIn('define').flatMap((file) =>
      importsOf(file)
        .filter((i) => layerOf(i.target) === 'ports')
        .filter((i) => !i.typeOnly || !/recorder\.ts$/.test(i.target))
        .map((i) => `${relative(SRC, file)} -> ${i.target}`),
    );
    expect(wrong).toEqual([]);
  });

  test('src/engine/ never imports src/adapters/', () => {
    const wrong = filesIn('engine').flatMap((file) =>
      importsOf(file)
        .filter((i) => layerOf(i.target) === 'adapters')
        .map((i) => `${relative(SRC, file)} -> ${i.target}`),
    );
    expect(wrong).toEqual([]);
  });

  test("an executor adapter imports only the engine's entry points", () => {
    // Where any executor lives, every module beside it is part of that adapter.
    const ENTRY_POINTS = new Set([
      'advance-run',
      'process-chunk',
      'emitter',
      'values',
      'heartbeat',
      'stop-scan',
      'deps',
      'start-run',
      'context',
      'signals',
    ]);
    const executorDirs = new Set(
      sourceFiles(SRC)
        .filter((f) => /\bimplements Executor\b/.test(readFileSync(f, 'utf8')))
        .map((f) => dirname(f)),
    );
    expect(executorDirs.size).toBeGreaterThan(0);
    const wrong = [...executorDirs].flatMap((dir) =>
      sourceFiles(dir).flatMap((file) =>
        importsOf(file)
          .filter((i) => layerOf(i.target) === 'engine')
          .filter(
            (i) => !ENTRY_POINTS.has(i.target.replace(/^engine\/|\.ts$/g, '')),
          )
          .map((i) => `${relative(SRC, file)} -> ${i.target}`),
      ),
    );
    expect(wrong).toEqual([]);
  });
});

describe('the engine is deterministic', () => {
  // The clock, randomness, timers and I/O reach the engine only through its ports; ids come from the store.
  const FORBIDDEN: [RegExp, string][] = [
    [/\bDate\.now\s*\(/, 'Date.now()'],
    [/\bnew Date\s*\(\s*\)/, 'new Date()'],
    [/\bMath\.random\s*\(/, 'Math.random()'],
    [/\bsetTimeout\s*\(|\bsetInterval\s*\(/, 'a timer'],
    [/\bfetch\s*\(/, 'fetch'],
    [/\brandomUUID\b|['"]node:crypto['"]/, 'an id made in the engine'],
  ];
  test('src/engine/ reads no clock, randomness, timer, network or id of its own', () => {
    const wrong = filesIn('engine').flatMap((file) => {
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      return FORBIDDEN.filter(([re]) => re.test(code)).map(
        ([, what]) => `${relative(SRC, file)}: ${what}`,
      );
    });
    expect(wrong).toEqual([]);
  });
});
