/**
 * Zod issue → editor position. A wrong answer here points the author at the
 * wrong line, which is worse than no marker at all.
 */
import { describe, expect, test } from 'bun:test';
import type { ZodIssueLike } from '@studio-shared';
import { formatIssuePath, issueMessage, locateIssues } from '../inspector/yaml-issues';

function issue(path: (string | number)[], message = 'Invalid input', code = 'invalid_type'): ZodIssueLike {
  return { path, message, code };
}

/** Line numbers below refer to this document, 1-based. */
const DOC = [
  'entity:', //                1
  '  name: contact', //        2
  '  plural: contacts', //     3
  '  fields:', //              4
  '    email:', //             5
  '      type: string', //     6
  '      required: true', //   7
  '    age:', //               8
  '      type: nonsense', //   9
  '  queries:', //            10
  '    - by: [email]', //     11
  '      unique: true', //    12
  '    - by: [age]', //       13
  ''.padEnd(0), //            14 (trailing newline)
].join('\n');

describe('locateIssues', () => {
  test('a scalar value resolves to its own line', () => {
    const [located] = locateIssues(DOC, [issue(['entity', 'fields', 'age', 'type'])]);
    expect(located!.exact).toBe(true);
    expect(located!.location?.line).toBe(9);
    expect(DOC.slice(located!.location!.from, located!.location!.to)).toBe('nonsense');
  });

  test('a top-level key resolves to its own line', () => {
    const [located] = locateIssues(DOC, [issue(['entity', 'name'])]);
    expect(located!.location?.line).toBe(2);
    expect(DOC.slice(located!.location!.from, located!.location!.to)).toBe('contact');
  });

  test('a path ending on a block resolves to the key, not the block', () => {
    const [located] = locateIssues(DOC, [issue(['entity', 'fields', 'email'])]);
    expect(located!.exact).toBe(true);
    expect(located!.location?.line).toBe(5);
    expect(DOC.slice(located!.location!.from, located!.location!.to)).toBe('email');
  });

  test('a missing key resolves to its nearest existing ancestor', () => {
    // `age` has no `required`, which is exactly the shape of a Zod
    // invalid_type issue for a missing required property.
    const [located] = locateIssues(DOC, [
      issue(['entity', 'fields', 'age', 'required'], 'Required', 'invalid_type'),
    ]);
    expect(located!.exact).toBe(false);
    expect(located!.resolvedPath).toEqual(['entity', 'fields', 'age']);
    expect(located!.location?.line).toBe(8);
  });

  test('a sequence index resolves to the item', () => {
    const [located] = locateIssues(DOC, [issue(['entity', 'queries', 1, 'by'])]);
    expect(located!.exact).toBe(true);
    expect(located!.location?.line).toBe(13);
  });

  test('an out-of-range sequence index falls back to the sequence', () => {
    const [located] = locateIssues(DOC, [issue(['entity', 'queries', 9, 'by'])]);
    expect(located!.exact).toBe(false);
    expect(located!.resolvedPath).toEqual(['entity', 'queries']);
  });

  test('an empty path resolves to the document root', () => {
    const [located] = locateIssues(DOC, [issue([], 'Unrecognized key')]);
    expect(located!.exact).toBe(true);
    expect(located!.location?.line).toBe(1);
  });

  test('columns are 1-based', () => {
    const [located] = locateIssues(DOC, [issue(['entity', 'name'])]);
    // `  name: contact` — the value starts at column 9.
    expect(located!.location?.column).toBe(9);
  });

  test('every issue is returned, in order', () => {
    const located = locateIssues(DOC, [
      issue(['entity', 'name']),
      issue(['entity', 'fields', 'age', 'type']),
      issue(['entity', 'nope']),
    ]);
    expect(located).toHaveLength(3);
    expect(located.map((l) => l.location?.line)).toEqual([2, 9, 1]);
  });

  test('an empty document yields no location rather than throwing', () => {
    const located = locateIssues('', [issue(['entity', 'name'])]);
    expect(located).toHaveLength(1);
    expect(located[0]!.location).toBeUndefined();
  });

  test('a document that does not parse still returns one entry per issue', () => {
    const located = locateIssues('entity:\n  - a\n  b: c\n', [issue(['entity', 'name'])]);
    expect(located).toHaveLength(1);
  });

  test('a range never ends before it starts', () => {
    for (const located of locateIssues(DOC, [
      issue(['entity']),
      issue(['entity', 'fields']),
      issue(['entity', 'queries', 0]),
    ])) {
      expect(located.location!.to).toBeGreaterThan(located.location!.from);
    }
  });
});

