'use client';

import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { useTracker } from '@/components/TrackerProvider';
import { Blueprint, PageTitle } from '@/components/primitives';
import { StepsPanel } from '@/components/config/StepsPanel';
import { WordingPanel } from '@/components/config/WordingPanel';
import { send } from '@/lib/client/api';
import type { ConfigList, Environment } from '@/lib/shared/domain';
import { PROD_ENVIRONMENT } from '@/lib/shared/domain';
import { statusEntry, STATUS_SETS, STATUS_VOCABULARY, TONE_DESCRIPTION, TONE_STYLE } from '@/lib/shared/vocabulary';
import { columnDisplayLabel } from '@/lib/shared/views';
import type { ColumnView, Snapshot } from '@/lib/shared/views';

/**
 * Configure — everything a project admin sets, and the reason the app is generic.
 *
 * The matrix is generated from this screen. Nothing below is hard-coded anywhere else:
 * add a column here and it appears on the matrix, in the readiness maths, on the module
 * detail and in the drift table, for every module in the project.
 */

function ConfigSet({
  title,
  hint,
  list,
  placeholder,
  values,
}: {
  title: string;
  hint: string;
  list: ConfigList;
  placeholder: string;
  values: { key: string; label: string }[];
}) {
  const { apply, can, reasonFor } = useTracker();
  const [draft, setDraft] = useState('');
  const canConfig = can('project.config');

  function change(action: 'add' | 'remove', value: string) {
    void apply(null, () =>
      send<Snapshot>('/api/v1/config/lists', 'POST', { list, action, value }),
    ).then((result) => {
      if (result && action === 'add') setDraft('');
    });
  }

  return (
    <Blueprint>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 'var(--space-3)',
        }}
      >
        <h4 className="section-heading" style={{ margin: 0 }}>
          {title}
        </h4>
        <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>{hint}</span>
      </div>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--space-2)',
          marginTop: 'var(--space-4)',
        }}
      >
        {values.map((value) => (
          <div
            key={value.key}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              padding: 'var(--space-1) var(--space-3)',
              border: '1px solid var(--color-neutral-400)',
              background: 'var(--color-accent-100)',
              fontSize: 13,
            }}
          >
            <span>{value.label}</span>
            <button
              type="button"
              className="mono"
              disabled={!canConfig}
              title={canConfig ? `Remove ${value.label}` : reasonFor('project.config')}
              onClick={() => change('remove', value.key)}
              style={{
                border: 0,
                background: 'transparent',
                padding: 0,
                cursor: canConfig ? 'pointer' : 'not-allowed',
                color: 'var(--color-neutral-600)',
              }}
            >
              ×
            </button>
          </div>
        ))}
        {values.length === 0 ? (
          <span style={{ fontSize: 13, color: 'var(--color-neutral-600)' }}>None yet.</span>
        ) : null}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim()) change('add', draft.trim());
        }}
        style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}
      >
        <input
          className="input"
          style={{ flex: 1 }}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={placeholder}
          aria-label={`Add to ${title}`}
        />
        <button
          type="submit"
          className="btn btn-secondary"
          disabled={!canConfig}
          title={canConfig ? undefined : reasonFor('project.config')}
        >
          Add
        </button>
      </form>
    </Blueprint>
  );
}

/** The two shapes "loaded" comes in — one column per environment, or one column alone. */
/**
 * The four families a status can belong to, each shown as its own dropdown. "Loaded"
 * spans both named backend sets (`simple` and `load` — see `STATUS_SETS`) because to
 * somebody configuring a column they are the same idea at two granularities, not two
 * different ideas.
 */
interface StatusGroup {
  key: string;
  label: string;
  members: string[];
}

