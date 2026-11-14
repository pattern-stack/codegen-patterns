/**
 * RFC-0006 (#875, S6) — Studio draws a child's edge to its base, so the serialized
 * graph has to carry `inherits:`. A child names its base on the entity itself, not
 * in `relationships:`, so without this field the canvas has nothing to draw it from.
 */
import { describe, expect, it } from 'bun:test';

import { buildDomainGraph } from '../../analyzer/graph-builder';
import { serializeDomainGraph } from '../../analyzer/serialize-graph';
import { loadFamily } from '../parser/inheritance-family';

describe('serializeDomainGraph — inherits', () => {
	const graph = serializeDomainGraph(buildDomainGraph(loadFamily(), []));

	it('carries the base and the kind value on a child, long form and short', () => {
		expect(graph.entities.meeting?.inherits).toEqual({ base: 'communication', as: 'meeting' });
		expect(graph.entities.transcript_communication_part?.inherits).toEqual({ base: 'communication_part', as: 'meeting' });
	});

	it('omits the key on a base and on a plain entity', () => {
		expect('inherits' in (graph.entities.communication ?? {})).toBe(false);
		expect('inherits' in (graph.entities.party ?? {})).toBe(false);
	});
});
