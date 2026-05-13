/**
 * Snapshot test: cross-domain junction (opportunity × activity, clean-lite-ps).
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

describe('junction emission snapshot — opportunity_activity (clean-lite-ps)', () => {
  let project: BootstrapResult;

  beforeAll(async () => {
    project = await bootstrapJunctionProject({
      scenario: 'junction-cross-domain',
      architecture: 'clean-lite-ps',
    });
  }, 120_000);

  afterAll(() => {
    project?.cleanup();
  });

  test('emits opportunity_activity.entity.ts', () => {
    expect(project.emittedFile('src/modules/opportunity_activities/opportunity_activity.entity.ts'))
      .toMatchSnapshot();
  });

  test('emits opportunity_activity.repository.ts', () => {
    expect(project.emittedFile('src/modules/opportunity_activities/opportunity_activity.repository.ts'))
      .toMatchSnapshot();
  });

  test('emits opportunity_activity.service.ts', () => {
    expect(project.emittedFile('src/modules/opportunity_activities/opportunity_activity.service.ts'))
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
