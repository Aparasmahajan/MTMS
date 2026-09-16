'use client';

import { useState } from 'react';
import { useTracker } from '@/components/TrackerProvider';
import { Blueprint, EmptyRow, SectionHeading } from '@/components/primitives';
import { send } from '@/lib/client/api';
import { formatStamp, type Snapshot, type ThreadView } from '@/lib/shared/views';

/**
 * Discussions — a topic, and everything said on it.
 *
 * This is where the argument that does not fit in a cell goes. The matrix records what is
 * loaded and the checklist records what was done; neither has anywhere to put "we cannot test
 * this until the vendor answers, and here is what they said last time".
 *
 * **Open to anyone who can see the project.** Not gated on `module.edit`, deliberately: the
 * person who knows why something is stuck is very often not the person allowed to change it,
 * and a discussion only the writers can join is a discussion that happens in a chat instead.
 */

/** Highlights an @name without rendering HTML — the server never sends markup and nor do we. */
function withMentions(body: string) {
  return body.split(/(@[\w.-]+)/g).map((part, index) =>
    part.startsWith('@') ? (
      <strong key={index} style={{ color: 'var(--color-accent-800)' }}>
        {part}
      </strong>
    ) : (
      <span key={index}>{part}</span>
    ),
  );
}

export function DiscussionPanel({
  scopeType,
  scopeId,
  threads,
  heading = 'Discussion',
}: {
  scopeType: 'module' | 'sub_module' | 'sub_activity';
  scopeId: string;
  threads: ThreadView[];
  heading?: string;
}) {
  const { apply, can } = useTracker();
  const [topic, setTopic] = useState('');
  const [opening, setOpening] = useState('');
  const [open, setOpen] = useState<string | null>(threads[0]?.id ?? null);

  return (
    <>
      <SectionHeading>
        {heading}
        {threads.some((thread) => thread.mentions_me) ? (
          <span
            className="tag tag-accent"
            style={{ marginLeft: 'var(--space-2)', verticalAlign: 'middle' }}
          >
            you were mentioned
          </span>
        ) : null}
      </SectionHeading>

      <Blueprint padded={false}>
        {threads.length === 0 ? (
          <EmptyRow>
            No topics yet. Raise one for anything that needs discussing rather than recording —
            a decision, a blocker, what the vendor actually said.
          </EmptyRow>
        ) : null}

        {threads.map((thread) => {
          const expanded = open === thread.id;
          return (
            <div key={thread.id} style={{ borderBottom: '1px solid var(--color-divider)' }}>
              <button
                type="button"
                onClick={() => setOpen(expanded ? null : thread.id)}
                className="hoverable"
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 'var(--space-3)',
                  width: '100%',
                  padding: 'var(--space-3) var(--space-4)',
                  border: 0,
                  background: 'transparent',
                  textAlign: 'left',
                  color: 'inherit',
                  cursor: 'pointer',
                }}
              >
                <span style={{ flex: 1, fontSize: 13, minWidth: 0, wordBreak: 'break-word' }}>
                  {thread.topic}
                  {thread.mentions_me ? (
                    <span className="tag tag-accent" style={{ marginLeft: 'var(--space-2)' }}>
                      @you
                    </span>
                  ) : null}
                </span>
                <span style={{ fontSize: 11, color: 'var(--color-neutral-600)', flex: 'none' }}>
                  {thread.comments.length}{' '}
                  {thread.comments.length === 1 ? 'comment' : 'comments'} · {thread.opened_by},{' '}
                  {formatStamp(thread.opened_at)}
                </span>
              </button>

              {expanded ? (
                <div style={{ padding: '0 var(--space-4) var(--space-3)' }}>
                  {thread.comments.map((comment) => (
                    <div
                      key={comment.id}
                      style={{
                        padding: 'var(--space-2) 0',
                        borderTop: '1px dashed var(--color-divider)',
                        fontSize: 12,
                      }}
                    >
                      <div style={{ color: 'var(--color-neutral-700)' }}>
                        {comment.author}, {formatStamp(comment.created_at)}
                        {comment.mentions_me ? ' · mentions you' : ''}
                      </div>
                      <div style={{ textWrap: 'pretty', wordBreak: 'break-word' }}>
                        {withMentions(comment.body)}
                      </div>
                      {comment.mine ? (
                        <button
                          type="button"
                          onClick={() =>
                            void apply(null, () =>
                              send<Snapshot>(`/api/v1/discussions/comments/${comment.id}`, 'DELETE'),
                            )
                          }
                          style={{
                            fontSize: 11,
                            color: 'var(--color-neutral-600)',
                            border: 0,
                            background: 'transparent',
                            padding: 0,
                            cursor: 'pointer',
                          }}
                        >
                          remove
                        </button>
                      ) : null}
                    </div>
                  ))}

                  <Reply threadId={thread.id} />

                  {thread.mine || can('project.config') ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (!window.confirm(`Close "${thread.topic}"?\n\nEverything said on it is kept.`)) {
                          return;
                        }
                        void apply(null, () =>
                          send<Snapshot>(`/api/v1/discussions/threads/${thread.id}`, 'DELETE'),
                        );
                      }}
                      style={{
                        marginTop: 'var(--space-2)',
                        fontSize: 11,
                        color: 'var(--color-neutral-600)',
                        border: 0,
                        background: 'transparent',
                        padding: 0,
                        cursor: 'pointer',
                      }}
                    >
                      close this topic
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!topic.trim()) return;
            void apply(null, () =>
              send<Snapshot>('/api/v1/discussions/threads', 'POST', {
                scopeType,
                scopeId,
                topic: topic.trim(),
                body: opening.trim(),
              }),
            ).then((result) => {
              if (result) {
                setTopic('');
                setOpening('');
              }
            });
          }}
          style={{ display: 'grid', gap: 'var(--space-2)', padding: 'var(--space-3) var(--space-4)' }}
        >
          <input
            className="input"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="Raise a topic…"
            aria-label="New topic"
          />
          {topic.trim() ? (
            <>
              <textarea
                className="input"
                rows={3}
                value={opening}
                onChange={(event) => setOpening(event.target.value)}
                placeholder="What is it? Use @name to bring somebody in."
                aria-label="Opening comment"
              />
              <div>
                <button type="submit" className="btn btn-primary">
                  Raise it
                </button>
              </div>
            </>
          ) : null}
        </form>
      </Blueprint>
    </>
  );
}

function Reply({ threadId }: { threadId: string }) {
  const { apply } = useTracker();
  const [body, setBody] = useState('');

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!body.trim()) return;
        void apply(null, () =>
          send<Snapshot>(`/api/v1/discussions/threads/${threadId}/comments`, 'POST', {
            body: body.trim(),
          }),
        ).then((result) => {
          if (result) setBody('');
        });
      }}
      style={{ display: 'flex', gap: 'var(--space-2)', paddingTop: 'var(--space-2)' }}
    >
      <input
        className="input"
        style={{ flex: 1 }}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Reply — @name to bring somebody in"
        aria-label="Reply"
      />
      <button type="submit" className="btn btn-secondary">
        Reply
      </button>
    </form>
  );
}
