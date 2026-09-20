/**
 * Unified diff → the lines the diff pane renders.
 */
import { describe, expect, test } from 'bun:test';
import { parsePatch, patchTotals } from '../drawer/parse-patch';

const PATCH = `diff --git a/entities/contact.yaml b/entities/contact.yaml
index 1a2b3c4..5d6e7f8 100644
--- a/entities/contact.yaml
+++ b/entities/contact.yaml
@@ -3,6 +3,8 @@ entity:
   plural: contacts
   fields:
     email:
-      type: text
+      type: string
+      required: true
   behaviors:
     - timestamps
`;

describe('parsePatch', () => {
  test('drops the git preamble', () => {
    const { lines } = parsePatch(PATCH);
    expect(lines.some((l) => l.text.startsWith('diff --git'))).toBe(false);
    expect(lines.some((l) => l.text.startsWith('index '))).toBe(false);
    expect(lines.some((l) => l.text.startsWith('--- ') || l.text.startsWith('+++ '))).toBe(false);
    expect(lines[0]!.kind).toBe('hunk');
  });

  test('counts additions and removals', () => {
    const { added, removed } = parsePatch(PATCH);
    expect(added).toBe(2);
    expect(removed).toBe(1);
  });

  test('numbers lines from the hunk header, per side', () => {
    const { lines } = parsePatch(PATCH);
    const body = lines.filter((l) => l.kind !== 'hunk');

    expect(body.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['context', 3, 3],
      ['context', 4, 4],
      ['context', 5, 5],
      ['del', 6, undefined],
      ['add', undefined, 6],
      ['add', undefined, 7],
      ['context', 7, 8],
      ['context', 8, 9],
    ]);
  });

  test('strips the marker from the text', () => {
    const { lines } = parsePatch(PATCH);
    const added = lines.filter((l) => l.kind === 'add');
    expect(added.map((l) => l.text)).toEqual(['      type: string', '      required: true']);
  });

  test('an empty patch yields no lines', () => {
    expect(parsePatch('')).toEqual({ lines: [], added: 0, removed: 0 });
    expect(parsePatch('\n')).toEqual({ lines: [], added: 0, removed: 0 });
  });

  test('a preamble with no hunk yields no lines', () => {
    const patch = 'diff --git a/x b/x\nnew file mode 100644\nindex 000..111\n';
    expect(parsePatch(patch).lines).toEqual([]);
  });

  test('a binary notice survives, so the file does not look empty', () => {
    const patch = 'diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n';
    const { lines } = parsePatch(patch);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'meta' });
  });

  test('a no-newline marker is kept as meta and does not shift numbering', () => {
    const patch = '@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b\n';
    const { lines, added, removed } = parsePatch(patch);
    expect(added).toBe(1);
    expect(removed).toBe(1);
    expect(lines.map((l) => l.kind)).toEqual(['hunk', 'del', 'meta', 'add']);
    expect(lines[3]!.newLine).toBe(1);
  });

  test('a hunk header without counts is accepted', () => {
    const { lines } = parsePatch('@@ -7 +9 @@\n-a\n+b\n');
    expect(lines[1]!.oldLine).toBe(7);
    expect(lines[2]!.newLine).toBe(9);
  });

  test('a bare empty line inside a hunk is context', () => {
    const { lines } = parsePatch('@@ -1,3 +1,3 @@\n a\n\n b\n');
    expect(lines.slice(1).map((l) => l.kind)).toEqual(['context', 'context', 'context']);
    expect(lines[2]!.text).toBe('');
  });

  test('a file added whole is all additions', () => {
    const patch = 'diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1,2 @@\n+one\n+two\n';
    const { lines, added, removed } = parsePatch(patch);
    expect(added).toBe(2);
    expect(removed).toBe(0);
    expect(lines.filter((l) => l.kind === 'add').map((l) => l.newLine)).toEqual([1, 2]);
  });

  test('multiple hunks each restart numbering', () => {
    const { lines } = parsePatch('@@ -1,1 +1,1 @@\n a\n@@ -50,1 +60,1 @@\n b\n');
    const context = lines.filter((l) => l.kind === 'context');
    expect(context.map((l) => [l.oldLine, l.newLine])).toEqual([
      [1, 1],
      [50, 60],
    ]);
  });
});

describe('patchTotals', () => {
  test('sums across files', () => {
    expect(patchTotals([PATCH, '@@ -1,1 +1,2 @@\n a\n+b\n'])).toEqual({ added: 3, removed: 1 });
  });

  test('no patches is no change', () => {
    expect(patchTotals([])).toEqual({ added: 0, removed: 0 });
  });
});
