/**
 * The workspace commands (ID-1b): each input checked by its schema before the service sees it, and each thing the
 * service refuses coming back as a refusal (never a throw), with the reason and the Nest body. The smoke's Postgres
 * leg runs them through `<generated>/commands.ts` against a real database.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import yaml from 'yaml';

import {
  WORKSPACE_FIELD_MAX,
  membershipAddCommand,
  membershipChangeRoleCommand,
  membershipRemoveCommand,
  WORKSPACE_COMMANDS,
  workspaceCreateCommand,
  workspaceListMineCommand,
  type WorkspaceCommandApis,
} from '../../../../../runtime/subsystems/identity/core';
import { withRequester } from '../../../../../runtime/base-classes/tenant-context';
import { invokeCommand } from '../../../../../runtime/commands';
import type { Command } from '@pattern-stack/wiring/commands';

import { A, B, W, fakeWorkspaces } from './fake-workspaces';

const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** Any workspace command, its input and result loosely typed (as `<generated>/commands.ts` holds them). */
type AnyCommand = Command<WorkspaceCommandApis>;

/** A fake workspaces module with A owning W; `as(who, role)` runs a command as that member of W. */
const setup = async () => {
  const t = fakeWorkspaces();
  const apis = { service: t.service };
  await withRequester({ userId: A }, () => invokeCommand(workspaceCreateCommand, apis, { name: 'Acme', slug: 'acme' }, {}));
  const as = (userId: string, role: string) => (command: AnyCommand, raw: unknown) =>
    withRequester({ userId, tenantId: W, role }, () => invokeCommand(command, apis, raw, {}));
  return { ...t, apis, as };
};

describe('the workspace commands', () => {
  it('five, each named, with an effect a caller can trust', () => {
    expect(WORKSPACE_COMMANDS.map((c) => [c.name, c.effect])).toEqual([
      ['workspace create', 'side-effect'],
      ['workspace list-mine', 'read'],
      ['membership add', 'side-effect'],
      ['membership change-role', 'idempotent'],
      ['membership remove', 'side-effect'],
    ]);
  });

  it('create, list, add, change and remove, through invokeCommand', async () => {
    const t = await setup();
    expect(await withRequester({ userId: A }, () => invokeCommand(workspaceListMineCommand, t.apis, {}, {}))).toEqual({
      ok: true,
      result: [{ workspace: { id: W, name: 'Acme', slug: 'acme' }, role: 'owner' }],
    });
    const added = await t.as(A, 'owner')(membershipAddCommand, { userId: B, role: 'member' });
    expect(added).toMatchObject({ ok: true, result: { workspaceId: W, userId: B, role: 'member' } });
    expect(await t.as(A, 'owner')(membershipChangeRoleCommand, { userId: B, role: 'admin' })).toMatchObject({
      ok: true,
      result: { userId: B, role: 'admin' },
    });
    expect(await t.as(A, 'owner')(membershipRemoveCommand, { userId: B })).toEqual({ ok: true, result: undefined });
    expect(t.memberships.map((m) => m.userId)).toEqual([A]);
  });

  it("an input its schema refuses never reaches the service: it's invalid-input, naming the field", async () => {
    const t = await setup();
    const cases: Array<[AnyCommand, unknown, string]> = [
      [workspaceCreateCommand, { name: '', slug: 'x' }, 'name'],
      [workspaceCreateCommand, { name: 'x', slug: 's'.repeat(WORKSPACE_FIELD_MAX.slug + 1) }, 'slug'],
      [membershipAddCommand, { userId: 'not-a-uuid', role: 'member' }, 'userId'],
      [membershipAddCommand, { userId: B, role: 'boss' }, 'role'],
      [membershipChangeRoleCommand, { userId: B }, 'role'],
      [membershipRemoveCommand, {}, 'userId'],
    ];
    for (const [command, raw, field] of cases) {
      const out = await t.as(A, 'owner')(command, raw);
      expect(out.ok).toBe(false);
      if (out.ok) continue;
      expect(out.refusal.reason).toBe('invalid-input');
      expect(JSON.stringify(out.refusal.data)).toContain(field);
    }
    expect(t.memberships.map((m) => m.userId)).toEqual([A]);
  });

  it("what the service refuses is a refusal, with its reason, what to do instead, and the Nest body's code", async () => {
    const t = await setup();
    const refusalOf = async (out: Promise<{ ok: boolean; refusal?: { reason: string; instead: string; data?: Record<string, unknown> } }>) => {
      const o = await out;
      expect(o.ok).toBe(false);
      expect(o.refusal!.instead.length).toBeGreaterThan(0);
      return { reason: o.refusal!.reason, status: o.refusal!.data?.statusCode, code: o.refusal!.data?.code };
    };
    // Nobody signed in.
    expect(await refusalOf(withRequester({}, () => invokeCommand(workspaceCreateCommand, t.apis, { name: 'B', slug: 'b' }, {})))).toMatchObject({
      reason: 'unauthenticated',
      status: 401,
    });
    // A member may add nobody.
    await t.as(A, 'owner')(membershipAddCommand, { userId: B, role: 'member' });
    expect(await refusalOf(t.as(B, 'member')(membershipAddCommand, { userId: C, role: 'member' }))).toMatchObject({
      reason: 'forbidden',
      status: 403,
    });
    // Twice is a conflict; a user who doesn't exist, or isn't a member, is not found.
    expect(await refusalOf(t.as(A, 'owner')(membershipAddCommand, { userId: B, role: 'member' }))).toMatchObject({
      reason: 'conflict',
      status: 409,
      code: 'already_a_member',
    });
    expect(await refusalOf(t.as(A, 'owner')(membershipAddCommand, { userId: C, role: 'member' }))).toMatchObject({
      reason: 'not-found',
      status: 404,
    });
    expect(await refusalOf(t.as(A, 'owner')(membershipRemoveCommand, { userId: C }))).toMatchObject({ reason: 'not-found' });
    // The last owner stays.
    expect(await refusalOf(t.as(A, 'owner')(membershipChangeRoleCommand, { userId: A, role: 'member' }))).toMatchObject({
      reason: 'conflict',
      code: 'last_owner',
    });
    // Without a workspace, a membership change is a bad request that says how to name one.
    const none = await withRequester({ userId: A }, () => invokeCommand(membershipRemoveCommand, t.apis, { userId: B }, {}));
    expect(none).toMatchObject({ ok: false, refusal: { reason: 'bad-request', data: { code: 'workspace_required' } } });
  });

  it('a crash still throws: only a caller\'s mistake is a refusal', async () => {
    const t = await setup();
    t.failWith(new Error('the database went away'));
    await expect(t.as(A, 'owner')(membershipAddCommand, { userId: B, role: 'member' })).rejects.toThrow('the database went away');
  });

  it("the input limits are the shipped workspace.yaml's", () => {
    const file = path.join(import.meta.dir, '../../../../../examples/identity/definitions/entities/identity/workspace.yaml');
    const fields = yaml.parse(fs.readFileSync(file, 'utf8')).fields;
    expect({ name: fields.name.max_length, slug: fields.slug.max_length }).toEqual(WORKSPACE_FIELD_MAX);
  });
});
