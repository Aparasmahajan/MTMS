'use client';

import { useMemo, useState } from 'react';
import { useTracker } from '@/components/TrackerProvider';
import { Blueprint, EmptyRow } from '@/components/primitives';
import { send } from '@/lib/client/api';
import type { Snapshot, StepDefinitionView, StepListView } from '@/lib/shared/views';

/**
 * Steps, on the Configure screen — the library and the checklists built from it.
 *
 * Three things are kept apart here, and keeping them apart is the whole feature:
 *
 * 1. **The library.** Each step is written once, with the roles allowed to tick it.
 * 2. **A checklist.** A named, ordered list of those steps, attached to one sub-module or
 *    sub-activity. The order lives on the list, not on the step, so the same step is first
 *    in one checklist and third in another.
 * 3. **What happened.** Ticks, blocks and comments, recorded against the checklist. None of
 *    that is edited here; it is read on the sub-module screen where the work is done.
 *
 * Nothing on this screen destroys a record. Retiring a step hides it and keeps its history;
 * removing a step from a checklist is refused once anything has been ticked on it, because
 * that one really would take the record with it.
 */

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

export function StepsPanel() {
  return (
    <div style={{ gridColumn: '1 / -1', display: 'grid', gap: 'var(--space-6)' }}>
      <StepLibrary />
      <Checklists />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------

function StepLibrary() {
  const { snapshot, apply, can, reasonFor } = useTracker();
  const canConfig = can('project.config');
  // A hidden role cannot gate a step — it is offered nowhere, and a step gated to one reads as
  // needing a role nobody can be given.
  const roles = snapshot.roles.filter((role) => !role.hidden);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);

  function toggleRole(id: string) {
    setRoleIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  return (
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
          Step library
        </h4>
        <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
          written once, used on any checklist
        </span>
      </div>

      <div className="bordered">
        {snapshot.step_library.length === 0 ? (
          <EmptyRow>
            No steps yet. A step is one thing somebody has to do and one role that says it is
            done — &ldquo;Received CIQ&rdquo; ticked by SME or Product, &ldquo;Testing
            done&rdquo; ticked by QA.
          </EmptyRow>
        ) : null}

        {snapshot.step_library.map((step) =>
          editing === step.id ? (
            <StepEditor key={step.id} step={step} onDone={() => setEditing(null)} />
          ) : (
            <div
              key={step.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 'var(--space-3)',
                padding: 'var(--space-3) var(--space-4)',
                borderBottom: '1px solid var(--color-divider)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13 }}>{step.name}</div>
                {step.description ? (
                  <div style={{ fontSize: 12, color: 'var(--color-neutral-700)', textWrap: 'pretty' }}>
                    {step.description}
                  </div>
                ) : null}
                <div style={{ fontSize: 11, color: 'var(--color-neutral-600)', marginTop: 2 }}>
                  {/*
                    A step naming no role can be ticked by nobody — which is the safe direction
                    and needs saying out loud, because it looks like an oversight until you know
                    it is deliberate.
                  */}
                  {step.role_names.length
                    ? `${step.role_names.join(' or ')} ticks this`
                    : 'no role names it — nobody can tick it until one does'}
                  {step.used_in > 0
                    ? ` · on ${step.used_in} ${step.used_in === 1 ? 'checklist' : 'checklists'}`
                    : ' · not on any checklist yet'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-3)', flex: 'none' }}>
                <button
                  type="button"
                  disabled={!canConfig}
                  title={canConfig ? undefined : reasonFor('project.config')}
                  onClick={() => setEditing(step.id)}
                  style={quietAction(canConfig)}
                >
                  edit
                </button>
                <button
                  type="button"
                  disabled={!canConfig}
                  title={
                    canConfig
                      ? `Retire ${step.name}. It leaves every checklist and keeps its history and comments.`
                      : reasonFor('project.config')
                  }
                  onClick={() => {
                    if (
                      !window.confirm(
                        `Retire "${step.name}"?\n\nIt leaves every checklist it is on. Everything ` +
                          'already ticked, blocked or written about it is kept.',
                      )
                    ) {
                      return;
                    }
                    void apply(null, () =>
                      send<Snapshot>(`/api/v1/steps/library/${step.id}`, 'DELETE'),
                    );
                  }}
                  style={quietAction(canConfig)}
                >
                  retire
                </button>
              </div>
            </div>
          ),
        )}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            void apply(null, () =>
              send<Snapshot>('/api/v1/steps/library', 'POST', {
                name: name.trim(),
                description: description.trim(),
                role_ids: roleIds,
              }),
            ).then((result) => {
              if (result) {
                setName('');
                setDescription('');
                setRoleIds([]);
              }
            });
          }}
          style={{ padding: 'var(--space-3) var(--space-4)', display: 'grid', gap: 'var(--space-2)' }}
        >
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <input
              className="input"
              style={{ flex: 1, minWidth: 180 }}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="New step, e.g. Received CIQ"
              aria-label="New step name"
            />
            <input
              className="input"
              style={{ flex: 1, minWidth: 180 }}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What it means (optional)"
              aria-label="New step description"
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!canConfig}
              title={canConfig ? undefined : reasonFor('project.config')}
            >
              Add step
            </button>
          </div>
          <RolePicker roles={roles} selected={roleIds} onToggle={toggleRole} />
        </form>
      </div>
    </Blueprint>
  );
}

