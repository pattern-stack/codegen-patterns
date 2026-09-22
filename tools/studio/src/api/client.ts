/**
 * Typed client for the Studio server.
 *
 * Every wire shape comes from `@studio-shared` (`src/studio/shared/api.ts`) —
 * this module adds no shapes of its own beyond the error envelope it throws.
 * Requests are same-origin: in dev Vite proxies `/api` to the server, in
 * production the server serves this bundle and handles `/api` itself.
 */
import type {
  DiffResponse,
  FileListResponse,
  FileReadResponse,
  FileValidationErrorResponse,
  FileWriteRequest,
  FileWriteResponse,
  GenerateRequest,
  GenerateResponse,
  GraphResponse,
  HealthResponse,
  RelationshipPreviewResponse,
  RelationshipRequest,
  RelationshipWriteResponse,
  RunConflictResponse,
  RunEvent,
  ValidateResponse,
  ZodIssueLike,
} from '@studio-shared';

/**
 * A non-2xx response from the server.
 *
 * `status` is kept so callers can branch on the cases the contract gives
 * meaning to — 422 validation, 409 run-in-flight — without string matching.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly detail?: string;

  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }

  /** True when the server could not be reached at all (server down). */
  get isOffline(): boolean {
    return this.status === 0;
  }
}

/** A 422 from `PUT /api/files/:path`, carrying the Zod issues to render inline. */
export class FileValidationError extends ApiError {
  readonly issues: ZodIssueLike[];

  constructor(issues: ZodIssueLike[]) {
    super(422, issues.length === 1 ? issues[0]!.message : `${issues.length} validation issues`);
    this.name = 'FileValidationError';
    this.issues = issues;
  }
}

/** A 409 from `POST /api/generate` — another run already holds the registry. */
export class RunConflictError extends ApiError {
  readonly runId: string;

  constructor(body: RunConflictResponse) {
    super(409, body.error);
    this.name = 'RunConflictError';
    this.runId = body.runId;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch (cause) {
    throw new ApiError(
      0,
      'Cannot reach the Studio server',
      cause instanceof Error ? cause.message : String(cause),
    );
  }

  if (res.ok) {
    // 204 and other empty bodies still have to satisfy the signature; every
    // 2xx in the contract has a JSON body, so an empty one is a server bug we
    // surface rather than paper over.
    return (await res.json()) as T;
  }

  const body: unknown = await res.json().catch(() => null);

  if (res.status === 422 && isValidationErrorBody(body)) {
    throw new FileValidationError(body.issues);
  }
  if (res.status === 409 && isRunConflictBody(body)) {
    throw new RunConflictError(body);
  }
  if (isApiErrorBody(body)) {
    throw new ApiError(res.status, body.error, body.detail);
  }
  throw new ApiError(res.status, `${res.status} ${res.statusText}`);
}

function isApiErrorBody(v: unknown): v is { error: string; detail?: string } {
  return typeof v === 'object' && v !== null && typeof (v as { error?: unknown }).error === 'string';
}

function isValidationErrorBody(v: unknown): v is FileValidationErrorResponse {
  return (
    typeof v === 'object' && v !== null && Array.isArray((v as { issues?: unknown }).issues)
  );
}

function isRunConflictBody(v: unknown): v is RunConflictResponse {
  return isApiErrorBody(v) && typeof (v as { runId?: unknown }).runId === 'string';
}

/** `StudioFile.path` is project-relative POSIX and goes in as one segment. */
function filePath(path: string): string {
  return `/api/files/${encodeURIComponent(path)}`;
}

export const api = {
  health: () => request<HealthResponse>('/api/health'),

  graph: () => request<GraphResponse>('/api/graph'),

  listFiles: () => request<FileListResponse>('/api/files'),

  readFile: (path: string) => request<FileReadResponse>(filePath(path)),

  writeFile: (path: string, content: string) =>
    request<FileWriteResponse>(filePath(path), {
      method: 'PUT',
      body: JSON.stringify({ content } satisfies FileWriteRequest),
    }),

  validate: () => request<ValidateResponse>('/api/validate', { method: 'POST' }),

  diff: () => request<DiffResponse>('/api/diff'),

  generate: (steps: GenerateRequest['steps']) =>
    request<GenerateResponse>('/api/generate', {
      method: 'POST',
      body: JSON.stringify({ steps } satisfies GenerateRequest),
    }),

  previewRelationship: (req: RelationshipRequest) =>
    request<RelationshipPreviewResponse>('/api/relationships', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  writeRelationship: (req: RelationshipRequest) =>
    request<RelationshipWriteResponse>('/api/relationships', {
      method: 'PUT',
      body: JSON.stringify(req),
    }),
};

export interface RunStreamHandlers {
  onEvent: (event: RunEvent) => void;
  /** Called once, for a transport failure — never after a `done` event. */
  onError: (message: string) => void;
}

/**
 * Subscribe to a run's SSE log.
 *
 * The server sends each `RunEvent` as the JSON payload of a plain `message`
 * frame and ends the response right after `done`, so the close that follows a
 * `done` is expected and must not be reported as an error.
 *
 * Returns an unsubscribe function; calling it is safe at any point.
 */
export function streamRun(runId: string, handlers: RunStreamHandlers): () => void {
  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`);
  let finished = false;

  const close = () => {
    finished = true;
    source.close();
  };

  source.onmessage = (ev) => {
    let event: RunEvent;
    try {
      event = JSON.parse(ev.data) as RunEvent;
    } catch {
      handlers.onError('Malformed event on the run stream');
      close();
      return;
    }
    handlers.onEvent(event);
    if (event.type === 'done') close();
  };

  source.onerror = () => {
    // EventSource fires `error` on the normal end-of-stream close too. Only a
    // failure before `done` is a real one.
    if (finished) return;
    handlers.onError('Lost the connection to the run stream');
    close();
  };

  return close;
}
