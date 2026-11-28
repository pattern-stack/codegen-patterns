/**
 * The relative TypeScript import specifier from one file to another: `./x/y` or `../x`, without `.ts`. POSIX
 * separators on every platform, since an import specifier is never a Windows path. One rule for every emitter that
 * prints an import between generated files (the barrels, the pattern-stack composition).
 */
import path from 'node:path';

export function relativeImport(fromFile: string, toFile: string): string {
	const posix = (p: string) => p.split(path.sep).join(path.posix.sep);
	const rel = path.posix.relative(path.posix.dirname(posix(fromFile)), posix(toFile)).replace(/\.ts$/, '');
	return rel.startsWith('.') ? rel : `./${rel}`;
}
