/**
 * Frontend emitter — providers catalog: `providers.ts` (ADR-038 follow-on).
 *
 * Providers are first-class definitions (`definitions/providers/<slug>.yaml`,
 * RFC-0001) and gen-time knowledge — the provider set changes only when code
 * deploys — so the frontend catalog is EMITTED, not queried. This module
 * renders the catalog the Connections-style surfaces consume:
 *
 *   - `PROVIDERS` — every provider, flat (active + planned), slug-sorted.
 *   - `PROVIDER_CATALOG` — grouped by `display.category` (provider YAML) into
 *     the ordered `frontend.catalog.categories` from `codegen.config.yaml`.
 *
 * `status: planned` providers are roadmap stubs: they render as unconnectable
 * tiles here and are skipped by all backend emission. Providers with no (or an
 * unknown) `display.category` appear in `PROVIDERS` but in no catalog group.
 *
 * Whole-set, deterministic, complete-file write — same contract as every
 * sibling emitter. Skips cleanly (emits nothing) when the project has no
 * provider definitions, so entity-only consumers see no new file.
 */

import { join } from 'node:path';
import type { FrontendEmitContext, ProviderCatalogInput } from './types';
import { withBanner, writeFile } from './emit-utils';

const SOURCE_DESC = 'definitions/providers';

/** Render a vendor literal (one provider) for the emitted arrays. */
function vendorLiteral(p: ProviderCatalogInput, indent: string): string {
	const lines = [
		`${indent}{`,
		`${indent}\tprovider: '${p.slug}',`,
		`${indent}\tname: '${(p.displayName ?? p.slug).replace(/'/g, "\\'")}',`,
		`${indent}\tplanned: ${p.status === 'planned'},`,
		`${indent}\tsurfaces: [${p.surfaces.map((s) => `'${s}'`).join(', ')}],`,
	];
	if (p.display?.blurb) {
		lines.push(`${indent}\tblurb: '${p.display.blurb.replace(/'/g, "\\'")}',`);
	}
	if (p.display?.hint) {
		lines.push(`${indent}\thint: '${p.display.hint.replace(/'/g, "\\'")}',`);
	}
	lines.push(`${indent}},`);
	return lines.join('\n');
}

/** Slug-sorted copy (deterministic emission order). */
function sortProviders(providers: ProviderCatalogInput[]): ProviderCatalogInput[] {
	return [...providers].sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * `providers.ts` — the providers catalog. Categories render in config order;
 * vendors within a category (and the flat list) render slug-sorted.
 */
export function buildProvidersFile(ctx: FrontendEmitContext): string {
	const providers = sortProviders(ctx.providers ?? []);
	const categories = ctx.config.catalogCategories;

	const flat = providers.map((p) => vendorLiteral(p, '\t')).join('\n');

	const groups = categories
		.map((cat) => {
			const vendors = providers.filter((p) => p.display?.category === cat.id);
			const vendorBlock = vendors.map((p) => vendorLiteral(p, '\t\t\t')).join('\n');
			return [
				'\t{',
				`\t\tid: '${cat.id}',`,
				`\t\tname: '${cat.name.replace(/'/g, "\\'")}',`,
				`\t\tblurb: '${cat.blurb.replace(/'/g, "\\'")}',`,
				vendors.length > 0 ? `\t\tvendors: [\n${vendorBlock}\n\t\t],` : '\t\tvendors: [],',
				'\t},',
			].join('\n');
		})
		.join('\n');

	const body = `/**
 * Providers catalog — emitted from \`definitions/providers/*.yaml\` (slug,
 * display_name, surfaces, status, display) + \`frontend.catalog.categories\`
 * (codegen.config.yaml). Provider truth lives in the definitions; this file
 * is a projection — never hand-edit, never hand-duplicate.
 *
 * \`planned: true\` vendors are roadmap stubs (no backend integration yet) —
 * render them as unconnectable tiles. Join live rows on \`provider\` (the
 * canonical slug, e.g. \`Connection.provider\`).
 */

export type ProviderStatus = 'active' | 'planned';

export interface CatalogVendor {
	/** Provider slug — joins to \`Connection.provider\` / STRATEGY_REGISTRY keys. */
	provider: string;
	name: string;
	/** True for roadmap stubs (\`status: planned\`) — no backend integration yet. */
	planned: boolean;
	/** Surfaces this provider serves (ADR-0006). */
	surfaces: string[];
	blurb?: string;
	/** Sub-line shown on an unconnected ("available") tile. */
	hint?: string;
}

export interface CatalogCategory {
	id: string;
	name: string;
	blurb: string;
	vendors: CatalogVendor[];
}

/** Every provider definition, flat (active + planned), slug-sorted. */
export const PROVIDERS: CatalogVendor[] = [
${flat}
];

/**
 * Category-grouped catalog (\`frontend.catalog.categories\` order). Providers
 * join a group via \`display.category\`; uncategorized providers appear only
 * in \`PROVIDERS\`.
 */
export const PROVIDER_CATALOG: CatalogCategory[] = [
${groups}
];
`;
	return withBanner(SOURCE_DESC, body);
}

/**
 * Emit `providers.ts` into `outDir`. Returns the written path, or `[]` when
 * the project has no provider definitions (entity-only consumers emit no
 * catalog and the root barrel omits the export).
 */
export function emitProviders(ctx: FrontendEmitContext, outDir: string): string[] {
	if (!ctx.providers || ctx.providers.length === 0) return [];
	const path = join(outDir, 'providers.ts');
	writeFile(path, buildProvidersFile(ctx));
	return [path];
}
