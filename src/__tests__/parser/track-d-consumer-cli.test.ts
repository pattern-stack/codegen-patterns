/**
 * Track D consumer-CLI regression tests (0.12.2).
 *
 * Mirrors the swe-brain consumer layout that broke under 0.12.0/0.12.1, at the
 * loader level the D7 hermetic test bypassed:
 *
 *   1. `surface:` / `context:` live INSIDE the `entity:` block (next to
 *      `pattern:`/`name:`/`table:`), which is where consumers naturally write
 *      them. The `entity:` block is `.strict()`, so before the fix these keys
 *      were rejected ("Unrecognized key(s) in object: 'surface' at 'entity'").
 *      Root-level placement is a clean break — it no longer validates.
 *
 *   2. With `entities_dir: definitions`, the recursive YAML walk used to pull in
 *      `definitions/providers/*.yaml` and run them through the ENTITY loader,
 *      where they fail validation. Entity discovery must exclude the providers
 *      subtree; provider files route ONLY through ProviderDefinitionSchema.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findYamlFiles } from '../../utils/find-yaml-files';
import { loadEntities } from '../../parser/load-entities';
import { loadEntityFromYaml, loadProviderFromYaml } from '../../utils/yaml-loader';

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'track-d-cli-'));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
	const full = join(dir, rel);
	mkdirSync(join(full, '..'), { recursive: true });
	writeFileSync(full, content);
	return resolve(full);
}

// A swe-brain-shaped entity: `surface:`/`context:` inside the `entity:` block.
const ENTITY_WITH_SURFACE = `entity:
  name: transcript
  plural: transcripts
  table: transcripts
  surface: transcript
  context: integration
fields:
  title:
    type: string
    required: true
`;

const PROVIDER_YAML = `slug: google
display_name: Google
auth:
  type: oauth2
  strategy: '@app/integrations/providers/google/google-oauth.strategy#GoogleOAuthStrategy'
  scopes:
    - https://www.googleapis.com/auth/gmail.readonly
client:
  class: '@app/integrations/providers/google/google.client#GoogleClient'
  base_url: https://www.googleapis.com
surfaces: [transcript]
`;

describe('Track D · entity.surface / entity.context (0.12.2)', () => {
	it('validates an entity with surface: + context: inside the entity: block', () => {
		const file = write('definitions/transcript.yaml', ENTITY_WITH_SURFACE);
		const result = loadEntityFromYaml(file);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.definition.entity.surface).toBe('transcript');
			expect(result.definition.entity.context).toBe('integration');
		}
	});

	it('rejects root-level surface:/context: with an actionable Zod detail', () => {
		const file = write(
			'definitions/bad.yaml',
			`entity:
  name: transcript
  plural: transcripts
  table: transcripts
surface: transcript
fields:
  title:
    type: string
    required: true
`,
		);
		const result = loadEntityFromYaml(file);
		expect(result.success).toBe(false);
		if (!result.success) {
			// The DX miss: `entity new` now surfaces this detail too, not just the
			// short "Validation failed" line.
			expect(result.details && result.details.length > 0).toBe(true);
		}
	});
});

describe('Track D · entity discovery excludes the providers subtree (0.12.2)', () => {
	it('findYamlFiles({ excludeDirs }) omits definitions/providers/*.yaml', () => {
		write('definitions/transcript.yaml', ENTITY_WITH_SURFACE);
		write('definitions/providers/google.yaml', PROVIDER_YAML);

		const entitiesDir = join(dir, 'definitions');
		const providersDir = join(dir, 'definitions', 'providers');

		const all = findYamlFiles(entitiesDir);
		expect(all.some((f) => f.includes('/providers/'))).toBe(true);

		const entityOnly = findYamlFiles(entitiesDir, {
			excludeDirs: [providersDir],
		});
		expect(entityOnly.some((f) => f.includes('/providers/'))).toBe(false);
		expect(entityOnly).toHaveLength(1);
	});

	it('loadEntities({ excludeDirs }) does NOT validate provider files as entities', () => {
		write('definitions/transcript.yaml', ENTITY_WITH_SURFACE);
		write('definitions/providers/google.yaml', PROVIDER_YAML);

		const entitiesDir = join(dir, 'definitions');
		const providersDir = join(dir, 'definitions', 'providers');

		// Without exclusion the provider file is loaded as an entity and fails.
		const naive = loadEntities(entitiesDir);
		expect(naive.issues.some((i) => i.severity === 'error')).toBe(true);

		// With exclusion the load is clean: only the real entity is parsed.
		const scoped = loadEntities(entitiesDir, { excludeDirs: [providersDir] });
		expect(scoped.issues.some((i) => i.severity === 'error')).toBe(false);
		expect(scoped.entities).toHaveLength(1);
		expect(scoped.entities[0]!.name).toBe('transcript');
	});

	it('provider YAML routes cleanly through ProviderDefinitionSchema', () => {
		const file = write('definitions/providers/google.yaml', PROVIDER_YAML);

		// It is NOT a valid entity...
		expect(loadEntityFromYaml(file).success).toBe(false);
		// ...but IS a valid provider.
		const provider = loadProviderFromYaml(file);
		expect(provider.success).toBe(true);
		if (provider.success) {
			expect(provider.definition.slug).toBe('google');
			expect(provider.definition.surfaces).toContain('transcript');
		}
	});
});
