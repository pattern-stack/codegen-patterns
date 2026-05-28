/**
 * Recursive YAML discovery — the single source of truth for finding entity,
 * relationship, junction, and event definition files on disk.
 *
 * Domain-folder layouts are first-class: `entities/crm/account.yaml`,
 * `entities/billing/invoice.yaml`, and a flat `entities/account.yaml` are all
 * discovered identically. Every codegen discovery site routes through this
 * helper so the tree-walk behaviour stays consistent — there is no flat-vs-deep
 * split to keep in sync.
 *
 * `.yaml` and `.yml` are both matched. Dot-directories (`.git`, `.cache`, …)
 * are skipped so a stray VCS or tooling folder under the definitions root can
 * never be mistaken for a domain folder. Results are returned as absolute paths
 * sorted lexicographically for deterministic generation order.
 *
 * Throws if `dir` does not exist — matching `readdirSync` semantics so callers
 * can distinguish "directory missing" (catch → warn/skip) from "directory
 * present but empty" (empty array). Callers that treat a missing directory as
 * non-fatal should guard with `existsSync` or wrap in try/catch, exactly as
 * they did around the previous flat `readdirSync` calls.
 */

import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

function isYaml(name: string): boolean {
	return name.endsWith('.yaml') || name.endsWith('.yml');
}

/**
 * Recursively collect every `.yaml`/`.yml` file under `dir`.
 *
 * @param dir Directory to walk (relative paths are resolved against cwd).
 * @returns Absolute file paths, sorted lexicographically. Throws if `dir`
 *   does not exist.
 */
export function findYamlFiles(dir: string): string[] {
	const root = resolve(dir);
	const out: string[] = [];

	const walk = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (entry.name.startsWith('.')) continue;
				walk(join(current, entry.name));
			} else if (isYaml(entry.name)) {
				out.push(join(current, entry.name));
			}
		}
	};

	walk(root);
	return out.sort();
}
