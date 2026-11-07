/**
 * Raw-SQL predicate renderer for `unique_indexes[].where` (#784).
 *
 * `renderSqlPredicate(predicate, columns)` returns the body of a
 * sql`...` template literal. Unquoted words that name a column of the table are
 * rewritten to `${t.<prop>}` so drizzle-kit quotes them; everything else is
 * copied verbatim. Dependency-free so other raw-SQL readers (CHECK
 * constraints, #786) can share the same rules.
 *
 * Errors throw a plain Error carrying the offset; the caller prefixes the
 * entity and entry.
 */

const REJECTED = [';', '--', '/*', '$', '`', '\\'];

/** Escape text for a JS template literal. */
function escapeTemplate(text) {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/**
 * @param {string} predicate
 * @param {Map<string, string>} columns  column name -> TS property name
 * @returns {string}
 */
export function renderSqlPredicate(predicate, columns) {
  const src = String(predicate);
  let out = '';
  let i = 0;
  // Last significant (non-blank) token, for the `.` / `::` exclusions.
  let prev = '';

  while (i < src.length) {
    const ch = src[i];

    if (ch === "'" || ch === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= src.length) {
          throw new Error(`unterminated ${ch} quote at offset ${i}`);
        }
        if (src[j] === ch) {
          if (src[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += escapeTemplate(src.slice(i, j + 1));
      i = j + 1;
      prev = ch;
      continue;
    }

    const rejected = REJECTED.find((r) => src.startsWith(r, i));
    if (rejected) {
      throw new Error(
        `'${rejected}' at offset ${i} is not allowed outside a quoted string. The predicate is one SQL expression.`,
      );
    }

    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j])) j++;
      out += src.slice(i, j);
      i = j;
      prev = '0';
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      const prop = columns.get(word.toLowerCase());
      let k = j;
      while (k < src.length && /\s/.test(src[k])) k++;
      const next = src[k] ?? '';
      const excluded =
        prev === '.' || prev === '::' || next === '(' || next === '.' || next === "'";
      out += prop && !excluded ? '${t.' + prop + '}' : word;
      i = j;
      prev = word;
      continue;
    }

    if (src.startsWith('::', i)) {
      out += '::';
      i += 2;
      prev = '::';
      continue;
    }

    out += ch;
    i++;
    if (!/\s/.test(ch)) prev = ch;
  }
  return out;
}
