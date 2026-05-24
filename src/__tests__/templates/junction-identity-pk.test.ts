/**
 * Focused template test for junction identity uniqueness (role discriminator).
 *
 * The junction's true identity is the FK pair PLUS its role discriminator when
 * one is declared: the same (left, right) pair with two different roles is two
 * domain-distinct rows (e.g. a contact who is both `champion` AND
 * `decision_maker` on one opportunity). With a PK over only (leftId, rightId)
 * those rows collide at the DB level even though they are domain-distinct.
 *
 * This test renders templates/junction/new/entity.ejs.t directly with
 * controlled locals and asserts the emitted composite primary key:
 *   - role-bearing junction → PK includes `table.role`, role column is .notNull()
 *   - role-less junction    → PK is exactly (leftId, rightId), no role column
 *
 * The full-file snapshots in test/junction/ lock the surrounding shape; this
 * test isolates the identity-uniqueness contract so a regression names itself.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ejs from 'ejs';

const JUNCTION_ENTITY_TEMPLATE = readFileSync(
  resolve(import.meta.dir, '../../../templates/junction/new/entity.ejs.t'),
  'utf8',
);

/** Strip the Hygen front-matter so we render only the EJS body. */
function extractBody(source: string): string {
  const lines = source.split('\n');
  if (lines[0] !== '---') return source;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return source;
  return lines.slice(end + 1).join('\n');
}

/**
 * Minimal locals mirroring what templates/junction/new/prompt.js computes.
 * `hasRole` is derived from fields.role.choices in prompt.js; here we toggle it
 * directly to exercise both branches.
 */
function localsFor({ hasRole }: { hasRole: boolean }): Record<string, unknown> {
  const drizzleImports = [
    'boolean',
    'numeric',
    'pgTable',
    'primaryKey',
    'relations',
    'text',
    'timestamp',
    'uuid',
  ];
  if (hasRole) drizzleImports.push('pgEnum');
  drizzleImports.sort();

  return {
    name: 'opportunity_contact',
    tableName: 'opportunity_contacts',
    tableVarName: 'opportunityContacts',
    leftEntity: 'opportunity',
    rightEntity: 'contact',
    leftTable: 'opportunities',
    rightTable: 'contacts',
    leftColumn: 'opportunity_id',
    rightColumn: 'contact_id',
    leftColumnCamel: 'opportunityId',
    rightColumnCamel: 'contactId',
    onDeleteLeft: 'restrict',
    onDeleteRight: 'restrict',
    hasRole,
    roleEnumName: hasRole ? 'opportunityContactRoleEnum' : null,
    roleEnumValues: hasRole ? ['champion', 'decision_maker', 'influencer'] : [],
    temporal: true,
    sourced: true,
    hasCustomFields: false,
    processedCustomFields: [],
    drizzleImports,
    classNames: { entity: 'OpportunityContact' },
  };
}

function render(locals: Record<string, unknown>): string {
  return ejs.render(extractBody(JUNCTION_ENTITY_TEMPLATE), locals, { rmWhitespace: false });
}

describe('junction identity uniqueness — composite PK includes role discriminator', () => {
  it('role-bearing junction: PK is (leftId, rightId, role)', () => {
    const out = render(localsFor({ hasRole: true }));
    expect(out).toContain(
      'primaryKey({ columns: [table.opportunityId, table.contactId, table.role] })',
    );
    // The two-column PK must NOT be emitted for a role-bearing junction.
    expect(out).not.toContain('primaryKey({ columns: [table.opportunityId, table.contactId] })');
  });

  it('role-bearing junction: role column is NOT NULL (it is part of the PK)', () => {
    const out = render(localsFor({ hasRole: true }));
    expect(out).toContain("role: opportunityContactRoleEnum('role').notNull()");
  });

  it('role-less junction: PK stays (leftId, rightId), no role column', () => {
    const out = render(localsFor({ hasRole: false }));
    expect(out).toContain('primaryKey({ columns: [table.opportunityId, table.contactId] })');
    expect(out).not.toContain('table.role');
    expect(out).not.toContain("role:");
  });
});
