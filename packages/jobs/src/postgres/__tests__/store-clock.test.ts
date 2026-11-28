import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Every timestamp the Postgres store writes comes from its injected `now`: its SQL never reads the database's clock,
// which a fake-clock contract run cannot tell apart from the injected one when the two agree.

const DB_CLOCK =
  /(?<![.\w$])(?:now|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday)\s*\(\s*\)|\b(?:current_timestamp|current_date|current_time|localtimestamp|localtime)\b/i;

const sourceDir = join(import.meta.dir, '..');
const sources = readdirSync(sourceDir).filter((name) => name.endsWith('.ts'));

const withoutComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the Postgres store reads no database clock', () => {
  test('finds the store sources', () => {
    expect(sources).toContain('postgres-job-store.ts');
  });

  test.each(sources)('%s', (name) => {
    const lines = withoutComments(
      readFileSync(join(sourceDir, name), 'utf8'),
    ).split('\n');
    expect(lines.filter((line) => DB_CLOCK.test(line))).toEqual([]);
  });

  test('the pattern catches a SQL clock and spares the injected one', () => {
    expect(DB_CLOCK.test('SET updated_at = now()')).toBe(true);
    expect(DB_CLOCK.test('WHERE run_at <= CURRENT_TIMESTAMP')).toBe(true);
    expect(DB_CLOCK.test('const at = tsOf(this.now());')).toBe(false);
  });
});