const STATUS_GROUPS: StatusGroup[] = [
  { key: 'created', label: 'Created', members: ['notcreated', 'created'] },
  { key: 'loaded', label: 'Loaded', members: ['loaded', 'lab', 'preprod', 'prod'] },
  { key: 'completion', label: 'Completion', members: ['pending', 'completed'] },
  { key: 'raised', label: 'Raised', members: ['notraised', 'raised'] },
];

/** A dropdown summary, drawn the same way whether it is open or something inside it is checked. */
function groupSummaryStyle(active: boolean): CSSProperties {
  return {
    fontSize: 12,
    padding: '2px 8px',
    borderRadius: 0,
    border: `1px solid ${active ? 'var(--color-text)' : 'var(--color-neutral-300)'}`,
    background: active ? 'var(--color-accent-100)' : 'transparent',
    color: active ? 'var(--color-text)' : 'var(--color-neutral-600)',
    cursor: 'pointer',
  };
}

/**
 * The statuses a column may take: one dropdown per family (Created, Loaded, Completion,
 * Raised), each a checklist of that family's own values. Nothing about a column limits it
 * to one family — checking "Created" in one dropdown and "Pending" in another is a valid,
 * genuinely mixed column, not an error state to warn about.
 *
 * The line below is a plain read-out of `allowed` — whatever is checked, across every
 * dropdown, in the order it is stored.
 */
