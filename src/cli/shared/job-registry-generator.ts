/**
 * The job registry (JOBS-3): `<paths.generated>/jobs.ts`, every `@pattern-stack/jobs` job the app defines, which the
 * generated subsystems barrel hands `JobsEngineModule.forRoot({ definitions })`.
 *
 * It walks the jobs directory (`layout.jobHandlers`, `<backend_src>/jobs`: the authored jobs and the ones the YAML
 * jobs emit, RFC-0005) and lists every top-level `export const <name> = defineJob(...)` (or a YAML job's
 * `define<Name>Job(...)`) and every `export const <name> = jobFactory(...)` (a job whose steps need the app's
 * services: `JobsEngineModule` builds it with its dependencies resolved), in path order, then declaration order. A job is code, registered once: two exports with one name are a generation error naming both
 * files. The file is regenerated on every `entity new`, so a new job file joins the registry on the next run.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import { findHandlerFiles } from './bridge-registry-generator.js';
import type { TargetWiring } from '../../targets/apps.js';
import { rowFor } from '../../utils/keyed-row.js';

export const JOB_REGISTRY_FILE = 'jobs.ts';

export interface ScannedJob {
  /** The exported const's name. */
  name: string;
  /** Absolute path of the file that declares it. */
  file: string;
  /**
   * A `jobFactory(...)` export's dependencies, in its `deps` order (J-1): each one's name and, when it is written
   * `injected<T>('<token>')` with a string, the token. A class token (or anything else) has no `token`: under
   * pattern-stack wiring a dependency must name a composition part, so the composition refuses it.
   */
  deps?: ScannedJobDep[];
}

export interface ScannedJobDep {
  name: string;
  token?: string;
  /** Why the scan could not read this dependency (a spread, a computed key, `deps` not an object literal). */
  unreadable?: string;
}

/** A key the emitted `jobDeps` module can write unquoted (`name: deps.part`). */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * A `jobFactory({ deps: { … } })` call's dependencies, read from its object literal. A form the scan cannot read is
 * kept, marked `unreadable`, so the composition refuses it by name instead of dropping it: the spec not an object
 * literal, `deps` written as a shorthand or not there as a property, `deps` not an object literal, a spread, a computed
 * key, or a string key that is no identifier (`'my-dep'`, which the jobDeps module could not write).
 */
function factoryDeps(call: ts.CallExpression): ScannedJobDep[] {
  const [spec] = call.arguments;
  if (!spec) return [];
  if (!ts.isObjectLiteralExpression(spec)) return [{ name: spec.getText(), unreadable: 'the factory spec is not an object literal' }];
  const depsProp = spec.properties.find((p) => p.name !== undefined && p.name.getText() === 'deps');
  if (!depsProp) return [];
  if (!ts.isPropertyAssignment(depsProp)) return [{ name: 'deps', unreadable: '`deps` is a shorthand, not `deps: { … }`' }];
  if (!ts.isObjectLiteralExpression(depsProp.initializer)) {
    return [{ name: depsProp.initializer.getText(), unreadable: '`deps` is not an object literal' }];
  }
  return depsProp.initializer.properties.map((p): ScannedJobDep => {
    if (ts.isShorthandPropertyAssignment(p)) return { name: p.name.text, unreadable: 'a shorthand property' };
    if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
      return { name: p.getText(), unreadable: 'not a `name: injected(…)` property' };
    }
    if (!IDENTIFIER.test(p.name.text)) return { name: p.name.text, unreadable: 'a key that is not an identifier' };
    const init = p.initializer;
    const token =
      ts.isCallExpression(init) &&
      ts.isIdentifier(init.expression) &&
      init.expression.text === 'injected' &&
      init.arguments[0] &&
      ts.isStringLiteralLike(init.arguments[0])
        ? init.arguments[0].text
        : undefined;
    return { name: p.name.text, ...(token !== undefined ? { token } : {}) };
  });
}

