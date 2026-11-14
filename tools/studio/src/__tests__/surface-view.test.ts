/**
 * The API tab's view model, over real `project surface --json` payloads of the
 * demo (`fixtures/README.md` says how each was made). A wrong answer here is a
 * row in the wrong section, a declaration credited to the wrong line, or an
 * absent answer that reads as "no API".
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Origin, ProjectApiSurface } from '@studio-shared';

import { ORIGIN_KINDS } from '../inspector/surface-kinds';
import type { OriginKind } from '../inspector/surface-kinds';
import { apiTabView, originChip } from '../inspector/surface-view';
import type { ApiTabView, SurfaceSection } from '../inspector/surface-view';
import { locatePath } from '../inspector/yaml-issues';

import demo from './fixtures/demo-surface.json';
import withRelationship from './fixtures/demo-surface-with-relationship.json';
import variants from './fixtures/demo-surface-api-variants.json';

const DEMO = demo.surface as ProjectApiSurface;
const WITH_RELATIONSHIP = withRelationship.surface as ProjectApiSurface;
const VARIANTS = variants.surface as ProjectApiSurface;

/** The demo YAML the fixtures were derived from — the same file Studio opens. */
const CONTACT_YAML = readFileSync(
  join(import.meta.dir, '../../../../src/studio/demo/entities/contact.yaml'),
  'utf8',
);

function entityView(surface: ProjectApiSurface, name: string): Extract<ApiTabView, { state: 'entity' }> {
  const view = apiTabView(surface, name);
  if (view.state !== 'entity') throw new Error(`${name}: expected an entity view, got ${view.state}`);
  return view;
}

function sectionOf(surface: ProjectApiSurface, entity: string, id: SurfaceSection['id']): SurfaceSection {
  const found = entityView(surface, entity).sections.find((s) => s.id === id);
  if (!found) throw new Error(`${entity}: no ${id} section`);
  return found;
}

function row(section: SurfaceSection, name: string) {
  const found = section.rows.find((r) => r.name === name);
  if (!found) throw new Error(`${section.id}: no row ${name}`);
  return found;
}

describe('sections', () => {
  test('in order: Repository, Service, Use cases, HTTP, Includes', () => {
    expect(entityView(DEMO, 'contact').sections.map((s) => s.label)).toEqual([
      'Repository',
      'Service',
      'Use cases',
      'HTTP',
      'Includes',
    ]);
  });

  test('repository rows follow the kind table; FK finder before the YAML finders', () => {
    const repo = sectionOf(DEMO, 'contact', 'repository');
    expect(repo.rows.map((r) => r.name)).toEqual([
      'findById',
      'findByIds',
      'list',
      'count',
      'findByAccountId',
      'findByEmail',
    ]);
    expect(repo.rows.map((r) => r.kindLabel)).toEqual(['by id', 'by ids', 'list', 'count', 'FK finder', 'finder']);
  });

  test('service rows follow the kind table', () => {
    const svc = sectionOf(DEMO, 'contact', 'service');
    expect(svc.rows.map((r) => `${r.kindLabel}:${r.name}`)).toEqual([
      'read:findById',
      'read:findByIds',
      'read:list',
      'finder:findByAccountId',
      'finder:findByEmail',
      'relation · one:account',
    ]);
  });

  test('use cases follow the kind table', () => {
    const uc = sectionOf(DEMO, 'contact', 'useCases');
    expect(uc.rows.map((r) => `${r.kindLabel}:${r.name}`)).toEqual([
      'find by id:FindContactByIdUseCase',
      'list:ListContactsUseCase',
      'create:CreateContactUseCase',
      'update:UpdateContactUseCase',
      'delete:DeleteContactUseCase',
      'query:FindContactByAccountIdUseCase',
      'query:FindContactByEmailUseCase',
    ]);
    expect(row(uc, 'FindContactByAccountIdUseCase').calls).toBe('contact.service.findByAccountId');
  });
});

describe('inherited', () => {
  test('emitted: false entries are grouped apart, never mixed into the rows', () => {
    const repo = sectionOf(DEMO, 'contact', 'repository');
    const inheritedNames = DEMO.entities.contact!.repository.methods.filter((m) => !m.emitted).map((m) => m.name);

    expect(inheritedNames.length).toBeGreaterThan(0);
    expect(repo.rows.some((r) => inheritedNames.includes(r.name))).toBe(false);
    expect(repo.inherited.map((g) => g.origin.text)).toEqual(['pattern Integrated']);
    expect(repo.inherited[0]!.rows.map((r) => r.name)).toEqual(inheritedNames);
  });

  test('a service method the pattern supplies is inherited, not a row', () => {
    const svc = sectionOf(DEMO, 'contact', 'service');
    expect(svc.rows.map((r) => r.name)).not.toContain('count');
    expect(svc.inherited.flatMap((g) => g.rows.map((r) => r.name))).toContain('count');
  });
});

