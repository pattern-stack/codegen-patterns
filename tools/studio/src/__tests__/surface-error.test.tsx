/**
 * A real surface failure in the API tab (STUDIO-2 §4, Doug's S2/E2).
 *
 * `GET /api/surface` answers 502 `{ error: 'project surface failed', detail }`
 * when `project surface` itself fails — an `api.includes` path that names no
 * relation is a generation error — and `detail` is the CLI's own message
 * (`test/studio/run-studio-e2e.ts` stage 7b proves the server sends exactly
 * this). The tab must print that message, not blame a server that answered.
 *
 * The chain is the real one: the client's response handling, the App's error
 * description, and the tab rendered to markup.
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { api } from '../api/client';
import { OFFLINE_TITLE, describeError } from '../api/describe-error';
import { ApiTab } from '../inspector/ApiTab';
import type { SurfaceState } from '../inspector/ApiTab';

const CLI_TEXT =
  "account.api.includes.find_by_id: 'nonexistent' names no relation at 'nonexistent' — table 'accounts' has no " +
  "relation 'nonexistent' in the generated manifest. Relation keys at this hop: contacts, opportunities.";

// `typeof fetch` carries Bun's `preconnect`; a stand-in keeps the real one.
const { preconnect } = globalThis.fetch;
function fakeFetch(impl: () => Promise<Response>): typeof fetch {
  return Object.assign(impl, { preconnect });
}

const fetchSpy = spyOn(globalThis, 'fetch');
afterEach(() => {
  fetchSpy.mockReset();
});
afterAll(() => {
  fetchSpy.mockRestore();
});

function respond(status: number, body: unknown): void {
  fetchSpy.mockImplementation(
    fakeFetch(
      async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    ),
  );
}

async function surfaceState(): Promise<SurfaceState> {
  try {
    return { status: 'ready', surface: (await api.surface()).surface };
  } catch (err) {
    return { status: 'error', error: describeError(err, 'Could not derive the API surface') };
  }
}

function renderTab(surface: SurfaceState, nodeId: string | null = 'account'): string {
  return renderToStaticMarkup(
    <ApiTab nodeId={nodeId} surface={surface} onRetry={() => {}} onReveal={() => {}} canReveal={() => false} />,
  );
}

/** Markup text with React's entity escaping undone, so the CLI's quotes compare as typed. */
function text(html: string): string {
  return html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

describe('API tab — `project surface` fails for real', () => {
  test("a 502 from the surface route renders the CLI's message, not 'not responding'", async () => {
    respond(502, { error: 'project surface failed', detail: CLI_TEXT });
    const html = text(renderTab(await surfaceState()));
    expect(html).toContain('project surface failed');
    expect(html).toContain(CLI_TEXT);
    expect(html).not.toContain(OFFLINE_TITLE);
  });

  test('the error outranks an empty selection', async () => {
    respond(502, { error: 'project surface failed', detail: CLI_TEXT });
    const html = text(renderTab(await surfaceState(), null));
    expect(html).toContain(CLI_TEXT);
    expect(html).not.toContain('Nothing selected');
  });

  test('only an unreachable server reads as not responding', async () => {
    fetchSpy.mockImplementation(
      fakeFetch(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const html = text(renderTab(await surfaceState()));
    expect(html).toContain(OFFLINE_TITLE);
  });
});