function StepEditor({ step, onDone }: { step: StepDefinitionView; onDone: () => void }) {
  const { snapshot, apply } = useTracker();
  const [name, setName] = useState(step.name);
  const [description, setDescription] = useState(step.description);
  const [roleIds, setRoleIds] = useState<string[]>(step.role_ids);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void apply(null, () =>
          send<Snapshot>(`/api/v1/steps/library/${step.id}`, 'PATCH', {
            name: name.trim(),
            description: description.trim(),
            role_ids: roleIds,
          }),
        ).then((result) => {
          if (result) onDone();
        });
      }}
      style={{
        padding: 'var(--space-3) var(--space-4)',
        borderBottom: '1px solid var(--color-divider)',
        display: 'grid',
        gap: 'var(--space-2)',
        background: 'var(--color-accent-100)',
      }}
    >
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <input
          className="input"
          autoFocus
          style={{ flex: 1, minWidth: 180 }}
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-label={`Rename ${step.name}`}
        />
        <input
          className="input"
          style={{ flex: 1, minWidth: 180 }}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          aria-label={`Description of ${step.name}`}
        />
        <button type="submit" className="btn btn-primary">
          Save
        </button>
        <button type="button" className="btn btn-secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
      <RolePicker
        roles={snapshot.roles.filter((role) => !role.hidden)}
        selected={roleIds}
        onToggle={(id) =>
          setRoleIds((current) =>
            current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
          )
        }
      />
      {/*
        Narrowing the roles never touches what has already been recorded. Worth saying here,
        where somebody is about to narrow them and might reasonably fear otherwise.
      */}
      <div style={{ fontSize: 11, color: 'var(--color-neutral-700)', textWrap: 'pretty' }}>
        Changing who may tick this does not erase anything already ticked. A settings change is
        not evidence that the work did not happen.
      </div>
    </form>
  );
}

