'use client';

import Link from 'next/link';
import { notFound, useParams, useRouter } from 'next/navigation';
import { useTracker } from '@/components/TrackerProvider';
import { DiscussionPanel } from '@/components/DiscussionPanel';
import { OwnersPanel } from '@/components/OwnersPanel';
import { Bar, Blueprint, EmptyRow, SectionHeading } from '@/components/primitives';
import { send } from '@/lib/client/api';
import { missingLine } from '@/lib/shared/views';

/**
 * One module — what the matrix already knows about it, plus the things that could only ever
 * attach to a record rather than to a name.
 *
 * This screen is the reason modules stopped being strings. A checklist, a set of owners and a
 * discussion all have to hang off something with an id; while a module was a piece of text in
 * a config list there was nothing here to open.
 *
 * What it deliberately does **not** do is repeat the matrix. The sub-module list below is a way
 * in, not a second grid: the matrix is where cells get ticked, and two places to do that is how
 * they end up disagreeing.
 */
export default function ModulePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { snapshot, words, can, reasonFor, subModuleHref, apply } = useTracker();

  const module = snapshot.config.modules.find((candidate) => candidate.id === id);
  if (!module) notFound();

  const rows = snapshot.sub_modules.filter((row) => row.module_name === module.name);
  const canEdit = can('module.edit');

  return (
    <div className="page page-narrow">
      <div style={{ fontSize: 13, color: 'var(--color-neutral-600)', marginBottom: 'var(--space-2)' }}>
        <Link href="/matrix" style={{ color: 'inherit' }}>
          {snapshot.project.key}
        </Link>{' '}
        / {words.module.lowerMany}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 'var(--space-8)',
          marginBottom: 'var(--space-6)',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div className="kicker">{words.module.one}</div>
          <h1 style={{ wordBreak: 'break-word' }}>{module.name}</h1>
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-4)',
              marginTop: 'var(--space-2)',
              alignItems: 'center',
              flexWrap: 'wrap',
              fontSize: 13,
              color: 'var(--color-neutral-700)',
            }}
          >
            <span>
              {module.sub_module_count}{' '}
              {module.sub_module_count === 1 ? words.subModule.lower : words.subModule.lowerMany}
            </span>
            <span>
              {module.in_prod} of {module.sub_module_count} in prod
            </span>
            <span>{module.readiness}% average readiness</span>
          </div>
        </div>

        <Link
          href={`/matrix?node=${encodeURIComponent(module.name)}`}
          className="btn btn-secondary"
          style={{ flex: 'none' }}
        >
          Open on the matrix
        </Link>
      </div>

      {/*
        The description is editable in place and saves on blur, like the wording boxes on
        Configure. A module with nothing written on it is the normal case — the placeholder
        says what it is for rather than leaving an empty box to guess at.
      */}
      <Blueprint style={{ marginBottom: 'var(--space-6)' }}>
        <label
          htmlFor="module-description"
          className="kicker"
          style={{ fontSize: 11, letterSpacing: '.09em' }}
        >
          What this {words.module.lower} is
        </label>
        <textarea
          id="module-description"
          className="input"
          rows={2}
          defaultValue={module.description}
          disabled={!canEdit}
          title={canEdit ? undefined : reasonFor('module.edit')}
          placeholder={`Anything the team should know about ${module.name} — what it is, who runs it, what usually goes wrong.`}
          style={{ width: '100%', marginTop: 'var(--space-2)' }}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (value === module.description) return;
            void apply(null, () =>
              send(`/api/v1/config/modules/${module.id}`, 'PATCH', { description: value }),
            );
          }}
        />
      </Blueprint>

      <div
        className="split"
        style={{
          display: 'grid',
          gridTemplateColumns: '1.1fr 1fr',
          gap: 'var(--space-8)',
          alignItems: 'start',
        }}
      >
        <div>
          <OwnersPanel scopeType="module" scopeId={module.id} groups={module.owners} />

          <SectionHeading>
            {words.subModule.many} on this {words.module.lower}
          </SectionHeading>
          <div className="bordered">
            {rows.length === 0 ? (
              <EmptyRow>
                Nothing is tracked on {module.name} yet. Add a {words.subModule.lower} from the
                library.
              </EmptyRow>
            ) : null}
            {rows.map((row) => (
              <button
                key={row.id}
                type="button"
                className="hoverable"
                onClick={() => router.push(subModuleHref(row.id))}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: 'var(--space-3) var(--space-4)',
                  borderBottom: '1px solid var(--color-divider)',
                  border: 0,
                  background: 'transparent',
                  textAlign: 'left',
                  color: 'inherit',
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)' }}>
                  <span style={{ flex: 1, fontSize: 13, lineHeight: 1.3, wordBreak: 'break-word' }}>
                    {row.name}
                  </span>
                  <Bar percent={row.readiness} />
                  <span
                    className="tabular"
                    style={{
                      width: 44,
                      flex: 'none',
                      textAlign: 'right',
                      fontFamily: 'var(--font-heading)',
                      fontSize: 15,
                    }}
                  >
                    {row.readiness}%
                  </span>
                </div>
                <div style={{ marginTop: 2, fontSize: 11, color: 'var(--color-neutral-600)' }}>
                  {row.closed ? 'closed' : missingLine(row.missing) || 'everything counted is done'}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div>
          <DiscussionPanel scopeType="module" scopeId={module.id} threads={module.threads} />
        </div>
      </div>
    </div>
  );
}