describe('row anatomy', () => {
  test('findByAccountId: signature, kind, flags', () => {
    const r = row(sectionOf(DEMO, 'contact', 'repository'), 'findByAccountId');
    expect(r.signature).toBe('findByAccountId(id, opts) → many');
    expect(r.flags).toEqual(['limit', 'columns + with']);
  });

  test('findByEmail: unique, credited to queries[1]', () => {
    const r = row(sectionOf(DEMO, 'contact', 'repository'), 'findByEmail');
    expect(r.signature).toBe('findByEmail(email, opts) → one');
    expect(r.flags).toEqual(['unique', 'columns + with']);
    expect(r.origin?.text).toBe('← queries[1]');
    expect(r.origin?.yaml?.path).toEqual(['queries', 1]);
  });

  test('count takes no read options flag', () => {
    expect(row(sectionOf(DEMO, 'contact', 'repository'), 'count').flags).toEqual([]);
  });

  test('a service row with delegatesTo shows what it calls', () => {
    const svc = sectionOf(DEMO, 'contact', 'service');
    expect(row(svc, 'account').calls).toBe('account.repository.findById');
    expect(row(svc, 'findByAccountId').calls).toBe('contact.repository.findByAccountId');
    expect(row(sectionOf(DEMO, 'account', 'service'), 'contacts').calls).toBe('contact.repository.findByAccountId');
  });
});

describe('shadowing', () => {
  test('findByAccountId wins from relationships.account and shows queries[0] under it', () => {
    const r = row(sectionOf(DEMO, 'contact', 'repository'), 'findByAccountId');
    expect(r.origin?.text).toBe('← relationships.account');
    expect(r.origin?.yaml).toEqual({ doc: { kind: 'entity', name: 'contact' }, path: ['relationships', 'account'] });
    expect(r.shadows.map((s) => s.text)).toEqual(['← queries[0]']);
    expect(r.shadows[0]!.yaml).toEqual({ doc: { kind: 'entity', name: 'contact' }, path: ['queries', 0] });
  });

  test('a row that won uncontested has no shadows', () => {
    expect(row(sectionOf(DEMO, 'contact', 'repository'), 'findByEmail').shadows).toEqual([]);
  });
});

describe('origin chips', () => {
  const chip = (origin: Origin) => originChip(DEMO, origin);

  // The demo has no capability or junction origin; these two are typed Origin
  // values passed to the chip function, not a hand-written surface.
  const examples: Record<OriginKind, { origin: Origin; text: string; links: boolean }> = {
    base: { origin: { from: 'base' }, text: 'base', links: false },
    pattern: { origin: { from: 'pattern', pattern: 'Integrated' }, text: 'pattern Integrated', links: false },
    capability: { origin: { from: 'capability', capability: 'Actor' }, text: 'capability Actor', links: false },
    yaml: {
      origin: { from: 'yaml', at: { doc: { kind: 'entity', name: 'contact' }, path: ['relationships', 'account'] } },
      text: '← relationships.account',
      links: true,
    },
    junction: {
      origin: { from: 'yaml', at: { doc: { kind: 'junction', name: 'opportunity_contact' }, path: ['entity'] } },
      text: 'junction opportunity_contact',
      links: true,
    },
  };

  test('every origin kind in the table has a chip, with its text', () => {
    expect(Object.keys(examples).sort()).toEqual(Object.keys(ORIGIN_KINDS).sort());
    for (const [kind, ex] of Object.entries(examples)) {
      const c = chip(ex.origin);
      expect({ kind: c.kind, text: c.text, links: c.yaml != null }).toEqual({ kind: kind as OriginKind, text: ex.text, links: ex.links });
    }
  });

  test('the chips the demo actually carries', () => {
    const repo = sectionOf(DEMO, 'contact', 'repository');
    expect(row(repo, 'findById').origin?.text).toBe('base');
    expect(repo.inherited[0]!.origin.text).toBe('pattern Integrated');
  });

  test('a YAML note follows the path', () => {
    const c = chip({ from: 'yaml', at: { doc: { kind: 'entity', name: 'contact' }, path: ['queries', 1], note: 'unique' } });
    expect(c.text).toBe('← queries[1] (unique)');
  });

  test('a relation origin borrows its REL-1 edge kind; others are neutral', () => {
    expect(row(sectionOf(DEMO, 'contact', 'repository'), 'findByAccountId').origin?.edgeKind).toBe('belongs_to');
    expect(row(sectionOf(DEMO, 'account', 'service'), 'contacts').origin?.edgeKind).toBe('has_many');
    expect(row(sectionOf(DEMO, 'contact', 'repository'), 'findByEmail').origin?.edgeKind).toBeUndefined();
    expect(chip(examples.junction.origin).edgeKind).toBe('junction');
    expect(chip({ from: 'base' }).edgeKind).toBeUndefined();
  });
});

