/**
 * `renderSqlPredicate` (#784): the raw-SQL `where:` renderer for partial unique
 * indexes. Column words become `${t.<prop>}`; everything else is copied.
 */

import { describe, it, expect } from 'bun:test';
import { renderSqlPredicate } from '../../../templates/_shared/sql-predicate.mjs';

const cols = new Map<string, string>([
  ['closed_at', 'closedAt'],
  ['name', 'name'],
  ['date', 'date'],
  ['col', 'col'],
  ['status', 'status'],
]);
const r = (p: string) => renderSqlPredicate(p, cols);

describe('renderSqlPredicate', () => {
  it('rewrites a column word', () => {
    expect(r('closed_at IS NULL')).toBe('${t.closedAt} IS NULL');
  });

  it('folds case like Postgres', () => {
    expect(r('Closed_At IS NULL')).toBe('${t.closedAt} IS NULL');
  });

  it('leaves a column name inside a string literal', () => {
    expect(r("status = 'closed_at'")).toBe("${t.status} = 'closed_at'");
  });

  it("handles '' inside a literal", () => {
    expect(r("status = 'it''s name'")).toBe("${t.status} = 'it''s name'");
  });

  it('never rewrites a quoted identifier', () => {
    expect(r('"name" = 1')).toBe('"name" = 1');
  });

  it('rewrites the argument of a function call but not the function', () => {
    expect(r('lower(name) = 1')).toBe('lower(${t.name}) = 1');
    const withFn = new Map(cols).set('lower', 'lower');
    expect(renderSqlPredicate('lower(name)', withFn)).toBe('lower(${t.name})');
  });

  it('does not rewrite a type after :: or a typed literal', () => {
    expect(r('status::date')).toBe('${t.status}::date');
    expect(r("closed_at > date '2024-01-01'")).toBe("${t.closedAt} > date '2024-01-01'");
  });

  it('does not rewrite a qualified name', () => {
    expect(r('x.col = 1')).toBe('x.col = 1');
    expect(r('col.y = 1')).toBe('col.y = 1');
  });

  it('leaves unknown words alone', () => {
    expect(r('now() IS NOT TRUE')).toBe('now() IS NOT TRUE');
  });

  it('matches whole words only: a column name inside a longer word is untouched', () => {
    for (const w of ['status_code', 'old_status', 'name2', 'statuses']) {
      expect(r(`${w} = 1`)).toBe(`${w} = 1`);
    }
    expect(r('status_code = name2')).toBe('status_code = name2');
  });

  it('keeps a number with an exponent whole', () => {
    expect(r('status > 1e5')).toBe('${t.status} > 1e5');
  });

  it('rejects each forbidden sequence with its offset', () => {
    for (const bad of [';', '--', '/*', '$', '`', '\\']) {
      expect(() => r(`status ${bad} x`)).toThrow(/at offset 7/);
    }
  });

  it('rejects unterminated quotes', () => {
    expect(() => r("status = 'abc")).toThrow(/unterminated ' quote at offset 9/);
    expect(() => r('"abc')).toThrow(/unterminated " quote at offset 0/);
  });

  it('escapes backslash, backtick and ${ inside a literal so the template round-trips', () => {
    const input = "status = 'a\\b`c${d}'";
    const body = r(input);
    expect(body).toContain('\\\\');
    expect(body).toContain('\\`');
    expect(body).toContain('\\${');
    const t = { status: 'STATUS' };
    const evaluated = new Function('t', 'return `' + body + '`')(t);
    expect(evaluated).toBe("STATUS = 'a\\b`c${d}'");
  });
});
