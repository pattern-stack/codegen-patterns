/**
 * Snapshot test: cross-domain junction (opportunity × activity, backend).
 *
 * Locks the emitted output of the junction codegen pipeline against drift.
 * The smoke harness covers compile + grep; this covers full-file shape.
 *
 * Regen flow when emission intentionally changes:
 *   bun test --update-snapshots test/junction/opportunity-activity.test.ts
 *
 * Then review the snapshot diff carefully — every line is load-bearing.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { bootstrapJunctionProject, type BootstrapResult } from './_helpers';

describe('junction emission snapshot — opportunity_activity (backend)', () => {
  let project: BootstrapResult;

  beforeAll(async () => {
    project = await bootstrapJunctionProject({
      scenario: 'junction-cross-domain',
    });
  }, 120_000);

  afterAll(() => {
    project?.cleanup();
  });

  test('emits opportunity-activity.entity.ts', () => {
    expect(project.emittedFile('src/modules/opportunity-activities/opportunity-activity.entity.ts'))
      .toMatchSnapshot();
  });

  test('emits opportunity-activity.repository.ts', () => {
    expect(project.emittedFile('src/modules/opportunity-activities/opportunity-activity.repository.ts'))
      .toMatchSnapshot();
  });

  test('emits opportunity-activity.service.ts', () => {
    expect(project.emittedFile('src/modules/opportunity-activities/opportunity-activity.service.ts'))
      .toMatchSnapshot();
  });

  test('emits opportunity.service.ts (left parent — junction accessor)', () => {
    expect(project.emittedFile('src/modules/opportunities/opportunity.service.ts'))
      .toMatchSnapshot();
  });

  test('emits activity.service.ts (right parent — junction accessor)', () => {
    expect(project.emittedFile('src/modules/activities/activity.service.ts'))
      .toMatchSnapshot();
  });
});
