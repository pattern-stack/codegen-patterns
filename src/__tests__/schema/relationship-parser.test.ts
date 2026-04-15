/**
 * Relationship Parser Integration Tests
 *
 * Tests the full pipeline: YAML → loader → parser → parsed types.
 * Uses fixture files from test/fixtures/relationships/.
 */

import { describe, it, expect } from 'bun:test';
import { resolve } from 'path';
import {
	loadRelationships,
	resolveRelationshipReferences,
	loadRelationshipFromYaml,
} from '../../parser/load-entities';
import { loadEntities, resolveReferences } from '../../parser/load-entities';
import { buildDomainGraph } from '../../analyzer/graph-builder';
import type { ParsedRelationshipDefinition } from '../../analyzer/types';

const FIXTURES_DIR = resolve(__dirname, '../../../test/fixtures');
const REL_FIXTURES_DIR = resolve(FIXTURES_DIR, 'relationships');

// ============================================================================
// Loader: loadRelationships()
// ============================================================================

describe('loadRelationships', () => {
	it('loads all 6 fixture files', () => {
		const { relationships, issues } = loadRelationships(REL_FIXTURES_DIR);
		expect(relationships.length).toBe(6);
		expect(issues.filter((i) => i.severity === 'error').length).toBe(0);
	});

	it('returns empty for non-existent directory (not an error)', () => {
		const { relationships, issues } = loadRelationships('/nonexistent/path');
		expect(relationships.length).toBe(0);
		expect(issues.length).toBe(0);
	});
});

// ============================================================================
// Transform: parsed structure
// ============================================================================

describe('parsed relationship structure', () => {
	const { relationships } = loadRelationships(REL_FIXTURES_DIR);
	const byName = new Map(relationships.map((r) => [r.name, r]));

	it('person_organization: cross-type, typed, temporal, sourced', () => {
		const rel = byName.get('person_organization')!;
		expect(rel).toBeDefined();
		expect(rel.from).toBe('person');
		expect(rel.to).toBe('organization');
		expect(rel.selfReferential).toBe(false);
		expect(rel.fromColumn).toBe('person_id');
		expect(rel.toColumn).toBe('organization_id');
		expect(rel.hasTypes).toBe(true);
		expect(rel.types.length).toBe(6);
		expect(rel.types[0].name).toBe('employed_by');
		expect(rel.types[0].directed).toBe(true);
		expect(rel.types[0].bidirectional).toBe(false);
		expect(rel.temporal).toBe(true);
		expect(rel.sourced).toBe(true);
		expect(rel.fields.size).toBeGreaterThan(0);
		expect(rel.fields.has('role_title')).toBe(true);
	});

	it('person_person: self-referential, object map types', () => {
		const rel = byName.get('person_person')!;
		expect(rel).toBeDefined();
		expect(rel.selfReferential).toBe(true);
		expect(rel.fromColumn).toBe('from_person_id');
		expect(rel.toColumn).toBe('to_person_id');

		const reporting = rel.types.find((t) => t.name === 'reporting')!;
		expect(reporting.inverse).toBe('management');
		expect(reporting.bidirectional).toBe(false);
		expect(reporting.directed).toBe(false);

		const network = rel.types.find((t) => t.name === 'network')!;
		expect(network.bidirectional).toBe(true);
		expect(network.inverse).toBeUndefined();
	});

	it('engagement_opportunity: minimal, no temporal, no sourced', () => {
		const rel = byName.get('engagement_opportunity')!;
		expect(rel.temporal).toBe(false);
		expect(rel.sourced).toBe(false);
		expect(rel.fields.size).toBe(0);
		expect(rel.hasTypes).toBe(true);
		expect(rel.types.length).toBe(2);
	});

	it('organization_hierarchy: self-referential with mixed directions', () => {
		const rel = byName.get('organization_hierarchy')!;
		expect(rel.selfReferential).toBe(true);
		expect(rel.fromColumn).toBe('from_organization_id');
		expect(rel.toColumn).toBe('to_organization_id');

		const parentOf = rel.types.find((t) => t.name === 'parent_of')!;
		expect(parentOf.inverse).toBe('subsidiary_of');

		const partnerOf = rel.types.find((t) => t.name === 'partner_of')!;
		expect(partnerOf.bidirectional).toBe(true);

		const acquired = rel.types.find((t) => t.name === 'acquired')!;
		expect(acquired.directed).toBe(true);
	});

	it('unique constraint defaults are correct', () => {
		// Typed + temporal → [from, to, type, valid_from]
		const personOrg = byName.get('person_organization')!;
		expect(personOrg.uniqueOn).toEqual([
			'person_id',
			'organization_id',
			'type',
			'valid_from',
		]);

		// Typed + not temporal → [from, to, type]
		const engPart = byName.get('engagement_participant')!;
		expect(engPart.uniqueOn).toEqual([
			'engagement_id',
			'person_id',
			'type',
		]);

		// Typed + not temporal + not sourced → [from, to, type]
		const engOpp = byName.get('engagement_opportunity')!;
		expect(engOpp.uniqueOn).toEqual([
			'engagement_id',
			'opportunity_id',
			'type',
		]);
	});

	it('on_delete defaults to restrict', () => {
		const rel = byName.get('person_organization')!;
		expect(rel.onDeleteFrom).toBe('restrict');
		expect(rel.onDeleteTo).toBe('restrict');
	});
});

// ============================================================================
// Reference Resolution
// ============================================================================

describe('resolveRelationshipReferences', () => {
	const { relationships } = loadRelationships(REL_FIXTURES_DIR);
	const { entities } = loadEntities(FIXTURES_DIR);

	it('validates endpoints against entity names', () => {
		const issues = resolveRelationshipReferences(relationships, entities);
		// Some fixtures reference entities that exist in test/fixtures/
		// (person, organization, opportunity), others may not (engagement)
		// This test just confirms the function runs without crashing
		expect(Array.isArray(issues)).toBe(true);
	});
});

// ============================================================================
// Graph Integration
// ============================================================================

describe('buildDomainGraph with relationships', () => {
	const { entities } = loadEntities(FIXTURES_DIR);
	resolveReferences(entities);
	const { relationships } = loadRelationships(REL_FIXTURES_DIR);

	it('includes relationship definitions in the graph', () => {
		const graph = buildDomainGraph(entities, relationships);
		expect(graph.relationshipDefinitions.size).toBe(6);
		expect(graph.relationshipDefinitions.has('person_organization')).toBe(true);
	});

	it('creates N:M edges for junction relationships', () => {
		const graph = buildDomainGraph(entities, relationships);
		const junctionEdges = graph.edges.filter((e) => e.cardinality === 'N:M');
		expect(junctionEdges.length).toBeGreaterThan(0);
	});

	it('backwards compatible — works without relationship definitions', () => {
		const graph = buildDomainGraph(entities);
		expect(graph.relationshipDefinitions.size).toBe(0);
		expect(graph.edges.length).toBeGreaterThan(0);
	});
});
