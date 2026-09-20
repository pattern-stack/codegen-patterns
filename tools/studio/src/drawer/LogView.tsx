import { useEffect, useRef } from 'react';
import type { RunStepStatus } from '@studio-shared';
import { RUN_STEPS } from './run-state';
import type { RunState } from './run-state';
import { Dot, EmptyState, Spinner } from '../ui/primitives';

const STATUS_COLOR: Record<RunStepStatus, string> = {
  running: 'var(--accent)',
  ok: 'var(--ok)',
  failed: 'var(--danger)',
  skipped: 'var(--t-muted)',
};

/**
 * The run log, streamed.
 *
 * The step strip is a fixed-height row rendered from `RUN_STEPS`, present from
 * the first frame with every step greyed — so a step reaching `running`
 * recolours a row that already exists rather than inserting one and pushing
 * the log down mid-stream.
 */
export function LogView({ state }: { state: RunState }) {
  const tail = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  /** Stop following once the reader scrolls up to read something. */
  const following = useRef(true);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (following.current) tail.current?.scrollIntoView({ block: 'end' });
  }, [state.log.length, state.phase]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sp-4)',
          flex: '0 0 auto',
          height: 30,
          padding: '0 var(--sp-3)',
          borderBottom: '1px solid var(--s-line)',
          background: 'var(--s-chrome)',
        }}
      >
        {RUN_STEPS.map((step) => {
          const status = state.steps[step.name];
          return (
            <div
              key={step.name}
              title={step.hint}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--sp-2)',
                fontSize: 11.5,
                color: status ? STATUS_COLOR[status] : 'var(--t-muted)',
              }}
            >
              {status === 'running' ? (
                <Spinner size={9} />
              ) : (
                <Dot color={status ? STATUS_COLOR[status] : 'var(--s-line-strong)'} />
              )}
              {step.label}
              {status != null && status !== 'running' && (
                <span style={{ opacity: 0.7 }}>{status}</span>
              )}
            </div>
          );
        })}
        {state.runId != null && (
          <span
            style={{
              marginLeft: 'auto',
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              color: 'var(--t-muted)',
            }}
          >
            run {state.runId}
          </span>
        )}
      </div>

      <div ref={scroller} style={{ flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--s-canvas)' }}>
        {state.phase === 'idle' && state.log.length === 0 ? (
          <EmptyState
            title="No run yet"
            body="Generate runs the CLI against the demo project and streams its output here."
          />
        ) : (
          <div style={{ padding: 'var(--sp-2) 0' }}>
            {state.log.map((line) => (
              <div
                key={line.seq}
                style={{
                  display: 'flex',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11.5,
                  lineHeight: '17px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: 'var(--t-secondary)',
                }}
              >
                <span
                  style={{
                    flex: '0 0 46px',
                    textAlign: 'right',
                    paddingRight: 'var(--sp-2)',
                    color: 'var(--t-muted)',
                    opacity: 0.45,
                    userSelect: 'none',
                  }}
                >
                  {line.seq + 1}
                </span>
                <span style={{ flex: 1, paddingRight: 'var(--sp-3)' }}>{line.text}</span>
              </div>
            ))}
            {state.error != null && (
              <div
                style={{
                  margin: 'var(--sp-2) var(--sp-3)',
                  padding: 'var(--sp-2) var(--sp-3)',
                  borderRadius: 'var(--r-md)',
                  background: 'var(--danger-soft)',
                  color: 'var(--danger)',
                  fontSize: 12,
                }}
              >
                {state.error}
              </div>
            )}
            <div ref={tail} />
          </div>
        )}
      </div>
    </div>
  );
}