function StatusSetEditor({ column }: { column: ColumnView }) {
  const { apply, can, reasonFor, setNotice } = useTracker();
  const canConfig = can('project.config');

  function toggle(key: string) {
    if (!canConfig) {
      setNotice(reasonFor('project.config'));
      return;
    }
    const next = column.allowed.includes(key)
      ? column.allowed.filter((entry) => entry !== key)
      : [...column.allowed, key];

    if (next.length === 0) {
      setNotice(`${columnDisplayLabel(column)} needs at least one status it can take.`);
      return;
    }
    void apply(null, () =>
      send<Snapshot>(`/api/v1/config/columns/${column.key}`, 'PATCH', { allowed: next }),
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', minWidth: 260 }}>
      <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
        {STATUS_GROUPS.map((group) => {
          const checkedCount = group.members.filter((key) => column.allowed.includes(key)).length;
          return (
            <details key={group.key} style={{ position: 'relative' }}>
              <summary style={groupSummaryStyle(checkedCount > 0)}>
                {group.label}
                {checkedCount > 0 ? ` (${checkedCount})` : ''}
              </summary>
              <div
                style={{
                  position: 'absolute',
                  zIndex: 5,
                  top: '100%',
                  left: 0,
                  marginTop: 2,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-1)',
                  minWidth: 170,
                  background: 'var(--color-bg)',
                  border: '1px solid var(--color-neutral-400)',
                  padding: 'var(--space-2)',
                }}
              >
                {group.members.map((key) => {
                  const on = column.allowed.includes(key);
                  const entry = statusEntry(key);
                  return (
                    <label
                      key={key}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 12,
                        cursor: canConfig ? 'pointer' : 'not-allowed',
                        opacity: canConfig ? 1 : 0.6,
                      }}
                    >
                      <input type="checkbox" checked={on} disabled={!canConfig} onChange={() => toggle(key)} />
                      <span aria-hidden className="mono">
                        {entry.mark}
                      </span>
                      {entry.label}
                    </label>
                  );
                })}
              </div>
            </details>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
        {column.allowed.map((key) => {
          const entry = statusEntry(key);
          return (
            <span
              key={key}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 12,
                padding: '1px 7px',
                color: 'var(--color-neutral-700)',
              }}
            >
              <span aria-hidden className="mono">
                {entry.mark}
              </span>
              {entry.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

interface DeliverableGroup {
  /** The group key, or the column's own key when it stands alone. */
  key: string;
  /** The spanning header — `FILECR`, or the column's own label when it stands alone. */
  label: string;
  subtitle: string;
  /** "counts" summary shown next to the header — one line per group, not per row. */
  countsSummary: string;
  /** One member for a plain column; one per environment for a grouped deliverable. */
  members: ColumnView[];
}

/**
 * Folds the flat column list into the runs the matrix itself groups under one header —
 * same rule as `groupColumns` in `lib/shared/views.ts` (a contiguous run sharing a
 * `group_key`) — but keeps hidden columns in the list. `groupColumns` drops them because
 * a hidden header has nothing to span on the matrix; here an admin needs to see a hidden
 * column to switch its environment back on.
 */
/** Strips the per-environment suffix `full` carries (" — loaded on lab") for a group's
 *  shared subtitle — every member has its own copy of that sentence, one per environment,
 *  and the group heading needs the one part they all agree on. */
function groupSubtitle(column: ColumnView): string {
  return column.group_key ? column.full.replace(/\s*—\s*loaded on \w+$/i, '') : column.full;
}

function deliverableGroups(columns: readonly ColumnView[]): DeliverableGroup[] {
  const groups: DeliverableGroup[] = [];
  for (const column of columns) {
    const key = column.group_key ?? column.key;
    const last = groups[groups.length - 1];
    if (last && last.key === key && column.group_key) {
      last.members.push(column);
    } else {
      groups.push({
        key,
        label: column.group_label ?? column.label,
        subtitle: groupSubtitle(column),
        countsSummary: '',
        members: [column],
      });
    }
  }
  for (const group of groups) {
    const first = group.members[0] as ColumnView;
    const counted = group.members.filter((member) => member.counts).length;
    group.countsSummary =
      group.members.length === 1
        ? first.counts
          ? 'Counts toward prod'
          : 'Informational'
        : `${counted} of ${group.members.length} counts toward prod`;
  }
  return groups;
}

/**
 * Environments, and the switch that takes one off the grid.
 *
 * Off is not a delete and the copy has to say so, because the operator reaching for it is
 * usually mid-incident — preprod is down, the window is open, and they want the column to
 * stop dragging every percentage below 100. Every cell survives; switching back on
 * restores exactly what was recorded.
 */
function Environments({
  environments,
  columns,
}: {
  environments: Environment[];
  columns: ColumnView[];
}) {
  const { apply, can, reasonFor, setNotice } = useTracker();
  const canConfig = can('project.config');

  if (environments.length === 0) return null;

  return (
    <div style={{ gridColumn: '1 / -1' }}>
      <Blueprint>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 'var(--space-3)',
            marginBottom: 'var(--space-4)',
            flexWrap: 'wrap',
          }}
        >
          <h4 className="section-heading" style={{ margin: 0 }}>
            Environments
          </h4>
          <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
            switching one off hides its columns — it never deletes a cell
          </span>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: 'var(--space-3)',
          }}
        >
          {environments.map((environment) => {
            const mine = columns.filter((column) => column.environment === environment.key);
            const isProd = environment.key === PROD_ENVIRONMENT;
            const locked = !canConfig || isProd;

            return (
              <div
                key={environment.key}
                style={{
                  border: '1px solid var(--color-divider)',
                  padding: 'var(--space-3)',
                  background: environment.enabled ? 'transparent' : 'var(--color-neutral-100)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: 'var(--space-2)',
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--font-heading)',
                      fontSize: 15,
                      letterSpacing: '.06em',
                      textTransform: 'uppercase',
                    }}
                  >
                    {environment.short}
                  </span>
                  <button
                    type="button"
                    aria-pressed={environment.enabled}
                    disabled={locked}
                    title={
                      isProd
                        ? 'Prod cannot be switched off — readiness is measured against it.'
                        : canConfig
                          ? `Switch ${environment.label} ${environment.enabled ? 'off' : 'on'}`
                          : reasonFor('project.config')
                    }
                    onClick={() => {
                      if (isProd) {
                        setNotice(
                          'Prod cannot be switched off — readiness is measured against it, and the FNI gate reads that percentage.',
                        );
                        return;
                      }
                      void apply(null, () =>
                        send<Snapshot>(`/api/v1/config/environments/${environment.key}`, 'PATCH', {
                          enabled: !environment.enabled,
                        }),
                      );
                    }}
                    style={{
                      fontSize: 13,
                      borderRadius: 0,
                      border: '1px solid var(--color-neutral-400)',
                      background: environment.enabled ? 'var(--color-accent-100)' : 'transparent',
                      color: 'var(--color-neutral-700)',
                      padding: '1px 8px',
                      cursor: locked ? 'not-allowed' : 'pointer',
                      opacity: locked && !isProd ? 0.6 : 1,
                    }}
                  >
                    {environment.enabled ? 'on' : 'off'}
                  </button>
                </div>
                <div style={{ fontSize: 13, marginTop: 'var(--space-1)' }}>{environment.label}</div>
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--color-neutral-600)',
                    marginTop: 'var(--space-1)',
                    textWrap: 'pretty',
                  }}
                >
                  {mine.length} {mine.length === 1 ? 'column' : 'columns'}
                  {isProd
                    ? ' · readiness is measured here, so this one stays on'
                    : environment.enabled
                      ? ' · on the matrix, not counted toward readiness'
                      : ' · hidden, cells kept'}
                </div>
              </div>
            );
          })}
        </div>
      </Blueprint>
    </div>
  );
}

