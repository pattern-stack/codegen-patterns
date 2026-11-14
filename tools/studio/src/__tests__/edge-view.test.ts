/**
 * The edge panel's view model (STUDIO-2 §5), over real `project surface --json`
 * payloads of the demo. A wrong answer here is a method credited to the wrong
 * side, groups out of order, or a junction half / unlisted relation that reads
 * as an empty list — "this relation generates nothing".
 */
import { describe, expect, test } from 'bun:test';
import type { ProjectApiSurface } from '@studio-shared';

import { edgeStyle } from '../graph/edge-kinds';
import { edgePanelView, relationChip } from '../inspector/edge-view';
import type { EdgePanelView } from '../inspector/edge-view';
import { EDGE_GROUPS, EDGE_PANEL_STATES } from '../inspector/surface-kinds';

import demo from './fixtures/demo-surface.json';

const DEMO = demo.surface as ProjectApiSurface;

function relationView(relationId: string): Extract<EdgePanelView, { state: 'relation' }> {
  const view = edgePanelView(DEMO, { relationId });
  if (view.state !== 'relation') throw new Error(`${relationId}: expected a relation view, got ${view.state}`);
  return view;
}

/** Each group as `heading: row signatures` — the panel as a reader scans it. */
function outline(view: Extract<EdgePanelView, { state: 'relation' }>): string[] {
  return view.groups.map((g) => `${g.heading}: ${g.rows.map((r) => r.signature).join(' | ') || `(${g.empty})`}`);
}

describe('edge panel — contact → account (belongs_to)', () => {
  const view = relationView('contact.relationships.account');

  test('groups in the table order: declaring side, other side, inverse, include keys', () => {
    // Order and words come from EDGE_GROUPS; this pins both.
    expect(view.groups.map((g) => g.id)).toEqual(['declaring', 'other', 'inverse', 'includes']);
    expect(outline(view)).toEqual([
      'on contact: findByAccountId(id, opts) → many | account(contactId) → one',
      `on account: (${EDGE_GROUPS.other.empty})`,
      'inverse: contacts(accountId, opts) → many',
      'Include keys: contacts.account | accounts.contacts',
    ]);
  });

  test("rows are the entity surface's own entries — kind label, origin, what they are", () => {
    const [finder, accessor] = view.groups[0]!.rows;
    expect(finder).toMatchObject({
      kindLabel: 'FK finder',
      calls: 'contact.repository.findByAccountId',
      origin: { text: '← relationships.account', edgeKind: 'belongs_to' },
    });
    expect(accessor).toMatchObject({ kindLabel: 'relation · one', calls: 'contact.service.account' });
  });

  test("the relation chip is the relation's id, in its edge kind, linked to its declaration", () => {
    expect(view.relation).toEqual({
      kind: 'yaml',
      text: 'contact.relationships.account',
      edgeKind: 'belongs_to',
      yaml: { doc: { kind: 'entity', name: 'contact' }, path: ['relationships', 'account'] },
    });
    expect(edgeStyle(view.relation.edgeKind!).kind).toBe('belongs_to');
  });

  test("the inverse group carries the inverse's chip, in the inverse's edge kind", () => {
    const inverse = view.groups.find((g) => g.id === 'inverse');
    expect(inverse?.chip).toMatchObject({ text: 'account.relationships.contacts', edgeKind: 'has_many' });
    expect(inverse?.rows.map((r) => r.calls)).toEqual(['account.service.contacts']);
  });
});

describe('edge panel — account → contacts (has_many)', () => {
  const view = relationView('account.relationships.contacts');

  test("the declaring side is account; the inverse is contact's belongs_to", () => {
    expect(outline(view)).toEqual([
      'on account: contacts(accountId, opts) → many',
      `on contact: (${EDGE_GROUPS.other.empty})`,
      'inverse: findByAccountId(id, opts) → many | account(contactId) → one',
      'Include keys: accounts.contacts | contacts.account',
    ]);
    expect(view.groups[0]!.rows[0]).toMatchObject({ kindLabel: 'relation · many' });
  });
});

describe('edge panel — never an empty list', () => {
  test('a junction half (no relationId) says it has no relation surface', () => {
    expect(edgePanelView(DEMO, {})).toEqual({ state: 'noRelation', ...EDGE_PANEL_STATES.noRelation });
  });

  test('a relation the surface does not list reads as undescribed', () => {
    const view = edgePanelView(DEMO, { relationId: 'contact.relationships.nowhere' });
    expect(view).toEqual({
      state: 'undescribed',
      relationId: 'contact.relationships.nowhere',
      title: `contact.relationships.nowhere ${EDGE_PANEL_STATES.undescribed.title}`,
      body: EDGE_PANEL_STATES.undescribed.body,
    });
  });

  test('a relation with no inverse says so in the inverse group', () => {
    const relation = DEMO.relations.find((r) => r.id === 'contact.relationships.account')!;
    const surface: ProjectApiSurface = {
      ...DEMO,
      relations: [{ ...relation, inverseOf: undefined }],
    };
    const view = edgePanelView(surface, { relationId: relation.id });
    if (view.state !== 'relation') throw new Error('expected a relation view');
    const inverse = view.groups.find((g) => g.id === 'inverse')!;
    expect(inverse.rows).toEqual([]);
    expect(inverse.empty).toBe(EDGE_GROUPS.inverse.empty);
  });

  test('a generated method its entity does not list is flagged, not dropped', () => {
    const relation = DEMO.relations.find((r) => r.id === 'contact.relationships.account')!;
    const surface: ProjectApiSurface = {
      ...DEMO,
      relations: [{ ...relation, generates: [{ entity: 'contact', layer: 'service', method: 'ghost' }] }],
    };
    const view = edgePanelView(surface, { relationId: relation.id });
    if (view.state !== 'relation') throw new Error('expected a relation view');
    expect(view.groups[0]!.rows.map((r) => [r.signature, r.flags])).toEqual([['ghost', ['not on the entity surface']]]);
  });
});

describe('relationChip', () => {
  test('every demo relation gets a linked chip in its own edge kind', () => {
    for (const relation of DEMO.relations) {
      const chip = relationChip(DEMO, relation);
      expect(chip.edgeKind).toBe(relation.kind);
      expect(chip.yaml?.doc).toEqual({ kind: 'entity', name: relation.from });
    }
  });
});