/** Every `export const <name> = defineJob(...)` / `jobFactory(...)` in one source file, in declaration order. */
export function extractJobsFromSourceFile(sourceFile: ts.SourceFile, filePath: string): ScannedJob[] {
  const out: ScannedJob[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const init = decl.initializer;
      if (!ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) continue;
      // `defineJob(...)`, a generated `define<Name>Job(...)` (a YAML job's, RFC-0005), which returns one, or
      // `jobFactory(...)`, the job with dependencies.
      if (!/^(?:define(?:[A-Z]\w*)?Job|jobFactory)$/.test(init.expression.text)) continue;
      out.push({
        name: decl.name.text,
        file: filePath,
        ...(init.expression.text === 'jobFactory' ? { deps: factoryDeps(init) } : {}),
      });
    }
  }
  return out;
}

/** Every job under `jobsDir`, files in path order. A missing directory has none. */
export function scanJobFiles(jobsDir: string): ScannedJob[] {
  if (!fs.existsSync(jobsDir)) return [];
  return findHandlerFiles(jobsDir).flatMap((file) =>
    extractJobsFromSourceFile(
      ts.createSourceFile(file, fs.readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true),
      file,
    ),
  );
}

/** The module's content: one import per job file, and the list. */
/** The list's doc line, per `target.wiring`: who builds the factories (J-1). */
const REGISTRY_DOC: Readonly<Record<TargetWiring, string>> = {
  nest: '/** Every job this app runs (a factory is built with its dependencies), handed to `JobsEngineModule.forRoot({ definitions })`. */',
  'pattern-stack': "/** Every job this app runs (a factory is built with the values `jobDeps` provides), the `jobs` system's definitions. */",
};

export function buildJobRegistryContent(
  jobs: readonly ScannedJob[],
  outputDir: string,
  wiring: TargetWiring = 'nest',
): string {
  const seen = new Map<string, string>();
  for (const job of jobs) {
    const first = seen.get(job.name);
    if (first)
      throw new Error(
        `two jobs are exported as '${job.name}' (${first} and ${job.file}): a job's export name is the registry's, so each must be unique`,
      );
    seen.set(job.name, job.file);
  }
  const byFile = new Map<string, string[]>();
  for (const job of jobs) byFile.set(job.file, [...(byFile.get(job.file) ?? []), job.name]);
  const specifier = (file: string) => {
    const rel = path.relative(outputDir, file).replace(/\\/g, '/').replace(/\.ts$/, '');
    return rel.startsWith('.') ? rel : `./${rel}`;
  };
  const lines = [
    '// @generated by @pattern-stack/codegen (JOBS-3): every `defineJob` / `jobFactory` export under the jobs directory. DO NOT EDIT.',
    '// Regenerated by `codegen entity new`. Add a job by exporting it from a file there.',
    "import type { JobEntry } from '@pattern-stack/jobs';",
    ...[...byFile.entries()].map(([file, names]) => `import { ${names.join(', ')} } from '${specifier(file)}';`),
    '',
    rowFor('target.wiring', REGISTRY_DOC, wiring),
    `export const jobDefinitions: readonly JobEntry[] = [${jobs.map((j) => j.name).join(', ')}];`,
    '',
  ];
  return lines.join('\n');
}

/** Writes `<outputDir>/jobs.ts` (unless `dryRun`); returns its path and the jobs it lists. */
export function generateJobRegistry(opts: {
  jobsDir: string;
  outputDir: string;
  dryRun?: boolean;
  wiring?: TargetWiring;
}): { path: string; jobs: ScannedJob[]; changed: boolean } {
  const target = path.join(opts.outputDir, JOB_REGISTRY_FILE);
  const jobs = scanJobFiles(opts.jobsDir);
  const content = buildJobRegistryContent(jobs, opts.outputDir, opts.wiring);
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : null;
  const changed = existing !== content;
  if (changed && !opts.dryRun) {
    fs.mkdirSync(opts.outputDir, { recursive: true });
    fs.writeFileSync(target, content);
  }
  return { path: target, jobs, changed };
}