describe('formatIssuePath', () => {
  test('dots for keys, brackets for indices', () => {
    expect(formatIssuePath(['entity', 'queries', 1, 'by'])).toBe('entity.queries[1].by');
  });

  test('an empty path formats to an empty string', () => {
    expect(formatIssuePath([])).toBe('');
  });
});

describe('issueMessage', () => {
  test('an exact hit reads as the path and the message', () => {
    const [located] = locateIssues(DOC, [issue(['entity', 'name'], 'Expected string')]);
    expect(issueMessage(located!)).toBe('entity.name: Expected string');
  });

  test('a fallback hit says the value is expected there', () => {
    const [located] = locateIssues(DOC, [issue(['entity', 'fields', 'age', 'required'], 'Required')]);
    expect(issueMessage(located!)).toBe('entity.fields.age.required: Required (expected here)');
  });

  test('a root issue keeps just the message', () => {
    const [located] = locateIssues(DOC, [issue([], 'Unrecognized key: "nope"')]);
    expect(issueMessage(located!)).toBe('Unrecognized key: "nope"');
  });
});

describe('the entity: wrapper', () => {
  // A 422 may report the path with or without the document's top-level block,
  // depending on whether the server validated the whole file or its body.
  // Both spellings have to land on the same line.
  test('an unwrapped path resolves inside the top-level block', () => {
    const [wrapped] = locateIssues(DOC, [issue(['entity', 'fields', 'age', 'type'])]);
    const [bare] = locateIssues(DOC, [issue(['fields', 'age', 'type'])]);

    expect(bare!.location?.line).toBe(9);
    expect(bare!.location).toEqual(wrapped!.location!);
  });

  test('an unwrapped path that misses everywhere still falls back to the root', () => {
    const [located] = locateIssues(DOC, [issue(['nowhere', 'at', 'all'])]);
    expect(located!.exact).toBe(false);
    expect(located!.location?.line).toBe(1);
  });

  test('the wrapper is only skipped when the direct path matched nothing', () => {
    // `name` exists under `entity:`; it must not be re-resolved somewhere else.
    const [located] = locateIssues(DOC, [issue(['entity', 'name'])]);
    expect(located!.location?.line).toBe(2);
  });
});

describe('a YAML parse failure', () => {
  // The commonest 422 on a hand-edited file is not a schema violation: it is a
  // parse error, reported with an empty path and the position in the message.
  // Resolving the empty path would land on line 1, twenty lines from the fault.
  const BROKEN = 'entity:\n  name: contact\n  fields:\n      email:\n    type: string\n';
  const parseIssue = issue(
    [],
    'All mapping items must start at the same column at line 5, column 5:\n\n    type: string\n    ^\n',
    'custom',
  );

  test('uses the position carried in the message', () => {
    const [located] = locateIssues(BROKEN, [parseIssue]);
    expect(located!.location?.line).toBe(5);
    expect(located!.location?.column).toBe(5);
    expect(located!.exact).toBe(true);
  });

  test('the range covers the rest of the offending line', () => {
    const [located] = locateIssues(BROKEN, [parseIssue]);
    expect(BROKEN.slice(located!.location!.from, located!.location!.to)).toBe('type: string');
  });

  test('a position past the end of the document falls back to the root', () => {
    // The marker still has to render somewhere; dropping it would leave the
    // author with a message and nowhere to look.
    const [located] = locateIssues('a: 1\n', [issue([], 'bad at line 99, column 3')]);
    expect(located!.location?.line).toBe(1);
  });

  test('a schema issue with a path ignores any position in its message', () => {
    // A real schema message could mention a line; the path is the better signal.
    const [located] = locateIssues(DOC, [
      issue(['entity', 'name'], 'see the note at line 99, column 1'),
    ]);
    expect(located!.location?.line).toBe(2);
  });

  test('a path-less issue with no position still falls back to the root', () => {
    const [located] = locateIssues(DOC, [issue([], 'Unrecognized key')]);
    expect(located!.location?.line).toBe(1);
  });
});

describe('issueMessage collapses a multi-line message', () => {
  // A parse error's message embeds the offending snippet and a caret. The
  // issue list is one row per issue, so it has to read on one line.
  const MULTILINE =
    'All mapping items must start at the same column at line 5, column 5:\n\n    type: string\n    ^\n';

  test('newlines and the caret line are gone', () => {
    const [located] = locateIssues('a: 1\n', [issue([], MULTILINE)]);
    const text = issueMessage(located!);
    expect(text).not.toContain('\n');
    expect(text).not.toMatch(/\s\^/);
    expect(text).toBe(
      'All mapping items must start at the same column at line 5, column 5: type: string',
    );
  });

  test('a single-line message is unchanged', () => {
    const [located] = locateIssues(DOC, [issue(['entity', 'name'], 'Expected string')]);
    expect(issueMessage(located!)).toBe('entity.name: Expected string');
  });
});
