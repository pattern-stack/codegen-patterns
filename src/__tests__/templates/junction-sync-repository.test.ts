/**
 * Template-emission tests for the junction sync surface (#374).
 *
 * Invokes templates/junction/new/prompt.js against fixtures (so the derivation
 * is under test, not hand-built locals), then renders repository.ejs.t and
 * asserts:
 *   - TSyncWrite / TSyncProjection (role + role-less)
 *   - JunctionSyncConfig literal with LIVE refTable handles, deduped imports
 *   - extends JunctionSyncRepository<E, EWrite, EProjection>
 *   - roleColumn emitted as 'role' / null (not HTML-escaped)
 *   - the two pairing finders are preserved
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import ejs from 'ejs';
// eslint-disable-next-line @typescript-eslint/no-var-requires
import promptModule from '../../../templates/junction/new/prompt.js';

const REPO_TEMPLATE = readFileSync(
  resolve(import.meta.dir, '../../../templates/junction/new/repository.ejs.t'),
  'utf8',
);

function extractBody(source: string): string {
  const lines = source.split('\n');
  if (lines[0] !== '---') return source;
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i] === '---') { end = i; break; }
  return end === -1 ? source : lines.slice(end + 1).join('\n');
}

/** Write a junction YAML to a temp file and run the real prompt.js against it. */
async function localsFromYaml(yaml: string): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(resolve(tmpdir(), 'junction-sync-'));
  const file = resolve(dir, 'junction.yaml');
  writeFileSync(file, yaml, 'utf8');
  return promptModule.prompt({ args: { yaml: file } }) as Promise<Record<string, unknown>>;
}

const render = (locals: Record<string, unknown>) =>
  ejs.render(extractBody(REPO_TEMPLATE), locals, { rmWhitespace: false });

// prompt.js reads `fields.role.choices` directly (the CLI normalizes YAML
// `values:` → `choices:` upstream; invoking prompt.js in isolation we supply
// `choices:` as the normalized shape).
const ROLE_YAML = `pattern: Junction
between: [opportunity, contact]
fields:
  role:
    type: enum
    choices: [champion, decision_maker, influencer]
    nullable: false
`;

const ROLELESS_YAML = `pattern: Junction
between: [opportunity, activity]
`;

describe('junction sync emission — role-bearing (opportunity_contact)', () => {
  it('derives the sync write/projection locals + parent imports', async () => {
    const locals = await localsFromYaml(ROLE_YAML);
    expect(locals.leftSyncWriteKey).toBe('opportunityExternalId');
    expect(locals.rightSyncWriteKey).toBe('contactExternalId');
    expect(locals.roleColumnCamel).toBe('role');
    expect((locals.junctionSyncConfig as any).leftRefTable).toBe('opportunities');
    expect((locals.junctionSyncConfig as any).rightRefTable).toBe('contacts');
    expect(locals.syncParentImports).toHaveLength(2);
  });

  it('emits TSyncWrite with both external ids + role union + userId', async () => {
    const out = render(await localsFromYaml(ROLE_YAML));
    expect(out).toContain('export interface OpportunityContactSyncWrite {');
    expect(out).toContain('readonly opportunityExternalId: string;');
    expect(out).toContain('readonly contactExternalId: string;');
    expect(out).toContain("readonly role: 'champion' | 'decision_maker' | 'influencer';");
    expect(out).toContain('readonly userId: string;');
  });

  it('emits TSyncProjection with composite id + local FKs + role + timestamps', async () => {
    const out = render(await localsFromYaml(ROLE_YAML));
    expect(out).toContain('export interface OpportunityContactSyncProjection {');
    expect(out).toContain('readonly id: string;');
    expect(out).toContain('readonly opportunityId: string;');
    expect(out).toContain('readonly contactId: string;');
    expect(out).toContain('readonly createdAt: Date;');
  });

  it('extends JunctionSyncRepository with the three params + live refTables', async () => {
    const out = render(await localsFromYaml(ROLE_YAML));
    expect(out).toContain('extends JunctionSyncRepository<');
    expect(out).toContain('OpportunityContactSyncWrite,');
    expect(out).toContain('OpportunityContactSyncProjection');
    expect(out).toContain("left: { column: 'opportunityId', refTable: opportunities }");
    expect(out).toContain("right: { column: 'contactId', refTable: contacts }");
    expect(out).toContain("roleColumn: 'role'");
    expect(out).not.toContain('&#39;');
  });

  it('imports the parent tables (deduped) and keeps both pairing finders', async () => {
    const out = render(await localsFromYaml(ROLE_YAML));
    expect(out).toContain("import { opportunities } from '../opportunities/opportunity.entity';");
    expect(out).toContain("import { contacts } from '../contacts/contact.entity';");
    expect(out).toContain('async findByOpportunityId(');
    expect(out).toContain('async findByContactId(');
    expect(out).toContain('syncUpsertOne, findByExternalIdProjected, softDeleteByExternalId');
  });
});

describe('junction sync emission — role-less (opportunity_activity)', () => {
  it('emits roleColumn: null and omits role from the interfaces', async () => {
    const locals = await localsFromYaml(ROLELESS_YAML);
    expect(locals.roleColumnCamel).toBeNull();
    const out = render(locals);
    expect(out).toContain('roleColumn: null');
    expect(out).not.toContain('readonly role:');
  });
});
