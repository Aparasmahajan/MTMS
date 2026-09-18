'use client';

import { useState } from 'react';
import { useTracker } from '@/components/TrackerProvider';
import { Blueprint, EmptyRow, SectionHeading } from '@/components/primitives';
import { send } from '@/lib/client/api';
import { TONE_STYLE } from '@/lib/shared/vocabulary';
import { formatStamp, type Snapshot, type StepEntryView, type StepListView } from '@/lib/shared/views';

/**
 * The checklists attached to one sub-module or sub-activity.
 *
 * Deliberately not part of the matrix. The matrix is the set of deliverables every row in the
 * project shares; a checklist is the specific process one use case follows, and folding one
 * into the other would mean either every sub-module carrying every other one's steps, or the
 * matrix growing a column each time somebody added a step.
 *
 * **Nothing here decides whether a control works.** `can_tick` and `locked_reason` come from
 * the server, which has already applied the order rule and the role rule. The screen draws the
 * answer and shows the reason; it never recomputes either, because a client that guessed would
 * eventually guess differently and produce a button that looks available and then refuses.
 */

/** A step's glyph, on the same principle as the matrix: never colour alone. */
const STATE_MARK: Record<StepEntryView['state'], string> = {
  todo: '○',
  done: '●',
  blocked: '⊘',
};

const STATE_TONE: Record<StepEntryView['state'], keyof typeof TONE_STYLE> = {
  todo: 'none',
  done: 'done',
  blocked: 'part',
};

function quietAction(enabled: boolean) {
  return {
    fontSize: 12,
    color: 'var(--color-neutral-600)',
    border: 0,
    background: 'transparent',
    padding: 0,
    cursor: enabled ? 'pointer' : 'not-allowed',
  } as const;
}

export function StepChecklist({
  lists,
  heading,
  emptyNote,
}: {
  lists: StepListView[];
  heading: string;
  /** What to say when this thing has no checklist. Null hides the section entirely. */
  emptyNote: string | null;
}) {
  if (lists.length === 0 && emptyNote === null) return null;

  return (
    <>
      <SectionHeading>{heading}</SectionHeading>
      {lists.length === 0 ? (
        <div className="bordered">
          <EmptyRow>{emptyNote}</EmptyRow>
        </div>
      ) : null}
      {lists.map((list) => (
        <StepList key={list.id} list={list} />
      ))}
    </>
  );
}

function StepList({ list }: { list: StepListView }) {
  return (
    <Blueprint padded={false} style={{ marginBottom: 'var(--space-4)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 'var(--space-3)',
          padding: 'var(--space-3) var(--space-4)',
          borderBottom: '1px solid var(--color-divider)',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 15, flex: 1, minWidth: 0 }}>
          {list.name}
        </span>
        <span
          className="tag tag-neutral"
          style={{ flex: 'none' }}
          title={
            list.enforce_order
              ? 'A strict sequence — a step cannot be ticked until the ones before it are done.'
              : 'These steps can be done in any order.'
          }
        >
          {list.enforce_order ? 'in order' : 'any order'}
        </span>
        {list.blocked_count > 0 ? (
          <span className="tag tag-neutral" style={{ flex: 'none' }}>
            {list.blocked_count} blocked
          </span>
        ) : null}
        <span
          className="tabular"
          style={{ fontFamily: 'var(--font-heading)', fontSize: 15, flex: 'none' }}
        >
          {list.done_count}/{list.entries.length}
        </span>
      </div>

      {list.entries.length === 0 ? (
        <EmptyRow>This checklist has no steps on it yet.</EmptyRow>
      ) : null}

      {list.entries.map((entry, index) => (
        <StepRow key={entry.id} entry={entry} position={index + 1} ordered={list.enforce_order} />
      ))}
    </Blueprint>
  );
}

