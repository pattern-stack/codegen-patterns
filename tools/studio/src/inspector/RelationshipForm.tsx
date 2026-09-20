import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RelationshipKind, RelationshipPreviewFile, RelationshipRequest } from '@studio-shared';
import { api, ApiError } from '../api/client';
import {
  RELATIONSHIP_KINDS,
  kindDescriptor,
  optionsFor,
  pruneOptions,
} from './relationship-kinds';
import type { OptionDescriptor } from './relationship-kinds';
import {
  Button,
  Field,
  SectionLabel,
  Select,
  Spinner,
  TextInput,
  Toggle,
} from '../ui/primitives';

export interface RelationshipFormProps {
  /** Entity names, for the source and target pickers. */
  entities: string[];
  /** Pre-select the source when the graph has a node selected. */
  initialFrom?: string;
  /** Called after a successful write, with the paths the server wrote. */
  onWritten: (paths: string[]) => void;
}

type Draft = Record<string, string | boolean>;

/** The draft a kind starts from — every option at its declared default. */
function defaultsFor(kind: RelationshipKind): Draft {
  const draft: Draft = {};
  for (const option of optionsFor(kind)) {
    draft[option.id] =
      option.spec.control === 'boolean'
        ? option.spec.default
        : option.spec.control === 'select'
          ? option.spec.default
          : '';
  }
  return draft;
}

/**
 * Add a relationship: pick two entities and a kind, see the YAML the server
 * would write, then write it.
 *
 * Every kind-dependent decision — which options exist, what they are called,
 * what cardinality is drawn, where the YAML lands — is read from
 * `relationship-kinds`. Nothing here branches on a kind literal, so #679's
 * collapse of junction and relationship is an edit to that registry.
 */
