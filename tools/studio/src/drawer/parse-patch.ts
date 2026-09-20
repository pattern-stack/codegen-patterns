/**
 * Split a unified diff into the lines a viewer renders.
 *
 * `DiffFile.patch` is whatever `git diff` produced for one file, so it carries
 * the `diff --git` / `index` / `---` / `+++` preamble as well as hunks. The
 * viewer already shows the path and status in its own header, so the preamble
 * is dropped and only hunks survive — showing it twice wastes the reader's
 * attention on the part they did not ask about.
 *
 * Pure: no React, no DOM. Unit-tested in `../__tests__`.
 */

export type PatchLineKind = 'hunk' | 'add' | 'del' | 'context' | 'meta';

export interface PatchLine {
  kind: PatchLineKind;
  /** Line content with the leading marker removed (kept for `hunk`/`meta`). */
  text: string;
  /** 1-based line number in the pre-image, where the line has one. */
  oldLine?: number;
  /** 1-based line number in the post-image, where the line has one. */
  newLine?: number;
}

export interface ParsedPatch {
  lines: PatchLine[];
  added: number;
  removed: number;
}

/** `@@ -oldStart,oldCount +newStart,newCount @@ trailing` */
const HUNK = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const PREAMBLE = [
  'diff --git ',
  'index ',
  '--- ',
  '+++ ',
  'new file mode ',
  'deleted file mode ',
  'old mode ',
  'new mode ',
  'similarity index ',
  'rename from ',
  'rename to ',
];

export function parsePatch(patch: string): ParsedPatch {
  const lines: PatchLine[] = [];
  let added = 0;
  let removed = 0;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  // A trailing newline would otherwise render as a phantom blank context line.
  const source = patch.endsWith('\n') ? patch.slice(0, -1) : patch;
  if (source === '') return { lines, added, removed };

  for (const raw of source.split('\n')) {
    const hunk = HUNK.exec(raw);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      lines.push({ kind: 'hunk', text: raw });
      continue;
    }

    if (!inHunk) {
      // Everything before the first hunk is preamble; a binary-file notice is
      // the one part worth keeping, because otherwise the file looks empty.
      if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) {
        lines.push({ kind: 'meta', text: raw });
      } else if (!PREAMBLE.some((p) => raw.startsWith(p)) && raw !== '') {
        lines.push({ kind: 'meta', text: raw });
      }
      continue;
    }

    if (raw.startsWith('\\')) {
      // "\ No newline at end of file" — belongs to the previous line.
      lines.push({ kind: 'meta', text: raw });
      continue;
    }

    const marker = raw[0];
    const text = raw.slice(1);

    if (marker === '+') {
      added++;
      lines.push({ kind: 'add', text, newLine: newLine++ });
    } else if (marker === '-') {
      removed++;
      lines.push({ kind: 'del', text, oldLine: oldLine++ });
    } else {
      // A context line is ' ' + text; an empty line in the diff is a context
      // line whose space git elided, so treat both the same.
      lines.push({ kind: 'context', text, oldLine: oldLine++, newLine: newLine++ });
    }
  }

  return { lines, added, removed };
}

/** Total additions and deletions across a set of patches. */
export function patchTotals(patches: readonly string[]): { added: number; removed: number } {
  return patches.reduce(
    (acc, patch) => {
      const parsed = parsePatch(patch);
      return { added: acc.added + parsed.added, removed: acc.removed + parsed.removed };
    },
    { added: 0, removed: 0 },
  );
}