function StepRow({
  entry,
  position,
  ordered,
}: {
  entry: StepEntryView;
  position: number;
  ordered: boolean;
}) {
  const { apply, setNotice } = useTracker();
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');

  const tone = TONE_STYLE[STATE_TONE[entry.state]];

  function move(state: StepEntryView['state'], reason?: string) {
    void apply(null, () =>
      send<Snapshot>(`/api/v1/steps/entries/${entry.id}`, 'PATCH', { state, reason }),
    );
  }

  /**
   * Ticking, un-ticking, and the warning before an override.
   *
   * The confirmation is not ceremony. An override is written into the history as "ticked on
   * behalf of QA" with the admin's name on it, and somebody clicking what looks like an
   * ordinary checkbox should know that is what they are signing.
   */
  function toggle() {
    if (!entry.can_tick && entry.state !== 'done') {
      setNotice(entry.locked_reason);
      return;
    }
    if (entry.state === 'done') {
      move('todo');
      return;
    }
    if (entry.is_override_for_me) {
      const allowed = entry.allowed_roles.join(' or ');
      const why = window.prompt(
        `${entry.name} is reserved for ${allowed || 'a role that no longer exists'}.\n\n` +
          'Ticking it will be recorded as your override on their behalf, with your name on it.\n\n' +
          'Why are you ticking it?',
      );
      if (why === null) return;
      move('done', why);
      return;
    }
    move('done');
  }

  function block() {
    const why = window.prompt(
      `Why is "${entry.name}" blocked?\n\n` +
        'A block with no reason tells nobody what to do about it, so this is required.',
    );
    if (why === null) return;
    if (!why.trim()) {
      setNotice('A block needs a reason in writing.');
      return;
    }
    move('blocked', why);
  }

  return (
    <div style={{ borderBottom: '1px solid var(--color-divider)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 'var(--space-3)',
          padding: 'var(--space-3) var(--space-4)',
        }}
      >
        <button
          type="button"
          onClick={toggle}
          title={entry.locked_reason || `${entry.name} — ${entry.state}`}
          aria-label={`${entry.name} — ${entry.state}`}
          disabled={!entry.can_tick && entry.state !== 'done'}
          style={{
            width: 22,
            height: 22,
            flex: 'none',
            marginTop: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            padding: 0,
            borderRadius: 0,
            border: `1px solid ${tone.border}`,
            background: tone.bg,
            color: tone.fg,
            cursor: entry.can_tick || entry.state === 'done' ? 'pointer' : 'not-allowed',
          }}
        >
          {STATE_MARK[entry.state]}
        </button>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, wordBreak: 'break-word' }}>
            {ordered ? (
              <span className="tabular" style={{ color: 'var(--color-neutral-600)' }}>
                {position}.{' '}
              </span>
            ) : null}
            {entry.name}
          </div>
          {entry.description ? (
            <div style={{ fontSize: 12, color: 'var(--color-neutral-700)', textWrap: 'pretty' }}>
              {entry.description}
            </div>
          ) : null}
          <div style={{ fontSize: 11, color: 'var(--color-neutral-600)', marginTop: 2 }}>
            {entry.allowed_roles.length
              ? `${entry.allowed_roles.join(' or ')} ticks this`
              : 'no role named — an admin has to pick one'}
            {entry.changed_by && entry.changed_at
              ? ` · ${entry.changed_by}, ${formatStamp(entry.changed_at)}`
              : ''}
          </div>
          {entry.state === 'blocked' && entry.blocked_reason ? (
            <div
              style={{
                marginTop: 'var(--space-2)',
                padding: 'var(--space-2) var(--space-3)',
                border: '1px solid var(--color-text)',
                borderLeftWidth: 3,
                fontSize: 12,
                textWrap: 'pretty',
              }}
            >
              Blocked — {entry.blocked_reason}
            </div>
          ) : null}
          {/*
            Why a control is off, said where the control is. The server wrote this sentence,
            so it is the same one the refusal would carry if the click went through anyway.
          */}
          {!entry.can_tick && entry.state !== 'done' && entry.locked_reason ? (
            <div style={{ marginTop: 2, fontSize: 11, color: 'var(--color-neutral-700)', textWrap: 'pretty' }}>
              {entry.locked_reason}
            </div>
          ) : null}
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-3)', flex: 'none' }}>
          {entry.state === 'blocked' ? (
            <button type="button" onClick={() => move('todo')} style={quietAction(true)}>
              unblock
            </button>
          ) : (
            <button type="button" onClick={block} style={quietAction(true)}>
              block
            </button>
          )}
          <button type="button" onClick={() => setOpen(!open)} style={quietAction(true)}>
            {entry.comments.length ? `notes ${entry.comments.length}` : 'notes'}
          </button>
        </div>
      </div>

      {open ? (
        <div
          style={{
            padding: '0 var(--space-4) var(--space-3) calc(var(--space-4) + 34px)',
            borderTop: '1px dashed var(--color-divider)',
          }}
        >
          {entry.comments.map((note) => (
            <div key={note.id} style={{ padding: 'var(--space-2) 0', fontSize: 12 }}>
              <span style={{ color: 'var(--color-neutral-700)' }}>
                {note.author}, {formatStamp(note.created_at)}
              </span>
              <div style={{ textWrap: 'pretty', wordBreak: 'break-word' }}>{note.body}</div>
              {note.mine ? (
                <button
                  type="button"
                  onClick={() =>
                    void apply(null, () => send<Snapshot>(`/api/v1/steps/comments/${note.id}`, 'DELETE'))
                  }
                  style={quietAction(true)}
                >
                  remove
                </button>
              ) : null}
            </div>
          ))}

          {/*
            Open to anyone who can see the project — stakeholders included. The person who
            knows why a step is stuck is very often not the person allowed to tick it.
          */}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!comment.trim()) return;
              void apply(null, () =>
                send<Snapshot>(`/api/v1/steps/entries/${entry.id}/comments`, 'POST', {
                  body: comment.trim(),
                }),
              ).then((result) => {
                if (result) setComment('');
              });
            }}
            style={{ display: 'flex', gap: 'var(--space-2)', paddingTop: 'var(--space-2)' }}
          >
            <input
              className="input"
              style={{ flex: 1 }}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Add a note — anyone on the project can"
              aria-label={`Comment on ${entry.name}`}
            />
            <button type="submit" className="btn btn-secondary">
              Add
            </button>
          </form>

          {entry.history.length ? (
            <div style={{ marginTop: 'var(--space-3)', fontSize: 11, color: 'var(--color-neutral-600)' }}>
              {entry.history.map((event) => (
                <div key={event.id} style={{ padding: '2px 0', textWrap: 'pretty' }}>
                  {event.what} · {event.by}, {formatStamp(event.at)}
                  {event.is_override ? ' · override' : ''}
                  {event.reason ? ` — ${event.reason}` : ''}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