function RolePicker({
  roles,
  selected,
  onToggle,
}: {
  roles: { id: string; name: string }[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
      <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>who may tick it:</span>
      {roles.map((role) => (
        <button
          key={role.id}
          type="button"
          className="chip"
          aria-pressed={selected.includes(role.id)}
          onClick={() => onToggle(role.id)}
        >
          {role.name}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Checklists
// ---------------------------------------------------------------------------

/**
 * Where a checklist can be attached.
 *
 * Sub-modules and their sub-activities. Module-level checklists exist in the model — a module
 * with no sub-modules should hold its own — but a module reaches this screen as a name with no
 * id, so there is nothing to attach one to yet. See `StepUseCases`.
 */
function Checklists() {
  const { snapshot, apply, can, reasonFor, words } = useTracker();
  const canConfig = can('project.config');

  const targets = useMemo(() => {
    const options: {
      key: string;
      label: string;
      scopeType: string;
      scopeId: string;
      /** Null for a sub-activity: "apply to all" spreads across one module's sub-modules. */
      moduleName: string | null;
      lists: StepListView[];
    }[] = [];
    for (const subModule of snapshot.sub_modules) {
      options.push({
        key: `sub_module:${subModule.id}`,
        label: `${subModule.module_name} · ${subModule.name}`,
        scopeType: 'sub_module',
        scopeId: subModule.id,
        moduleName: subModule.module_name,
        lists: subModule.step_lists,
      });
      for (const subActivity of subModule.sub_activities) {
        options.push({
          key: `sub_activity:${subActivity.id}`,
          label: `${subModule.module_name} · ${subModule.name} → ${subActivity.name}`,
          scopeType: 'sub_activity',
          scopeId: subActivity.id,
          moduleName: null,
          lists: subActivity.step_lists,
        });
      }
    }
    return options;
  }, [snapshot.sub_modules]);

  const [targetKey, setTargetKey] = useState('');
  const [listName, setListName] = useState('');
  const [enforceOrder, setEnforceOrder] = useState(false);

  const target = targets.find((option) => option.key === targetKey) ?? targets[0];

  return (
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
          Checklists
        </h4>
        <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
          a named, ordered list of steps, attached to one thing
        </span>
      </div>

      {targets.length === 0 ? (
        <div className="bordered">
          <EmptyRow>
            Nothing to attach a checklist to yet — add a {words.subModule.lower} first.
          </EmptyRow>
        </div>
      ) : (
        <>
          <label htmlFor="checklist-target" style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
            {words.subModule.one} or {words.subActivity.lower}
          </label>
          <select
            id="checklist-target"
            className="input"
            style={{ width: '100%', marginTop: 'var(--space-1)', marginBottom: 'var(--space-4)' }}
            value={target?.key ?? ''}
            onChange={(event) => setTargetKey(event.target.value)}
          >
            {targets.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
                {option.lists.length ? ` — ${option.lists.length} checklist${option.lists.length === 1 ? '' : 's'}` : ''}
              </option>
            ))}
          </select>

          {target?.lists.length === 0 ? (
            <div className="bordered" style={{ marginBottom: 'var(--space-4)' }}>
              <EmptyRow>Nothing attached here yet.</EmptyRow>
            </div>
          ) : null}

          {target?.lists.map((list) => (
            <ChecklistEditor key={list.id} list={list} moduleName={target.moduleName} />
          ))}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!listName.trim() || !target) return;
              void apply(null, () =>
                send<Snapshot>('/api/v1/steps/lists', 'POST', {
                  scope_type: target.scopeType,
                  scope_id: target.scopeId,
                  name: listName.trim(),
                  enforce_order: enforceOrder,
                  step_ids: [],
                }),
              ).then((result) => {
                if (result) setListName('');
              });
            }}
            style={{
              display: 'flex',
              gap: 'var(--space-2)',
              alignItems: 'center',
              flexWrap: 'wrap',
              marginTop: 'var(--space-4)',
            }}
          >
            <input
              className="input"
              style={{ flex: 1, minWidth: 180 }}
              value={listName}
              onChange={(event) => setListName(event.target.value)}
              placeholder="New checklist, e.g. config1"
              aria-label="New checklist name"
            />
            <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <input
                type="checkbox"
                checked={enforceOrder}
                onChange={(event) => setEnforceOrder(event.target.checked)}
              />
              strict order
            </label>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!canConfig}
              title={canConfig ? undefined : reasonFor('project.config')}
            >
              Add checklist
            </button>
          </form>
          <div
            style={{
              marginTop: 'var(--space-2)',
              fontSize: 11,
              color: 'var(--color-neutral-700)',
              textWrap: 'pretty',
            }}
          >
            Strict order means a step cannot be ticked until the ones before it are done. Leave it
            off when the steps are genuinely independent — forcing a sequence onto work that has
            none makes people tick boxes in an order they did not work in.
          </div>
        </>
      )}
    </Blueprint>
  );
}

/**
 * @param moduleName the module this checklist's sub-module sits on, when it sits on one. It is
 *     what "apply to all" spreads across; a sub-activity's checklist has none, so it does not
 *     get the button.
 */
