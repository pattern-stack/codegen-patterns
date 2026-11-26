/**
 * A raw-SQL predicate (`unique_indexes[].where`, #784) as facts (TGT-1, ADR-047): checked once, then cut into the
 * text it copies and the columns it names. A target's renderer writes the segments in its own syntax — Drizzle's
 * `sql` template interpolates a column as `${<table>.<prop>}` so drizzle-kit quotes it
 * (`src/targets/drizzle/postgres/constraints.ts`).
 *
 * The rules (moved verbatim from `templates/_shared/sql-predicate.mjs`):
 * - the predicate is ONE SQL expression: `;`, `--`, `/*`, `$`, `` ` `` and `\` are refused outside a quoted string;
 * - an unquoted word that names a column of the table (case-insensitive) is a column, unless it follows `.` / `::`,
 *   or is followed by `(`, `.` or `'` (a function, a qualifier, a typed literal);
 * - everything else — quoted strings, numbers, operators, keywords — is copied as text.
 *
 * Errors throw a plain Error carrying the offset; the caller prefixes the entity and entry.
 *
 * Hygen-safe: reached from `entity-locals.js`; imports nothing.
 */

/** One piece of a predicate: text copied as written, or a reference to a column of the table. */
export type PredicateSegment = { readonly text: string } | { readonly column: string; readonly prop: string };

const REJECTED = [';', '--', '/*', '$', '`', '\\'];

/**
 * @param predicate the author's SQL expression
 * @param columns   lower-cased column name → TypeScript property name, for the table the predicate is over
 */
export function tokenizePredicate(predicate: string, columns: ReadonlyMap<string, string>): PredicateSegment[] {
	const src = String(predicate);
	const out: PredicateSegment[] = [];
	const text = (t: string) => {
		const last = out[out.length - 1];
		if (last && 'text' in last) out[out.length - 1] = { text: last.text + t };
		else out.push({ text: t });
	};
	let i = 0;
	// Last significant (non-blank) token, for the `.` / `::` exclusions.
	let prev = '';

	while (i < src.length) {
		const ch = src[i]!;

		if (ch === "'" || ch === '"') {
			let j = i + 1;
			for (;;) {
				if (j >= src.length) throw new Error(`unterminated ${ch} quote at offset ${i}`);
				if (src[j] === ch) {
					if (src[j + 1] === ch) {
						j += 2;
						continue;
					}
					break;
				}
				j++;
			}
			text(src.slice(i, j + 1));
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
			while (j < src.length && /[A-Za-z0-9_.]/.test(src[j]!)) j++;
			text(src.slice(i, j));
			i = j;
			prev = '0';
			continue;
		}

		if (/[A-Za-z_]/.test(ch)) {
			let j = i + 1;
			while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
			const word = src.slice(i, j);
			const prop = columns.get(word.toLowerCase());
			let k = j;
			while (k < src.length && /\s/.test(src[k]!)) k++;
			const next = src[k] ?? '';
			const excluded = prev === '.' || prev === '::' || next === '(' || next === '.' || next === "'";
			if (prop && !excluded) out.push({ column: word, prop });
			else text(word);
			i = j;
			prev = word;
			continue;
		}

		if (src.startsWith('::', i)) {
			text('::');
			i += 2;
			prev = '::';
			continue;
		}

		text(ch);
		i++;
		if (!/\s/.test(ch)) prev = ch;
	}
	return out;
}