export function RelationshipForm({ entities, initialFrom, onWritten }: RelationshipFormProps) {
  const [from, setFrom] = useState(initialFrom ?? entities[0] ?? '');
  const [to, setTo] = useState(entities.find((e) => e !== (initialFrom ?? entities[0])) ?? '');
  const [kind, setKind] = useState<RelationshipKind>(RELATIONSHIP_KINDS[0]!.id);
  const [draft, setDraft] = useState<Draft>(() => defaultsFor(RELATIONSHIP_KINDS[0]!.id));

  const [preview, setPreview] = useState<RelationshipPreviewFile[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  const [writing, setWriting] = useState(false);
  const [written, setWritten] = useState<string[] | null>(null);

  // Keep the source in sync with the graph's selection until the author
  // changes it themselves; after that the form is theirs.
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current && initialFrom != null && entities.includes(initialFrom)) {
      setFrom(initialFrom);
    }
  }, [initialFrom, entities]);

  const descriptor = kindDescriptor(kind);
  const options = useMemo(() => optionsFor(kind), [kind]);

  const request = useMemo<RelationshipRequest | null>(() => {
    if (!from || !to) return null;
    return { from, to, kind, options: pruneOptions(kind, draft) };
  }, [from, to, kind, draft]);

  const selectKind = (next: RelationshipKind) => {
    setKind(next);
    // Options do not carry across kinds: `onDelete` means nothing on a
    // junction, and a stale value would be sent silently.
    setDraft(defaultsFor(next));
    setPreview(null);
    setWritten(null);
  };

  // Preview is debounced against the draft so typing a name does not fire a
  // request per keystroke.
  useEffect(() => {
    if (!request) {
      setPreview(null);
      return;
    }
    setWritten(null);
    let cancelled = false;
    const timer = setTimeout(() => {
      setPreviewing(true);
      setError(null);
      api
        .previewRelationship(request)
        .then((res) => {
          if (!cancelled) setPreview(res.preview);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setPreview(null);
          setError(describe(err));
        })
        .finally(() => {
          if (!cancelled) setPreviewing(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [request]);

  const save = useCallback(() => {
    if (!request) return;
    setWriting(true);
    setError(null);
    api
      .writeRelationship(request)
      .then((res) => {
        setWritten(res.written);
        onWritten(res.written);
      })
      .catch((err: unknown) => setError(describe(err)))
      .finally(() => setWriting(false));
  }, [request, onWritten]);

  const sameEntity = from !== '' && from === to;
  const canSave = request != null && preview != null && !previewing && !writing;

  if (entities.length === 0) {
    return (
      <div style={{ padding: 'var(--sp-4)', color: 'var(--t-muted)', fontSize: 12 }}>
        The project has no entities yet, so there is nothing to relate.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          flex: '0 0 auto',
          padding: 'var(--sp-3)',
          // Extra room at the bottom so the last control scrolls clear of the
          // preview header rather than ending flush against it.
          paddingBottom: 'var(--sp-5)',
          overflowY: 'auto',
          maxHeight: '55%',
        }}
      >
        <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Field label="From">
              <Select
                value={from}
                onChange={(v) => {
                  touched.current = true;
                  setFrom(v);
                }}
                choices={entities.map((e) => ({ value: e, label: e }))}
              />
            </Field>
          </div>
          <div
            style={{
              flex: '0 0 auto',
              alignSelf: 'center',
              marginTop: 8,
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--t-muted)',
            }}
          >
            {descriptor.cardinality}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Field label="To">
              <Select
                value={to}
                onChange={setTo}
                choices={entities.map((e) => ({ value: e, label: e }))}
              />
            </Field>
          </div>
        </div>

        {sameEntity && (
          <div style={{ fontSize: 11, color: 'var(--warn)', marginBottom: 'var(--sp-3)' }}>
            Self-referential — the preview shows how the model expresses it.
          </div>
        )}

        <SectionLabel>Kind</SectionLabel>
        <div style={{ display: 'grid', gap: 'var(--sp-1)', marginBottom: 'var(--sp-4)' }}>
          {RELATIONSHIP_KINDS.map((k) => {
            const on = k.id === kind;
            return (
              <button
                key={k.id}
                type="button"
                aria-pressed={on}
                onClick={() => selectKind(k.id)}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 'var(--sp-2)',
                  padding: '6px var(--sp-3)',
                  borderRadius: 'var(--r-md)',
                  border: `1px solid ${on ? 'var(--accent)' : 'var(--s-line)'}`,
                  background: on ? 'var(--accent-soft)' : 'var(--s-canvas)',
                  color: 'var(--t-primary)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: 'inherit',
                }}
              >
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, fontWeight: 600 }}>
                  {k.label}
                </span>
                <span style={{ fontSize: 11, color: 'var(--t-muted)' }}>{k.description}</span>
              </button>
            );
          })}
        </div>

        <SectionLabel>Options</SectionLabel>
        {options.map((option) => (
          <OptionField
            key={option.id}
            option={option}
            value={draft[option.id]}
            onChange={(v) => setDraft((prev) => ({ ...prev, [option.id]: v }))}
          />
        ))}
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          borderTop: '1px solid var(--s-line)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--sp-2)',
            flex: '0 0 auto',
            height: 30,
            padding: '0 var(--sp-3)',
            background: 'var(--s-chrome)',
            borderBottom: '1px solid var(--s-line)',
          }}
        >
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--t-muted)' }}>
            Preview
          </span>
          {/* The spinner sits in a fixed slot so the header cannot jump when a
              debounced preview starts. */}
          <span style={{ width: 12, display: 'inline-flex' }}>{previewing && <Spinner size={10} />}</span>
          <span style={{ fontSize: 11, color: 'var(--t-muted)' }}>
            writes {descriptor.writes}
          </span>
          <Button
            size="sm"
            tone="primary"
            onClick={save}
            disabled={!canSave}
            style={{ marginLeft: 'auto' }}
          >
            {writing ? 'Saving…' : 'Save'}
          </Button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--s-canvas)' }}>
          {error != null ? (
            <div style={{ padding: 'var(--sp-3)' }}>
              <div style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 'var(--sp-2)' }}>
                {error.message}
              </div>
              {error.detail != null && (
                <pre
                  style={{
                    margin: 0,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--t-muted)',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {error.detail}
                </pre>
              )}
            </div>
          ) : preview == null ? (
            <div style={{ padding: 'var(--sp-3)', fontSize: 12, color: 'var(--t-muted)' }}>
              {previewing ? 'Asking the server what this would write…' : 'Pick two entities to see the YAML.'}
            </div>
          ) : preview.length === 0 ? (
            <div style={{ padding: 'var(--sp-3)', fontSize: 12, color: 'var(--t-muted)' }}>
              The server reported nothing to write for this combination.
            </div>
          ) : (
            preview.map((file) => (
              <div key={file.path}>
                <div
                  style={{
                    padding: '4px var(--sp-3)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--accent)',
                    background: 'var(--s-panel)',
                    borderBottom: '1px solid var(--s-line)',
                  }}
                >
                  {file.path}
                </div>
                <pre
                  style={{
                    margin: 0,
                    padding: 'var(--sp-2) var(--sp-3)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11.5,
                    lineHeight: '17px',
                    color: 'var(--t-secondary)',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {file.content}
                </pre>
              </div>
            ))
          )}
        </div>

        {written != null && (
          <div
            style={{
              flex: '0 0 auto',
              padding: 'var(--sp-2) var(--sp-3)',
              borderTop: '1px solid var(--s-line)',
              background: 'var(--s-panel)',
              fontSize: 11.5,
              color: 'var(--ok)',
            }}
          >
            Wrote {written.length} {written.length === 1 ? 'file' : 'files'}. Run Generate to build it.
          </div>
        )}
      </div>
    </div>
  );
}

function OptionField({
  option,
  value,
  onChange,
}: {
  option: OptionDescriptor;
  value: string | boolean | undefined;
  onChange: (v: string | boolean) => void;
}) {
  const { spec } = option;

  if (spec.control === 'boolean') {
    return (
      <div style={{ marginBottom: 'var(--sp-3)' }}>
        <Toggle
          checked={value === true}
          onChange={onChange}
          label={option.label}
        />
        <div style={{ fontSize: 11, color: 'var(--t-muted)', marginTop: 2, marginLeft: 22 }}>
          {option.hint}
        </div>
      </div>
    );
  }

  if (spec.control === 'select') {
    return (
      <Field label={option.label} hint={option.hint}>
        <Select
          value={typeof value === 'string' ? value : spec.default}
          onChange={onChange}
          choices={spec.choices.map((c) => ({ value: c, label: c }))}
        />
      </Field>
    );
  }

  return (
    <Field label={option.label} hint={option.hint}>
      <TextInput
        value={typeof value === 'string' ? value : ''}
        onChange={onChange}
        placeholder={spec.placeholder}
        monospace
      />
    </Field>
  );
}

function describe(err: unknown): { message: string; detail?: string } {
  if (err instanceof ApiError) {
    return {
      message: err.isOffline ? 'The Studio server is not responding' : err.message,
      detail: err.detail,
    };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}
