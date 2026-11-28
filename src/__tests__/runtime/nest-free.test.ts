/**
 * The Nest-free runtime (PW-0): every entry pattern-stack wiring output may import loads
 * no `@nestjs/*` package and no `reflect-metadata`, through any chain of relative
 * imports, type-only imports included (a pattern-stack app installs no `@nestjs`, so even
 * a type import would fail to compile there).
 *
 * The failure names the chain, so a new import that drags Nest in is easy to find.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import {
  NEST_FREE_SUBSYSTEMS,
  openApiImport,
  subsystemCoreImport,
} from '../../cli/shared/runtime-import';
import {
  runtimeImportLocals,
  subsystemCoreImport as subsystemCoreImportMjs,
} from '../../config/runtime-mode.mjs';

const RUNTIME = path.resolve(import.meta.dir, '../../../runtime');

/** The Nest-free entries, relative to `runtime/`. */
const ENTRIES = [
  'logger.ts',
  'errors.ts',
  'base-classes/index.ts',
  'types/drizzle.ts',
  'constants/tokens.ts',
  'eav-helpers.ts',
  'http/pagination.ts',
  'http/includes.ts',
  'shared/openapi/index.ts',
  // SET-1: the settings loader every pattern-stack app's `settings` system calls.
  'settings.ts',
  ...NEST_FREE_SUBSYSTEMS.map((name) => `subsystems/${name}/core.ts`),
  // S-1: the event bus backends the pattern-stack `events` system constructs (imported by path, the selected one only).
  'subsystems/events/event-bus.drizzle-backend.ts',
  'subsystems/events/event-bus.memory-backend.ts',
  // S-3: the integration backends the pattern-stack `integration` system constructs (the Drizzle pair by path).
  'subsystems/integration/integration-cursor-store.drizzle-backend.ts',
  'subsystems/integration/integration-run-recorder.drizzle-backend.ts',
];

// `@pattern-stack/jobs/nest` is the jobs package's Nest layer (J-1: the jobs core reaches its framework-free parts
// through `@pattern-stack/jobs/host`).
const FORBIDDEN = (spec: string) =>
  spec.startsWith('@nestjs/') || spec === 'reflect-metadata' || spec.startsWith('@pattern-stack/jobs/nest');

function importsOf(file: string): string[] {
  const info = ts.preProcessFile(fs.readFileSync(file, 'utf8'), true, true);
  return info.importedFiles.map((f) => f.fileName);
}

/** Resolves a relative specifier the way the compiler would; an unresolved one fails the gate, never skips. */
function resolveRelative(from: string, spec: string): string {
  const base = path.resolve(path.dirname(from), spec);
  const stem = base.replace(/\.(c|m)?js$/, '');
  const candidates = [
    base,
    ...['.ts', '.tsx', '.mts', '.cts', '.d.ts'].map((ext) => `${stem}${ext}`),
    ...['index.ts', 'index.tsx', 'index.mts'].map((f) => path.join(base, f)),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`nest-free gate: can't resolve '${spec}' from ${path.relative(RUNTIME, from)}`);
}

/** The first chain from `entry` to a forbidden import, or undefined. */
function nestChain(entry: string): string[] | undefined {
  const seen = new Set<string>();
  const walk = (file: string, chain: string[]): string[] | undefined => {
    if (seen.has(file)) return undefined;
    seen.add(file);
    for (const spec of importsOf(file)) {
      const here = [...chain, path.relative(RUNTIME, file)];
      if (FORBIDDEN(spec)) return [...here, spec];
      if (!spec.startsWith('.')) continue;
      const next = resolveRelative(file, spec);
      const found = walk(next, here);
      if (found) return found;
    }
    return undefined;
  };
  return walk(path.join(RUNTIME, entry), []);
}

describe('the Nest-free runtime entries', () => {
  for (const entry of ENTRIES) {
    it(`${entry} reaches no @nestjs package`, () => {
      expect(fs.existsSync(path.join(RUNTIME, entry))).toBe(true);
      const chain = nestChain(entry);
      expect(chain === undefined ? 'Nest-free' : chain.join(' → ')).toBe('Nest-free');
    });
  }

  it('the gate sees a Nest import when there is one (control)', () => {
    expect(nestChain('subsystems/events/index.ts')).toBeDefined();
    expect(nestChain('nest-logger.ts')).toBeDefined();
  });
});

describe('subsystemCoreImport', () => {
  it('names a file that exists, for every Nest-free subsystem', () => {
    for (const name of NEST_FREE_SUBSYSTEMS) {
      expect(fs.existsSync(path.join(RUNTIME, 'subsystems', name, 'core.ts'))).toBe(true);
    }
  });

  it('agrees with its .mjs twin in both modes', () => {
    for (const name of NEST_FREE_SUBSYSTEMS) {
      for (const mode of ['package', 'vendored'] as const) {
        expect(subsystemCoreImportMjs(mode, name)).toBe(subsystemCoreImport(mode, name));
      }
    }
    expect(subsystemCoreImport('package', 'events')).toBe(
      '@pattern-stack/codegen/runtime/subsystems/events/core',
    );
    expect(subsystemCoreImport('vendored', 'auth')).toBe('@shared/subsystems/auth/core');
  });

  it('openApiImport agrees with the templates\' openApiImport in both modes (PW-3b)', () => {
    for (const mode of ['package', 'vendored'] as const) {
      expect(openApiImport(mode)).toBe(runtimeImportLocals(mode).openApiImport);
    }
  });
});
