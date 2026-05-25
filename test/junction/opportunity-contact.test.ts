/**
 * Snapshot test: intra-domain junction (opportunity × contact, clean-lite-ps).
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

describe('junction emission snapshot — opportunity_contact (clean-lite-ps)', () => {
  let project: BootstrapResult;

  beforeAll(async () => {
    project = await bootstrapJunctionProject({
      scenario: 'junction',
      architecture: 'clean-lite-ps',
    });
  }, 120_000);

  afterAll(() => {
    project?.cleanup();
  });

  test('emits opportunity_contact.entity.ts', () => {
    expect(project.emittedFile('src/modules/opportunity_contacts/opportunity_contact.entity.ts'))
      .toMatchSnapshot();
  });

  test('emits opportunity_contact.repository.ts', () => {
    expect(project.emittedFile('src/modules/opportunity_contacts/opportunity_contact.repository.ts'))
      .toMatchSnapshot();
  });

  test('emits opportunity_contact.service.ts', () => {
    expect(project.emittedFile('src/modules/opportunity_contacts/opportunity_contact.service.ts'))
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