describe('HTTP', () => {
  test('contact routes, each with its handler and use case', () => {
    const http = sectionOf(DEMO, 'contact', 'http');
    expect(http.off).toBeUndefined();
    expect(http.rows.map((r) => r.name)).toEqual([
      'GET /contacts',
      'GET /contacts/:id',
      'POST /contacts',
      'PATCH /contacts/:id',
      'DELETE /contacts/:id',
    ]);
    expect(row(http, 'GET /contacts').calls).toBe('ContactController.getAll → ListContactsUseCase');
    expect(row(http, 'GET /contacts').flags).toEqual(['operationId listContacts']);
  });

  test('api: false reads as HTTP off, credited to the declaration', () => {
    const http = sectionOf(VARIANTS, 'opportunity', 'http');
    expect(http.rows).toEqual([]);
    expect(http.off?.text).toBe('HTTP off — no controller is generated');
    expect(http.off?.origin?.text).toBe('← api');
    expect(http.off?.origin?.yaml).toEqual({ doc: { kind: 'entity', name: 'opportunity' }, path: ['api'] });
  });

  test('a route that resolves ?include= says against which allowlist', () => {
    const http = sectionOf(VARIANTS, 'account', 'http');
    expect(row(http, 'GET /accounts/:id').flags).toEqual(['operationId findAccountById', '?include= find_by_id']);
  });
});

describe('includes', () => {
  test('no api.includes: empty, and says the route is closed', () => {
    const inc = sectionOf(DEMO, 'contact', 'includes');
    expect(inc.rows).toEqual([]);
    expect(inc.empty).toBe('No `api.includes` declared — `?include=` is closed.');
  });

  test('the compiled allowlist, one row per path', () => {
    const inc = sectionOf(VARIANTS, 'account', 'includes');
    expect(inc.rows.map((r) => ({ name: r.name, signature: r.signature, flags: r.flags, calls: r.calls }))).toEqual([
      { name: 'contacts', signature: 'find_by_id · contacts', flags: ['depth 1', 'max 1'], calls: 'ACCOUNTS_API_INCLUDES' },
    ]);
  });
});

describe('nodes without an entity surface', () => {
  test('a relationship node shows its unmodelled reason, not an empty tab', () => {
    const view = apiTabView(WITH_RELATIONSHIP, 'contact_opportunity');
    const reason = WITH_RELATIONSHIP.unmodelled.find((u) => u.name === 'contact_opportunity')!.reason;
    expect(view).toEqual({
      state: 'unmodelled',
      name: 'contact_opportunity',
      kindLabel: 'relationship',
      headline: 'not modelled yet (#679)',
      reason,
    });
  });

  test('a node the surface does not know is undescribed, never an empty entity', () => {
    expect(apiTabView(DEMO, 'contact_opportunity')).toEqual({ state: 'undescribed', name: 'contact_opportunity' });
  });
});

describe('locatePath — provenance → YAML line, on the real demo YAML', () => {
  test('relationships.account lands on `  account:` under relationships', () => {
    const at = row(sectionOf(DEMO, 'contact', 'repository'), 'findByAccountId').origin!.yaml!.path;
    const loc = locatePath(CONTACT_YAML, at)!;
    expect(loc.exact).toBe(true);
    expect(CONTACT_YAML.split('\n')[loc.line - 1]).toBe('  account:');
    expect(CONTACT_YAML.split('\n')[loc.line - 2]).toBe('relationships:');
  });

  test('queries.0 (the shadow) lands on `  - by: [account_id]`', () => {
    const at = row(sectionOf(DEMO, 'contact', 'repository'), 'findByAccountId').shadows[0]!.yaml!.path;
    const loc = locatePath(CONTACT_YAML, at)!;
    expect(loc.exact).toBe(true);
    expect(CONTACT_YAML.split('\n')[loc.line - 1]).toBe('  - by: [account_id]');
  });

  test('queries.1 lands on `  - by: [email]`', () => {
    const loc = locatePath(CONTACT_YAML, ['queries', 1])!;
    expect(CONTACT_YAML.split('\n')[loc.line - 1]).toBe('  - by: [email]');
  });

  test('a path edited away resolves to its nearest ancestor, flagged inexact', () => {
    const loc = locatePath(CONTACT_YAML, ['relationships', 'owner'])!;
    expect(loc.exact).toBe(false);
    expect(CONTACT_YAML.split('\n')[loc.line - 1]).toBe('relationships:');
  });

  test('nothing to point at is undefined, not line 1', () => {
    expect(locatePath(CONTACT_YAML, ['nowhere'])).toBeUndefined();
    expect(locatePath(CONTACT_YAML, [])).toBeUndefined();
    expect(locatePath('', ['entity'])).toBeUndefined();
  });
});
