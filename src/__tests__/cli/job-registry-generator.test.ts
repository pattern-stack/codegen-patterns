/**
 * The job registry (`<generated>/jobs.ts`, JOBS-3): every `defineJob`, generated `define<Name>Job` and `jobFactory`
 * export under the jobs directory, in path order then declaration order; a duplicate export name is an error.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildJobRegistryContent, generateJobRegistry, scanJobFiles } from '../../cli/shared/job-registry-generator.js';

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'job-registry-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const write = (dir: string, rel: string, src: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), src);
};

describe('scanJobFiles', () => {
  it('finds defineJob, a YAML job’s define<Name>Job and jobFactory exports, in path then declaration order', () => {
    const dir = tmp();
    write(dir, 'b.job.ts', "export const second = defineJob({ key: 'b' });\nexport const third = jobFactory({ deps: {}, create: () => x });\n");
    write(dir, 'a.job.ts', "export const first = defineDrivePollJob({});\n");
    write(dir, 'sub/c.job.ts', "export const fourth = jobFactory({ deps: {}, create: () => x });\n");
    expect(scanJobFiles(dir).map((j) => j.name)).toEqual(['first', 'second', 'third', 'fourth']);
  });

  it('ignores what is not a job: unexported, other calls, a non-call initializer', () => {
    const dir = tmp();
    write(
      dir,
      'x.ts',
      [
        "const hidden = defineJob({ key: 'h' });",
        'export const helper = makeThing();',
        "export const triggers = jobTriggers('k', []);",
        'export const value = 1;',
      ].join('\n'),
    );
    expect(scanJobFiles(dir)).toEqual([]);
  });

  it('a missing directory has no jobs', () => {
    expect(scanJobFiles('/no/such/jobs/dir')).toEqual([]);
  });
});

describe('buildJobRegistryContent', () => {
  it('imports each file once and lists every job as a JobEntry', () => {
    const out = buildJobRegistryContent(
      [
        { name: 'a', file: '/app/src/jobs/one.job.ts' },
        { name: 'b', file: '/app/src/jobs/one.job.ts' },
        { name: 'c', file: '/app/src/jobs/two.job.ts' },
      ],
      '/app/src/generated',
    );
    expect(out).toContain("import type { JobEntry } from '@pattern-stack/jobs';");
    expect(out).toContain("import { a, b } from '../jobs/one.job';");
    expect(out).toContain("import { c } from '../jobs/two.job';");
    expect(out).toContain('export const jobDefinitions: readonly JobEntry[] = [a, b, c];');
  });

  it('two exports with one name are an error naming both files', () => {
    expect(() =>
      buildJobRegistryContent(
        [
          { name: 'dup', file: '/a.ts' },
          { name: 'dup', file: '/b.ts' },
        ],
        '/gen',
      ),
    ).toThrow(/two jobs are exported as 'dup' \(\/a\.ts and \/b\.ts\)/);
  });
});

describe('generateJobRegistry', () => {
  it('writes jobs.ts, then reports unchanged; dryRun writes nothing', () => {
    const root = tmp();
    write(root, 'jobs/a.job.ts', "export const a = defineJob({ key: 'a' });\n");
    const opts = { jobsDir: path.join(root, 'jobs'), outputDir: path.join(root, 'generated') };
    expect(generateJobRegistry({ ...opts, dryRun: true }).changed).toBe(true);
    expect(fs.existsSync(path.join(root, 'generated/jobs.ts'))).toBe(false);
    expect(generateJobRegistry(opts).changed).toBe(true);
    expect(generateJobRegistry(opts).changed).toBe(false);
  });
});
