/**
 * The fast path to a run's next advance, never the only one: whatever made the run due is durable (a due step, a
 * settled signal, a pending child), so the sweep's open-run read finds it when a submit fails. A failed submit never
 * fails its caller. `target` is an executor, or the advance's deps (`AdvanceDeps.submit`); absent, nothing is sent.
 */
export async function submitSoon(
  target: { submit?(runId: string): Promise<void> } | undefined,
  runId: string,
): Promise<void> {
  try {
    await target?.submit?.(runId);
  } catch {
    // The run is due already: the sweep submits it.
  }
}
