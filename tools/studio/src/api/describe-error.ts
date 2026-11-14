/**
 * A failed request as a pane's error state: a title, and the detail under it.
 *
 * Offline (status 0) is the one case that blames the server. Anything the
 * server answered keeps its own words: a 502 from `GET /api/surface` is
 * `project surface failed`, with the CLI's reason — an `api.includes` path
 * that names no relation, say — as the detail (STUDIO-2 §4). Reading that as
 * "the server is not responding" sends the reader to restart a server that is
 * running fine.
 */
import { ApiError } from './client';

export interface DescribedError {
  title: string;
  detail?: string;
}

export const OFFLINE_TITLE = 'The Studio server is not responding — is `just studio` running?';

export function describeError(err: unknown, fallback: string): DescribedError {
  if (err instanceof ApiError) {
    return { title: err.isOffline ? OFFLINE_TITLE : err.message || fallback, detail: err.detail };
  }
  return { title: fallback, detail: err instanceof Error ? err.message : String(err) };
}
