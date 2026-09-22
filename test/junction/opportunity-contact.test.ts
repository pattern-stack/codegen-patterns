/**
 * Snapshot test: intra-domain junction (opportunity × contact, backend).
 *
 * Locks the emitted output of the junction codegen pipeline against drift.
 * The smoke harness covers compile + grep; this covers full-file shape.
 *
 * Regen flow when emission intentionally changes:
 *   bun test --update-snapshots test/junction/opportunity-contact.test.ts
 *
 * Then review the snapshot diff carefully — every line is load-bearing.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { bootstrapJunctionProject, type BootstrapResult } from './_helpers';

describe('junction emission snapshot — opportunity_contact (backend)', () => {
  let project: BootstrapResult;

  beforeAll(async () => {
    project = await bootstrapJunctionProject({
      scenario: 'junction',
    });
  }, 120_000);

  afterAll(() => {
    project?.cleanup();
  });

  test('emits opportunity-contact.entity.ts', () => {
    expect(project.emittedFile('src/modules/opportunity-contacts/opportunity-contact.entity.ts'))
      .toMatchSnapshot();
  });

  test('emits opportunity-contact.repository.ts', () => {
    expect(project.emittedFile('src/modules/opportunity-contacts/opportunity-contact.repository.ts'))
      .toMatchSnapshot();
  });

  test('emits opportunity-contact.service.ts', () => {
    expect(project.emittedFile('src/modules/opportunity-contacts/opportunity-contact.service.ts'))
      .toMatchSnapshot();
  });

  test('emits opportunity.service.ts (left parent — junction accessor)', () => {
    expect(project.emittedFile('src/modules/opportunities/opportunity.service.ts'))
      .toMatchSnapshot();
  });

  test('emits contact.service.ts (right parent — junction accessor)', () => {
    expect(project.emittedFile('src/modules/contacts/contact.service.ts'))
      .toMatchSnapshot();
  });
});