export default function ConfigurePage() {
  const { snapshot, apply, can, reasonFor, words, setNotice } = useTracker();
  const router = useRouter();
  const { config, project, org } = snapshot;
  const [newColumn, setNewColumn] = useState('');
  const [perEnvironment, setPerEnvironment] = useState(false);
  const [newProjectKey, setNewProjectKey] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const canConfig = can('project.config');

  /*
    Read from `me`, not from `permissions`.

    Creating a project is an organisation-wide act and the service requires the grant to be held
    organisation-wide, while `permissions` is the union of an org-wide role and a role on the
    open project. Checking `can('project.create')` here would draw the form for somebody the
    service is about to refuse, which is the exact failure gating exists to avoid.
  */
  const canCreateProjects = snapshot.me.can_create_projects;

  /**
   * Creates a project and lands on its Configure screen.
   *
   * Sends a name as well as a key, which the version in the header switcher did not — that one
   * sent `{ key }` alone against a handler reading `(key, name, description)`, so every click
   * failed on a NOT NULL column. The key doubles as the name when nothing is typed, because a
   * project called CR_AUTOMATION is a perfectly good answer and forcing a second field before
   * anything exists is friction for its own sake.
   */
  async function createProject() {
    const key = newProjectKey.trim().toUpperCase();
    if (!key) return;

    const result = await apply(null, () =>
      send<Snapshot>('/api/v1/projects', 'POST', {
        key,
        name: newProjectName.trim() || key,
        description: '',
      }),
    );
    if (!result) return;

    setNewProjectKey('');
    setNewProjectName('');
    setNotice(
      `${key} created, empty. Switch to it in the header, then set its deliverable columns here — a project arrives with no process of its own.`,
    );
    router.refresh();
  }

  return (
    <div className="page page-narrow">
      <PageTitle
        title={`Configure — ${project.key}`}
        lede="What a project admin sets. Another team stands up its own process here without a code change."
      />

      {/*
        Projects first, because it is the only thing on this screen that is not about the project
        currently open — and because this is where the header switcher's broken NEW_PROJECT_KEY
        box went. Shown to everybody rather than hidden from most: somebody looking for it should
        find out where it lives and why they cannot use it, not conclude the feature was removed.
      */}
      <Blueprint style={{ marginBottom: 'var(--space-8)' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 'var(--space-3)',
            marginBottom: 'var(--space-3)',
            flexWrap: 'wrap',
          }}
        >
          <h4 className="section-heading" style={{ margin: 0 }}>
            Projects in {org.name}
          </h4>
          <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
            {snapshot.projects.length}{' '}
            {snapshot.projects.length === 1 ? 'project you can open' : 'projects you can open'}
          </span>
        </div>

        <div
          style={{
            fontSize: 12,
            color: 'var(--color-neutral-700)',
            marginBottom: 'var(--space-3)',
            textWrap: 'pretty',
          }}
        >
          A new project arrives empty — no columns, no modules, no process. It belongs to{' '}
          {org.name} rather than to any project, so creating one needs{' '}
          <span className="mono">project.create</span> across the whole organisation: an
          organisation administrator or a super admin. Holding it on one project is not enough,
          because that says nothing about the organisation.
        </div>

        {canCreateProjects ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void createProject();
            }}
            style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}
          >
            <input
              className="input"
              style={{ width: 200 }}
              value={newProjectKey}
              onChange={(event) => setNewProjectKey(event.target.value.toUpperCase())}
              placeholder="NEW_PROJECT_KEY"
              aria-label="New project key"
            />
            <input
              className="input"
              style={{ width: 240 }}
              value={newProjectName}
              onChange={(event) => setNewProjectName(event.target.value)}
              placeholder="Name (defaults to the key)"
              aria-label="New project name"
            />
            <button type="submit" className="btn btn-secondary" disabled={!newProjectKey.trim()}>
              Create project
            </button>
            <span
              style={{
                fontSize: 12,
                color: 'var(--color-neutral-600)',
                alignSelf: 'center',
                textWrap: 'pretty',
              }}
            >
              Uppercase letters, digits and underscores, starting with a letter.
            </span>
          </form>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--color-neutral-600)', textWrap: 'pretty' }}>
            You do not administer {org.name}, so you cannot create a project here. A super admin
            can also create one for any organisation from the platform console.
          </div>
        )}
      </Blueprint>

      <Blueprint style={{ marginBottom: 'var(--space-8)' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 'var(--space-3)',
            marginBottom: 'var(--space-4)',
            flexWrap: 'wrap',
          }}
        >
          <h4 className="section-heading" style={{ margin: 0 }}>
            Deliverable columns
          </h4>
          <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
            each column uses its own subset of the shared status vocabulary
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {deliverableGroups(config.columns).map((group) => (
            <div
              key={group.key}
              style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-3) var(--space-4)' }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 'var(--space-3)',
                  marginBottom: 'var(--space-2)',
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                  <span
                    style={{
                      fontFamily: 'var(--font-heading)',
                      fontSize: 14,
                      letterSpacing: '.06em',
                      textTransform: 'uppercase',
                    }}
                  >
                    {group.label}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>{group.subtitle}</span>
                </div>
                <span style={{ fontSize: 11, color: 'var(--color-neutral-600)', whiteSpace: 'nowrap' }}>
                  {group.countsSummary}
                </span>
              </div>

              {group.members.map((member, index) => (
                <div
                  key={member.key}
                  style={{
                    padding: 'var(--space-2) 0',
                    borderTop: index === 0 ? 'none' : '1px solid var(--color-divider)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
                    <div
                      style={{
                        width: 90,
                        flex: 'none',
                        fontSize: 13,
                        paddingTop: 3,
                        // A hidden column is still listed — it is how you find it to bring
                        // it back, and its cells are still there behind it.
                        opacity: member.active ? 1 : 0.5,
                      }}
                    >
                      {group.members.length > 1 ? member.label : columnDisplayLabel(member)}
                      {member.active ? null : (
                        <div style={{ fontSize: 11, color: 'var(--color-neutral-600)', textWrap: 'pretty' }}>
                          hidden
                        </div>
                      )}
                    </div>

                    <div style={{ flex: '1 1 260px', minWidth: 220 }}>
                      <StatusSetEditor column={member} />
                    </div>

                    <div style={{ display: 'flex', gap: 2, alignSelf: 'flex-start' }}>
                      {(['informational', 'counts'] as const).map((mode) => {
                        const active = mode === 'counts' ? member.counts : !member.counts;
                        return (
                          <button
                            key={mode}
                            type="button"
                            disabled={!canConfig}
                            aria-pressed={active}
                            title={
                              canConfig
                                ? 'Whether this column enters the readiness percentage'
                                : reasonFor('project.config')
                            }
                            onClick={() =>
                              void apply(null, () =>
                                send<Snapshot>(`/api/v1/config/columns/${member.key}`, 'PATCH', {
                                  counts: mode === 'counts',
                                }),
                              )
                            }
                            style={{
                              fontSize: 12,
                              color: active ? 'var(--color-text)' : 'var(--color-neutral-500)',
                              border: `1px solid ${active ? 'var(--color-neutral-400)' : 'var(--color-neutral-300)'}`,
                              borderRadius: 0,
                              background: active ? 'var(--color-accent-100)' : 'transparent',
                              padding: '1px 8px',
                              cursor: canConfig ? 'pointer' : 'not-allowed',
                            }}
                          >
                            {mode}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      disabled={!canConfig}
                      title={canConfig ? undefined : reasonFor('project.config')}
                      onClick={() =>
                        void apply(null, () => send<Snapshot>(`/api/v1/config/columns/${member.key}`, 'DELETE'))
                      }
                      style={{
                        fontSize: 12,
                        color: 'var(--color-neutral-600)',
                        border: 0,
                        background: 'transparent',
                        cursor: canConfig ? 'pointer' : 'not-allowed',
                      }}
                    >
                      remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/*
          This form used to POST { name } while the service expected { key, label, full,
          allowed } — so every "Add column" was a 400 that read as a validation failure on a
          field the screen does not have. The same class of mismatch as the project switcher and
          the config-list remove: two halves of one contract, written apart.

          It also now offers the shape the seed data had and no screen could make: one
          deliverable tracked separately on every environment, as a header with a column under
          it per environment.
        */}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const typed = newColumn.trim();
            if (!typed) return;

            // The key is derived, never typed. It ends up in every cell row and in the drift
            // table, so letting somebody type "FILE CR " would be a spelling to live with.
            const key = typed.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
            if (!key) return;

            void apply(
              null,
              () =>
                perEnvironment
                  ? send<Snapshot>('/api/v1/config/columns/grouped', 'POST', {
                      group_key: key,
                      group_label: typed.slice(0, 12).toUpperCase(),
                      full: typed,
                      allowed: [...STATUS_SETS.load],
                    })
                  : send<Snapshot>('/api/v1/config/columns', 'POST', {
                      key,
                      label: typed.slice(0, 12).toUpperCase(),
                      full: typed,
                      allowed: [...STATUS_SETS.simple],
                      counts: true,
                    }),
            ).then((result) => {
              if (result) setNewColumn('');
            });
          }}
          style={{
            display: 'flex',
            gap: 'var(--space-2)',
            marginTop: 'var(--space-4)',
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <input
            className="input"
            style={{ width: 240 }}
            value={newColumn}
            onChange={(event) => setNewColumn(event.target.value)}
            placeholder="New column, e.g. SMOKE TEST"
            aria-label="New column name"
          />
          <label
            style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
            title="Lab, preprod and prod are not a sequence — prod can be loaded while lab never was, because lab was down when the window opened. One status per deliverable cannot say that."
          >
            <input
              type="checkbox"
              checked={perEnvironment}
              onChange={(event) => setPerEnvironment(event.target.checked)}
              disabled={config.environments.length === 0}
            />
            track it per environment
          </label>
          <button
            type="submit"
            className="btn btn-secondary"
            disabled={!canConfig}
            title={canConfig ? undefined : reasonFor('project.config')}
          >
            {perEnvironment ? 'Add deliverable' : 'Add column'}
          </button>
          <span
            style={{
              fontSize: 12,
              color: 'var(--color-neutral-600)',
              flexBasis: '100%',
              textWrap: 'pretty',
            }}
          >
            {config.environments.length === 0
              ? 'This project has no environments configured, so a deliverable cannot be spread across them yet.'
              : perEnvironment
                ? `One header with ${config.environments.length} columns under it — ${config.environments
                    .map((environment) => environment.short)
                    .join(', ')} — and only prod counts toward readiness. A lab tick records where something has been; it is not part of the definition of done.`
                : 'One column, counting toward readiness. Adjust its statuses in the table above once it exists.'}
          </span>
        </form>
      </Blueprint>

      <div
        className="split"
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 'var(--space-8)',
          alignItems: 'start',
        }}
      >
        <ConfigSet
          title={words.module.many}
          hint="more will come"
          list="modules"
          placeholder="e.g. HSS"
          values={config.module_names.map((name) => ({ key: name, label: name }))}
        />
        <ConfigSet
          title="Pipeline stages"
          hint="board columns"
          list="stages"
          placeholder="New stage name"
          values={config.stages.map((stage) => ({ key: stage.id, label: stage.label }))}
        />
        <ConfigSet
          title="Owners"
          hint="who can be assigned"
          list="owners"
          placeholder="Name"
          values={config.owners.map((owner) => ({ key: owner, label: owner }))}
        />
        <ConfigSet
          title="Link types"
          hint={`attachable to a ${words.subModule.lower}`}
          list="link_types"
          placeholder="e.g. Test report"
          values={config.link_types.map((type) => ({ key: type, label: type }))}
        />

        <Environments environments={config.environments} columns={config.columns} />

        <WordingPanel />

        <StepsPanel />

        <div style={{ gridColumn: '1 / -1' }}>
          <Blueprint>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 'var(--space-3)',
                marginBottom: 'var(--space-4)',
                flexWrap: 'wrap',
              }}
            >
              <h4 className="section-heading" style={{ margin: 0 }}>
                Status vocabulary
              </h4>
              <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
                shared across the project — columns pick from it
              </span>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
                gap: 'var(--space-3)',
              }}
            >
              {Object.entries(STATUS_VOCABULARY).map(([key, entry]) => {
                const tone = TONE_STYLE[entry.tone];
                return (
                  <div
                    key={key}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-3)',
                      border: '1px solid var(--color-divider)',
                      padding: 'var(--space-2) var(--space-3)',
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 22,
                        height: 22,
                        flex: 'none',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 12,
                        background: tone.bg,
                        color: tone.fg,
                        border: `1px solid ${tone.border}`,
                      }}
                    >
                      {entry.mark}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13 }}>{entry.label}</div>
                      <div style={{ fontSize: 11, color: 'var(--color-neutral-600)' }}>
                        {TONE_DESCRIPTION[entry.tone]}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Blueprint>
        </div>

        <div
          style={{
            gridColumn: '1 / -1',
            border: '1px dashed var(--color-neutral-400)',
            padding: 'var(--space-6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-6)',
            flexWrap: 'wrap',
          }}
        >
          <div>
            <h4 className="section-heading" style={{ margin: '0 0 var(--space-1)' }}>
              Super admin
            </h4>
            <div
              style={{
                fontSize: 13,
                color: 'var(--color-neutral-700)',
                maxWidth: '70ch',
                textWrap: 'pretty',
              }}
            >
              Creating organisations, onboarding project admins and assigning them to projects sits
              one level above this screen. Out of scope for the {project.key} release — the model is
              built, the screen is not.
            </div>
          </div>
          <span
            style={{
              fontFamily: 'var(--font-heading)',
              fontSize: 14,
              letterSpacing: '.1em',
              textTransform: 'uppercase',
              color: 'var(--color-neutral-600)',
              flex: 'none',
            }}
          >
            Later
          </span>
        </div>
      </div>
    </div>
  );
}