function ChecklistEditor({ list, moduleName }: { list: StepListView; moduleName: string | null }) {
  const { snapshot, apply, setNotice } = useTracker();
  const [adding, setAdding] = useState('');

  const available = snapshot.step_library.filter(
    (step) => !list.entries.some((entry) => entry.definition_id === step.id),
  );

  /** Moves one entry up or down by rewriting the whole order — the API takes the full list. */
  function move(index: number, by: number) {
    const ids = list.entries.map((entry) => entry.id);
    const next = index + by;
    if (next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next] as string, ids[index] as string];
    void apply(null, () =>
      send<Snapshot>(`/api/v1/steps/lists/${list.id}/order`, 'PATCH', { entry_ids: ids }),
    );
  }

  return (
    <div className="bordered" style={{ marginBottom: 'var(--space-4)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          padding: 'var(--space-3) var(--space-4)',
          borderBottom: '1px solid var(--color-divider)',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 14, flex: 1, minWidth: 0 }}>
          {list.name}
        </span>
        <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <input
            type="checkbox"
            checked={list.enforce_order}
            onChange={(event) =>
              void apply(null, () =>
                send<Snapshot>(`/api/v1/steps/lists/${list.id}`, 'PATCH', {
                  enforce_order: event.target.checked,
                }),
              )
            }
          />
          strict order
        </label>
        {/*
          The thing that decides whether this feature survives a real project. CR_AUTOMATION has
          eighteen sub-modules today and the real number is in the hundreds; nobody attaches a
          checklist to two hundred things one at a time, so without this it gets built on a
          handful of rows as a demonstration and then abandoned.
        */}
        {moduleName ? (
          <button
            type="button"
            title={`Copy this checklist onto every other ${moduleName} sub-module that does not already have one by this name`}
            onClick={async () => {
              if (
                !window.confirm(
                  `Apply "${list.name}" to every other sub-module on ${moduleName}?` +
                    ' Each gets its own copy, so ticking one does not tick the rest.' +
                    ' Anything that already has a checklist by this name is skipped,' +
                    ' and nothing is replaced.',
                )
              ) {
                return;
              }
              const meta = await apply(null, () =>
                send<Snapshot>(`/api/v1/steps/lists/${list.id}/apply`, 'POST', { module_name: moduleName }),
              );
              if (meta) {
                setNotice(
                  meta.applied === 0
                    ? `Nothing to do — every other sub-module on ${moduleName} already has a checklist called "${list.name}".`
                    : `Applied "${list.name}" to ${meta.applied} sub-module${meta.applied === 1 ? '' : 's'} on ${moduleName}.`,
                );
              }
            }}
            style={quietAction(true)}
          >
            apply to all
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => {
            if (
              !window.confirm(
                `Remove the checklist "${list.name}"?\n\nIt leaves the screens. Everything ticked, ` +
                  'blocked or written on it is kept.',
              )
            ) {
              return;
            }
            void apply(null, () => send<Snapshot>(`/api/v1/steps/lists/${list.id}`, 'DELETE'));
          }}
          style={quietAction(true)}
        >
          remove
        </button>
      </div>

      {list.entries.length === 0 ? <EmptyRow>No steps on this checklist yet.</EmptyRow> : null}

      {list.entries.map((entry, index) => (
        <div
          key={entry.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            padding: 'var(--space-2) var(--space-4)',
            borderBottom: '1px solid var(--color-divider)',
          }}
        >
          <span className="tabular" style={{ width: 20, flex: 'none', fontSize: 12, color: 'var(--color-neutral-600)' }}>
            {index + 1}
          </span>
          <span style={{ flex: 1, fontSize: 13, minWidth: 0, wordBreak: 'break-word' }}>{entry.name}</span>
          <span style={{ fontSize: 11, color: 'var(--color-neutral-600)', flex: 'none' }}>
            {entry.allowed_roles.join(' or ') || 'needs a role'}
          </span>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flex: 'none' }}>
            <button type="button" onClick={() => move(index, -1)} style={quietAction(index > 0)} disabled={index === 0}>
              ↑
            </button>
            <button
              type="button"
              onClick={() => move(index, 1)}
              style={quietAction(index < list.entries.length - 1)}
              disabled={index === list.entries.length - 1}
            >
              ↓
            </button>
            <button
              type="button"
              // The server refuses this once anything has been recorded, and says why. The
              // screen does not pre-empt that: it would have to reimplement the rule, and the
              // server's sentence is better than a greyed-out control with no explanation.
              onClick={() =>
                void apply(null, () => send<Snapshot>(`/api/v1/steps/entries/${entry.id}`, 'DELETE'))
              }
              style={quietAction(true)}
            >
              remove
            </button>
          </div>
        </div>
      ))}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!adding) return;
          void apply(null, () =>
            send<Snapshot>(`/api/v1/steps/lists/${list.id}/entries`, 'POST', { step_id: adding }),
          ).then((result) => {
            if (result) setAdding('');
          });
        }}
        style={{ display: 'flex', gap: 'var(--space-2)', padding: 'var(--space-3) var(--space-4)' }}
      >
        <select
          className="input"
          style={{ flex: 1 }}
          value={adding}
          onChange={(event) => setAdding(event.target.value)}
          aria-label={`Add a step to ${list.name}`}
        >
          <option value="">Add a step from the library…</option>
          {available.map((step) => (
            <option key={step.id} value={step.id}>
              {step.name}
            </option>
          ))}
        </select>
        <button type="submit" className="btn btn-secondary" disabled={!adding}>
          Add
        </button>
      </form>
    </div>
  );
}
