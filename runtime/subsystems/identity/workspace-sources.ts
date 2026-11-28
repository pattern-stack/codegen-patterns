/**
 * Workspace sources (ID-1): how a request names the workspace it acts in. One row per way, in `WORKSPACE_SOURCES`.
 */
import type { RequestFacts } from '../../requester';
import type { WorkspaceSourceName } from './names';

/** What a source found: a workspace id, a malformed one (the text, for the refusal), or none named. */
export type WorkspaceNamed = { readonly workspaceId: string } | { readonly malformed: string } | null;

export interface WorkspaceSource {
  readonly name: WorkspaceSourceName;
  /** Where the HTTP layer mounts workspace routes: `''` (the header row), `/w/:workspaceId` (the path row). */
  readonly routePrefix: string;
  /** What to tell a caller whose workspace is missing or malformed. */
  readonly instead: string;
  workspaceOf(request: RequestFacts): WorkspaceNamed;
}

/** Any 8-4-4-4-12 hex id, as Postgres accepts (the generated DTOs' `z.guid()`). */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is this an id a uuid column accepts? */
export const isGuid = (text: string): boolean => GUID.test(text);

const named = (text: string | undefined): WorkspaceNamed =>
  text === undefined || text === '' ? null : GUID.test(text) ? { workspaceId: text.toLowerCase() } : { malformed: text };

export const WORKSPACE_HEADER = 'X-Workspace';

/** `X-Workspace: <id>`. */
export function headerWorkspaceSource(): WorkspaceSource {
  return {
    name: 'header',
    routePrefix: '',
    instead: `send the workspace's id in the ${WORKSPACE_HEADER} header`,
    workspaceOf: (request) => named(request.header(WORKSPACE_HEADER)),
  };
}

const PATH = /^\/w\/([^/]+)(?:\/|$)/;

/** `/w/<id>/…`: the workspace is the path's first segment after `/w/`. */
export function pathWorkspaceSource(): WorkspaceSource {
  return {
    name: 'path',
    routePrefix: '/w/:workspaceId',
    instead: "put the workspace's id in the path: /w/<workspace id>/…",
    workspaceOf: (request) => named(PATH.exec(request.path)?.[1]),
  };
}

/** The rows. Adding a source is adding a name in `names.ts` and its row here. */
export const WORKSPACE_SOURCES: Readonly<Record<WorkspaceSourceName, () => WorkspaceSource>> = {
  header: headerWorkspaceSource,
  path: pathWorkspaceSource,
};
