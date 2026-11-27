import { ApiError } from '@/lib/client/api';
import {
  clearSnapshot,
  loadSnapshot,
  loadWorkspace,
  purgeStaleKeys,
  saveSnapshot,
  saveWorkspace,
} from '@/lib/demo/persistence';
import {
  blankProjectSnapshot,
  demoPlatformView,
  projectSummaries,
  seedWorkspace,
  type DemoWorkspace,
} from '@/lib/demo/workspace';
import { optimisticAdvance, withDerived } from '@/lib/client/optimistic';
import {
  DEFECT_STATUS_ORDER,
  PROD_ENVIRONMENT,
  type DefectStatus,
} from '@/lib/shared/domain';
import { hasPermission, permissionDeniedReason, type PermissionKey } from '@/lib/shared/permissions';
import { promotionGate } from '@/lib/shared/promotion';
import {
  BLANK,
  isStatusKey,
  readiness,
  rollUp,
  statusEntry,
  STATUS_SETS,
  toneOf,
} from '@/lib/shared/vocabulary';
import { columnTimings, reconcileModules, stepGate, stepTimings } from '@/lib/shared/derive';
import type {
  CellView,
  ColumnView,
  ModuleView,
  NotificationView,
  OwnerGroupView,
  StepDefinitionView,
  StepEntryView,
  StepListView,
  SubModuleView,
  Snapshot,
  SubActivityView,
  ThreadCommentView,
  ThreadView,
} from '@/lib/shared/views';

/**
 * The demo's stand-in for the server.
 *
 * `lib/client/api.ts` sends every request here instead of over HTTP when `IS_DEMO`, so
 * no screen knows the difference. This is a reducer over the `Snapshot`, holding it in
 * module state and returning the new one exactly as a route handler would.
 *
 * What it shares with the real server, and what it does not:
 *
 * - **Shares the rules.** Readiness, the subactivity roll-up, stage bucketing and the
 *   click-to-advance cycle all come from `lib/shared/vocabulary.ts`, and the derived
 *   fields are recomputed by `withDerived` — the same functions `lib/server/service.ts`
 *   uses. A demo cannot therefore show a readiness figure the real app would not.
 * - **Mirrors the permission checks**, so the role switcher genuinely gates the UI. In
 *   the demo these are a presentation choice, not a security boundary; the real
 *   guarantee is the server-side check, which is what `lib/server/service.ts` is for.
 * - **Duplicates the bookkeeping.** Pushing a defect, appending an audit row, toggling a
 *   grant. If you add a mutation to the server, add it here too or the demo drifts.
 *   `npm run build:demo` fails loudly on an unhandled path rather than silently no-oping.
 */

let current: Snapshot | null = null;

/**
 * Everything above one project: the other projects' snapshots, and the organisations and
 * administrators the super admin console reads. `current` stays the snapshot every
 * project screen renders, so nothing below this line had to learn about the workspace.
 */
let workspace: DemoWorkspace | null = null;

export function demoWorkspace(): DemoWorkspace {
  if (!workspace) throw new ApiError('internal', 'The demo has not been started.', 500);
  return workspace;
}

export function initDemoRuntime(snapshot: Snapshot): void {
  if (current) return;

  // Earlier builds' keys are never read again; left alone they fill the quota.
  purgeStaleKeys();

  // Anything this browser saved earlier wins over the baked seed — that is what makes an
  // edit survive a reload. Falling back to a deep copy of the seed keeps the prerendered
  // snapshot itself unmutated, so a client-side navigation back to a static page still
  // renders what was built.
  // Re-derived on the way in: the role-dependent fields (who may tick what) and the
  // figures are recomputed rather than trusted from whatever was saved.
  current = rederive(loadSnapshot() ?? structuredCloneish(snapshot));

  // The workspace is rebuilt from the seed when this browser has none, and the current
  // snapshot is folded back into it so a restored edit is not lost behind a fresh copy.
  workspace = loadWorkspace() ?? seedWorkspace(snapshot);
  workspace.snapshots[current.project.id] = current;
  workspace.current_project_id = current.project.id;
}

/**
 * The signed-in person, as this tab holds them.
 *
 * The role is the role switcher's, and the switcher is per tab: a snapshot arriving from
 * another tab carries whichever role *that* tab was showing, and adopting it would flip this
 * tab's permissions under the person looking at it.
 */
function keepMyRole(incoming: Snapshot): Snapshot {
  if (!current) return incoming;
  return {
    ...incoming,
    me: {
      ...incoming.me,
      role_names: current.me.role_names,
      permissions: current.me.permissions,
    },
  };
}

/**
 * Adopts a snapshot produced by another tab.
 *
 * Updating `current` is the part that matters and the part that is easy to miss: without
 * it this tab would re-render the incoming state but still hold its own stale copy, and
 * the next click here would be applied to the old snapshot and silently undo the other
 * tab's change.
 */
export function adoptSnapshot(snapshot: Snapshot): Snapshot | null {
  // Another tab working on a *different* project is not a reason for this one to switch.
  // That project's copy is kept current in the workspace, and this tab carries on.
  if (current && snapshot.project.id !== current.project.id) {
    if (workspace) workspace.snapshots[snapshot.project.id] = snapshot;
    return null;
  }

  current = rederive(keepMyRole(snapshot));
  if (workspace) {
    workspace.snapshots[current.project.id] = current;
    workspace.current_project_id = current.project.id;
  }
  return current;
}

/**
 * Adopts the workspace another tab just saved — a project or an organisation created there.
 *
 * This tab's own project is kept as this tab holds it (the snapshot channel keeps that in
 * step separately), and the switcher is re-derived so the new project appears in it now
 * rather than after a reload.
 */
export function adoptWorkspace(incoming: DemoWorkspace): Snapshot | null {
  if (!current) return null;
  workspace = incoming;
  workspace.snapshots[current.project.id] = current;
  workspace.current_project_id = current.project.id;
  current = { ...current, projects: projectSummaries(workspace, current.org.id) };
  workspace.snapshots[current.project.id] = current;
  return current;
}

/**
 * Reset pressed in another tab. Everything there is already cleared from storage; this tab
 * only has to drop what it holds in memory — and must not clear or broadcast again, or two
 * tabs would reset each other in a loop.
 */
export function resetDemoLocally(seed: Snapshot): Snapshot {
  current = rederive(structuredCloneish(seed));
  workspace = seedWorkspace(seed);
  workspace.snapshots[current.project.id] = current;
  return current;
}

/**
 * Picks up what other tabs have saved since this one last looked.
 *
 * Storage is synchronous and shared, so reading it immediately before a write closes the
 * window in which this tab would write back its own older workspace — and delete a project
 * another tab created a moment ago, before that tab's channel message had arrived.
 */
function refreshWorkspaceFromStorage(): void {
  if (!current) return;
  const stored = loadWorkspace();
  if (!stored) return;
  workspace = stored;
  workspace.snapshots[current.project.id] = current;
  workspace.current_project_id = current.project.id;
}

export function demoSnapshot(): Snapshot {
  if (!current) throw new ApiError('internal', 'The demo has not been started.', 500);
  return current;
}

/** Puts the demo back to the seeded state, and forgets what was saved. */
export function resetDemo(seed: Snapshot): Snapshot {
  current = rederive(structuredCloneish(seed));
  workspace = seedWorkspace(seed);
  workspace.snapshots[current.project.id] = current;
  clearSnapshot();
  saveSnapshot(current);
  saveWorkspace(workspace);
  return current;
}

function structuredCloneish<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T);
}

/** `crypto.randomUUID` needs a secure context, and a demo may be opened from file://. */
function newId(): string {
  const cryptoRef = globalThis.crypto as Crypto | undefined;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

// ---------------------------------------------------------------------------
// Helpers shared by the handlers
// ---------------------------------------------------------------------------

function must(snapshot: Snapshot, key: PermissionKey): void {
  if (!hasPermission(new Set(snapshot.me.permissions), key)) {
    throw new ApiError('forbidden', permissionDeniedReason(key), 403);
  }
}

function moduleOf(snapshot: Snapshot, id: string): SubModuleView {
  const module = snapshot.sub_modules.find((candidate) => candidate.id === id);
  if (!module) throw new ApiError('not_found', 'That module is not in this project.', 404);
  return module;
}

function audited(
  snapshot: Snapshot,
  entry: {
    scope: 'cell' | 'module' | 'project';
    label: string;
    what: string;
    moduleId?: string | null;
  },
): Snapshot {
  const module = entry.moduleId
    ? snapshot.sub_modules.find((candidate) => candidate.id === entry.moduleId)
    : undefined;

  return {
    ...snapshot,
    audit: [
      {
        id: newId(),
        scope: entry.scope,
        sub_module_id: entry.moduleId ?? null,
        sub_module_label: module ? `${module.module_name} · ${module.name}` : '—',
        label: entry.label,
        what: entry.what,
        who: snapshot.me.display_name,
        at: new Date().toISOString(),
      },
      ...snapshot.audit,
    ],
  };
}

function replaceModule(snapshot: Snapshot, next: SubModuleView): Snapshot {
  return {
    ...snapshot,
    sub_modules: snapshot.sub_modules.map((module) => (module.id === next.id ? next : module)),
  };
}

function blankCells(snapshot: Snapshot): CellView[] {
  return snapshot.config.columns.map((column) => ({
    column_key: column.key,
    status: BLANK,
    rolled_up: false,
    sub_activity_count: 0,
    changed_by: null,
    changed_at: null,
  }));
}

/** Re-derives a module's own cells from its sub_activities, then everything downstream. */
function reroll(snapshot: Snapshot, module: SubModuleView): SubModuleView {
  const subs = module.sub_activities;
  const cells: CellView[] = module.cells.map((cell) =>
    subs.length === 0
      ? { ...cell, rolled_up: false, sub_activity_count: 0 }
      : {
          ...cell,
          rolled_up: true,
          sub_activity_count: subs.length,
          changed_by: null,
          changed_at: null,
          status: rollUp(
            subs.map(
              (sub) => sub.cells.find((entry) => entry.column_key === cell.column_key)?.status ?? BLANK,
            ),
          ),
        },
  );

  return withDerived(
    { ...module, cells },
    snapshot.config.columns,
    snapshot.config.stages.length,
  );
}

function subReadiness(snapshot: Snapshot, cells: readonly CellView[]): number {
  const counted = snapshot.config.columns.filter((column) => column.counts && column.active);
  return readiness(
    counted.map((column) => cells.find((cell) => cell.column_key === column.key)?.status ?? BLANK),
  );
}

/**
 * Cells holding a status their column no longer allows. Blanks never count — a blank is
 * not a status, so it cannot be outside a vocabulary.
 */
function recountOffVocabulary(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    config: {
      ...snapshot.config,
      columns: snapshot.config.columns.map((column) => {
        let off = 0;
        for (const module of snapshot.sub_modules) {
          const rows: readonly { cells: CellView[] }[] =
            module.sub_activities.length > 0 ? module.sub_activities : [module];
          for (const row of rows) {
            const status = row.cells.find((cell) => cell.column_key === column.key)?.status;
            if (status && status !== BLANK && !column.allowed.includes(status)) off++;
          }
        }
        return { ...column, off_vocabulary: off };
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// The route table
// ---------------------------------------------------------------------------

type Body = Record<string, unknown>;
type Result = { data: Snapshot; meta: Record<string, unknown> };

/** Matches `/api/v1/modules/<id>/fni` against `modules/:id/fni`. */
function match(path: string, pattern: string): Record<string, string> | null {
  const parts = path.replace(/^\/api\/v1\//, '').split('?')[0]!.split('/');
  const wanted = pattern.split('/');
  if (parts.length !== wanted.length) return null;

  const params: Record<string, string> = {};
  for (let index = 0; index < wanted.length; index++) {
    const segment = wanted[index]!;
    const actual = parts[index]!;
    if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(actual);
    else if (segment !== actual) return null;
  }
  return params;
}

export function demoRequest(
  path: string,
  method: string,
  body: Body,
): { data: unknown; meta: Record<string, unknown> } {
  // Signing in happens before there is a project to render, so these answer without one.
  const session = routeSession(path, method);
  if (session) return session;

  refreshWorkspaceFromStorage();
  const snapshot = demoSnapshot();

  // The super admin console is above the project line: it answers with a `PlatformView`,
  // not a `Snapshot`, so it never enters the pipeline below — there is no drift gate to
  // recompute and no project snapshot to persist.
  if (path.startsWith('/api/v1/platform/')) {
    const result = routePlatform(snapshot, path, method, body);
    saveWorkspace(demoWorkspace());
    return result;
  }

  const next = route(snapshot, path, method, body);

  // Everything derived — the promotion gate, the module figures, both timing panels, who may
  // tick which step — recomputed after every request with the functions the server
  // projection uses, so nothing on screen stays frozen at the build-time numbers.
  const data = rederive(next.data);

  current = data;

  // The single write point for the whole in-browser store: persist, and tell the other
  // tabs. Every mutation funnels through here, so there is one place to get this right
  // rather than one per handler.
  if (workspace) {
    workspace.snapshots[data.project.id] = data;
    workspace.current_project_id = data.project.id;
    saveWorkspace(workspace);
  }
  saveSnapshot(data);

  return { data, meta: next.meta };
}

function route(snapshot: Snapshot, path: string, method: string, body: Body): Result {
  const at = (pattern: string, verb: string) => (method === verb ? match(path, pattern) : null);
  const plain = (data: Snapshot): Result => ({ data, meta: {} });

  // -- read -----------------------------------------------------------------
  if (at('snapshot', 'GET')) return plain(snapshot);

  // -- session --------------------------------------------------------------
  if (at('auth/logout', 'POST')) return plain(snapshot);

  // -- cells ----------------------------------------------------------------
  if (at('cells', 'PATCH')) {
    must(snapshot, 'deliverable.update');
    const moduleId = String(body.sub_module_id);
    const subactivityId = (body.sub_activity_id as string | null) ?? null;
    const columnKey = String(body.column_key);

    const module = moduleOf(snapshot, moduleId);
    if (module.closed) {
      throw new ApiError('bad_request', 'This module is closed. Reopen it before changing a deliverable.', 400);
    }
    if (subactivityId === null && module.sub_activities.length > 0) {
      throw new ApiError(
        'bad_request',
        'This module has sub_activities, so its row is a roll-up. Change the subactivity instead.',
        400,
      );
    }

    const column = snapshot.config.columns.find((candidate) => candidate.key === columnKey);
    if (!column) throw new ApiError('not_found', 'That deliverable column is not configured.', 404);

    const before =
      subactivityId === null
        ? module.cells.find((cell) => cell.column_key === columnKey)?.status
        : module.sub_activities
            .find((sub) => sub.id === subactivityId)
            ?.cells.find((cell) => cell.column_key === columnKey)?.status;

    // The same function the matrix uses for its optimistic paint, so the demo and the
    // real app cannot disagree about what one click does.
    const advanced = optimisticAdvance(
      snapshot,
      moduleId,
      subactivityId,
      columnKey,
      snapshot.me.display_name,
    );
    const after =
      subactivityId === null
        ? advanced.sub_modules.find((m) => m.id === moduleId)?.cells.find((c) => c.column_key === columnKey)?.status
        : advanced.sub_modules
            .find((m) => m.id === moduleId)
            ?.sub_activities.find((s) => s.id === subactivityId)
            ?.cells.find((c) => c.column_key === columnKey)?.status;

    return plain(
      recountOffVocabulary(
        audited(advanced, {
          scope: 'cell',
          label: column.label,
          what: `${statusEntry(before).label} → ${statusEntry(after).label}`,
          moduleId,
        }),
      ),
    );
  }

  // -- module fields --------------------------------------------------------
  const moduleParams = at('sub-modules/:id', 'PATCH');
  if (moduleParams) {
    const module = moduleOf(snapshot, moduleParams.id!);
    let updated = module;
    let next = snapshot;
    const changes: string[] = [];

    // Processed in the server's order, each with its own permission — a body naming two
    // fields needs both.
    if (body.module_name !== undefined) {
      must(snapshot, 'module.edit');
      const target = String(body.module_name ?? '').trim();
      if (!target) throw new ApiError('validation_failed', 'A sub-module has to sit on a module.', 422);
      if (target !== module.module_name) {
        if (!snapshot.config.module_names.includes(target)) {
          throw new ApiError(
            'validation_failed',
            `${target} is not a module in this project. Add it on the Configure screen first.`,
            422,
          );
        }
        if (
          snapshot.sub_modules.some(
            (other) => other.id !== module.id && other.module_name === target && other.name === module.name,
          )
        ) {
          throw new ApiError('conflict', `This project already tracks ${target} · ${module.name}.`, 409);
        }
        // Every cell moves with it: what was loaded is a fact about the work, not about which
        // heading it was filed under.
        updated = { ...updated, module_name: target };
        changes.push(`moved — ${module.module_name} → ${target}`);
      }
    }
    if (body.owner !== undefined) {
      must(snapshot, 'module.edit');
      const owner = (body.owner as string | null) || null;
      changes.push(`owner ${module.owner ?? 'unassigned'} → ${owner ?? 'unassigned'}`);
      updated = { ...updated, owner };
    }
    if (body.fni_target_date !== undefined) {
      must(snapshot, 'fni.date');
      const raw = String(body.fni_target_date ?? '').trim();
      const date = raw || null;
      if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))) {
        throw new ApiError('validation_failed', 'Expected a date as YYYY-MM-DD.', 422);
      }
      changes.push(`FNI target date ${module.fni_target_date ?? 'not set'} → ${date ?? 'not set'}`);
      updated = { ...updated, fni_target_date: date };
    }

    next = replaceModule(snapshot, updated);
    for (const what of changes) {
      next = audited(next, { scope: 'module', label: 'MODULE', what, moduleId: module.id });
    }
    return plain(next);
  }

  // -- FNI sign-off ---------------------------------------------------------
  const fniParams = at('sub-modules/:id/fni', 'POST');
  if (fniParams) {
    must(snapshot, 'fni.signoff');
    const module = moduleOf(snapshot, fniParams.id!);
    // Missing means close, as on the server: the button that sends nothing is "Mark FNI done".
    const close = body.close !== false;

    if (close) {
      // The gate, recomputed here rather than trusted from the screen.
      const blockers: string[] = [];
      if (module.readiness !== 100) {
        blockers.push('DevOps has not confirmed every deliverable loaded in prod');
      }
      const fni = module.cells.find((cell) => cell.column_key === 'fni');
      if (!fni || toneOf(fni.status) !== 'done') blockers.push('FNI final submission is not complete');
      if (blockers.length > 0) {
        throw new ApiError('bad_request', `Blocked — ${blockers.join('; ')}`, 400);
      }
    }

    const updated: SubModuleView = {
      ...module,
      closed: close,
      closed_by: close ? snapshot.me.display_name : null,
    };
    return plain(
      audited(replaceModule(snapshot, updated), {
        scope: 'module',
        label: 'FNI',
        what: close ? 'FNI signed off — module closed' : 'module reopened',
        moduleId: module.id,
      }),
    );
  }

  // -- DevOps prod confirmation --------------------------------------------
  const confirmParams = at('sub-modules/:id/confirm-prod', 'POST');
  if (confirmParams) {
    must(snapshot, 'prod.confirm');
    const module = moduleOf(snapshot, confirmParams.id!);
    if (module.closed) throw new ApiError('bad_request', 'This module is closed.', 400);

    const stamp = { changed_by: snapshot.me.display_name, changed_at: new Date().toISOString() };
    let changed = 0;

    const doneFor = (columnKey: string): string | undefined =>
      snapshot.config.columns
        .find((column) => column.key === columnKey && column.counts)
        ?.allowed.find((status) => toneOf(status) === 'done');

    const applyRow = (cells: CellView[]): CellView[] =>
      cells.map((cell) => {
        const done = doneFor(cell.column_key);
        if (!done || cell.status === done) return cell;
        changed++;
        return { ...cell, status: done, ...stamp };
      });

    let updated: SubModuleView =
      module.sub_activities.length > 0
        ? {
            ...module,
            sub_activities: module.sub_activities.map((sub) => {
              const cells = applyRow(sub.cells);
              return { ...sub, cells, readiness: subReadiness(snapshot, cells) };
            }),
          }
        : { ...module, cells: applyRow(module.cells) };

    updated = reroll(snapshot, updated);

    return {
      data:
        changed === 0
          ? snapshot
          : recountOffVocabulary(
              audited(replaceModule(snapshot, updated), {
                scope: 'cell',
                label: 'MODULE',
                what: `confirmed loaded in prod — ${changed} ${changed === 1 ? 'cell' : 'cells'} set`,
                moduleId: module.id,
              }),
            ),
      // `changed` is what this screen reads; `cells_changed` is the service's name for it.
      meta: { changed, cells_changed: changed },
    };
  }

  // -- links ----------------------------------------------------------------
  const linkParams = at('sub-modules/:id/links', 'POST');
  if (linkParams) {
    must(snapshot, 'module.edit');
    const module = moduleOf(snapshot, linkParams.id!);
    const url = String(body.url ?? '').trim();
    if (!url) throw new ApiError('validation_failed', 'A link needs a URL.', 422);

    const label = String(body.label ?? '').trim() || url;
    const updated: SubModuleView = {
      ...module,
      links: [...module.links, { id: newId(), type: String(body.type ?? 'Repo'), label, url }],
    };
    return plain(
      audited(replaceModule(snapshot, updated), {
        scope: 'module',
        label: 'MODULE',
        what: `link added — ${label}`,
        moduleId: module.id,
      }),
    );
  }

  const linkDelete = at('links/:id', 'DELETE');
  if (linkDelete) {
    must(snapshot, 'module.edit');
    return plain({
      ...snapshot,
      sub_modules: snapshot.sub_modules.map((module) => ({
        ...module,
        links: module.links.filter((link) => link.id !== linkDelete.id),
      })),
    });
  }

  // -- modules --------------------------------------------------------------
  if (at('modules', 'POST')) {
    must(snapshot, 'module.create');
    const nodeType = String(body.module_name ?? '').trim();
    const name = String(body.name ?? '').trim();
    // The same three refusals as `createModule` on the server, in the same order. A demo that
    // accepted a nameless row, or invented a node type nobody configured, would be showing a
    // client something the real app refuses.
    if (!nodeType) throw new ApiError('validation_failed', 'A module needs a node type.', 422);
    if (!name) throw new ApiError('validation_failed', 'A module needs an activity name.', 422);
    if (!snapshot.config.module_names.includes(nodeType)) {
      throw new ApiError(
        'validation_failed',
        `${nodeType} is not a node type on this project. Add it on the Configure screen first.`,
        422,
      );
    }
    if (
      snapshot.sub_modules.some(
        (module) => module.module_name === nodeType && module.name === name,
      )
    ) {
      throw new ApiError('conflict', `${nodeType} · ${name} is already tracked on this project.`, 409);
    }

    const created = withDerived(
      {
        id: newId(),
        module_name: nodeType,
        name,
        owner: null,
        fni_target_date: null,
        closed: false,
        closed_by: null,
        readiness: 0,
        stage_index: 0,
        missing: [],
        blank_count: 0,
        cells: blankCells(snapshot),
        sub_activities: [],
        links: [],
        last_run: null,
        // Attached from the panels on the sub-module screen, as in the real app. A module
        // template would copy its checklist here; the demo leaves that to the button.
        step_lists: [],
        owners: [],
        threads: [],
        created_at: new Date().toISOString(),
      },
      snapshot.config.columns,
      snapshot.config.stages.length,
    );

    const withNodeType = snapshot.config;

    const library =
      body.add_to_library === true
        ? [
            ...snapshot.library,
            {
              id: newId(),
              module_name: nodeType,
              name,
              version: 'v1',
              sub_activity_count: 0,
              used_in_projects: 1,
              in_this_project: true,
            },
          ]
        : snapshot.library;

    return {
      data: audited(
        { ...snapshot, config: withNodeType, library, sub_modules: [...snapshot.sub_modules, created] },
        { scope: 'module', label: 'MODULE', what: `created ${nodeType} · ${name}`, moduleId: created.id },
      ),
      meta: { sub_module_id: created.id, module_name: nodeType },
    };
  }

  // -- sub_activities --------------------------------------------------------
  const subAdd = at('sub-modules/:id/sub-activities', 'POST');
  if (subAdd) {
    must(snapshot, 'module.edit');
    const module = moduleOf(snapshot, subAdd.id!);
    if (module.closed) throw new ApiError('bad_request', 'This module is closed.', 400);
    if (!String(body.name ?? '').trim()) {
      throw new ApiError('validation_failed', 'A sub-activity needs a name.', 422);
    }

    // Adding the first subactivity moves the module's own row onto it, so readiness
    // does not jump when a module gains its first child.
    const seededCells: CellView[] =
      module.sub_activities.length === 0
        ? module.cells.map((cell) => ({ ...cell, rolled_up: false, sub_activity_count: 0 }))
        : blankCells(snapshot);

    const created: SubActivityView = {
      id: newId(),
      name: String(body.name ?? '').trim(),
      readiness: subReadiness(snapshot, seededCells),
      cells: seededCells,
      // A sub-activity created in the demo starts with none of the three. They are attached
      // deliberately, from the panels on the sub-module screen, exactly as in the real app.
      step_lists: [],
      owners: [],
      threads: [],
    };

    const updated = reroll(snapshot, {
      ...module,
      sub_activities: [...module.sub_activities, created],
    });
    return plain(
      audited(replaceModule(snapshot, updated), {
        scope: 'module',
        label: 'MODULE',
        what: `subactivity added: ${created.name}`,
        moduleId: module.id,
      }),
    );
  }

  const subEdit = at('sub-modules/:id/sub-activities/:subId', 'PATCH');
  if (subEdit) {
    must(snapshot, 'module.edit');
    const module = moduleOf(snapshot, subEdit.id!);
    const existing = module.sub_activities.find((sub) => sub.id === subEdit.subId);
    if (!existing) throw new ApiError('not_found', 'That subActivity is not on this module.', 404);
    const name = String(body.name ?? '').trim();
    if (!name) throw new ApiError('validation_failed', 'A sub-activity needs a name.', 422);
    const updated: SubModuleView = {
      ...module,
      sub_activities: module.sub_activities.map((sub) => (sub.id === existing.id ? { ...sub, name } : sub)),
    };
    return plain(
      audited(replaceModule(snapshot, updated), {
        scope: 'module',
        label: 'MODULE',
        what: `subActivity renamed — ${existing.name} → ${name}`,
        moduleId: module.id,
      }),
    );
  }

  const subDelete = at('sub-modules/:id/sub-activities/:subId', 'DELETE');
  if (subDelete) {
    must(snapshot, 'module.edit');
    const module = moduleOf(snapshot, subDelete.id!);
    if (module.closed) throw new ApiError('bad_request', 'This module is closed.', 400);

    const remaining = module.sub_activities.filter((sub) => sub.id !== subDelete.subId);
    const removed = module.sub_activities.find((sub) => sub.id === subDelete.subId);

    // Removing the last one materialises the module's row from what the roll-up showed,
    // so the module keeps the readiness it had a moment earlier.
    const updated =
      remaining.length === 0
        ? withDerived(
            {
              ...module,
              sub_activities: [],
              cells: module.cells.map((cell) => ({
                ...cell,
                rolled_up: false,
                sub_activity_count: 0,
              })),
            },
            snapshot.config.columns,
            snapshot.config.stages.length,
          )
        : reroll(snapshot, { ...module, sub_activities: remaining });

    return plain(
      audited(replaceModule(snapshot, updated), {
        scope: 'module',
        label: 'MODULE',
        what: `subactivity removed: ${removed?.name ?? ''}`,
        moduleId: module.id,
      }),
    );
  }

  // -- defects --------------------------------------------------------------
  if (at('defects', 'POST')) {
    must(snapshot, 'defect.create');
    const module = moduleOf(snapshot, String(body.sub_module_id));
    const ticket = String(body.ticket_key ?? '').trim();

    return plain({
      ...snapshot,
      defects: [
        {
          id: newId(),
          sub_module_id: module.id,
          sub_module_label: `${module.module_name} · ${module.name}`,
          phase: body.phase as never,
          ticket_key: ticket,
          ticket_url: ticket ? `https://tms.internal/browse/${ticket}` : '',
          child_req_id: String(body.child_req_id ?? '').trim(),
          severity: body.severity as never,
          description: String(body.description ?? '').trim(),
          raised_by: snapshot.me.display_name,
          assignee: null,
          status: 'Open',
          created_at: new Date().toISOString(),
        },
        ...snapshot.defects,
      ],
    });
  }

  const defectPatch = at('defects/:id', 'PATCH');
  if (defectPatch) {
    return plain({
      ...snapshot,
      defects: snapshot.defects.map((defect) => {
        if (defect.id !== defectPatch.id) return defect;
        if (body.assignee !== undefined) {
          must(snapshot, 'defect.assign');
          return { ...defect, assignee: (body.assignee as string | null) || null };
        }
        must(snapshot, 'defect.transition');
        const status =
          (body.status as DefectStatus | undefined) ??
          DEFECT_STATUS_ORDER[
            (DEFECT_STATUS_ORDER.indexOf(defect.status) + 1) % DEFECT_STATUS_ORDER.length
          ]!;
        return { ...defect, status };
      }),
    });
  }

  // -- configuration --------------------------------------------------------
  /**
   * A plain column.
   *
   * Reads what the Configure screen sends — `{ key, label, full, allowed, counts }` — which is
   * the service's contract. It used to read `body.name`, which the screen has not sent since
   * the form was brought level with the service, so every column added in the demo arrived
   * with no name, an `x_` key and the wrong statuses. `name` is still accepted on its own, for
   * anything that sends the old shape.
   */
  if (at('config/columns', 'POST')) {
    must(snapshot, 'project.config');
    const input = plainColumnInput(body);

    if (snapshot.config.columns.some((column) => column.key === input.key)) {
      throw new ApiError('conflict', `This project already has a column called ${input.key}.`, 409);
    }

    const column: ColumnView = {
      id: newId(),
      project_id: snapshot.project.id,
      key: input.key,
      label: input.label,
      full: input.full,
      allowed: input.allowed,
      counts: input.counts,
      order_index: snapshot.config.columns.length,
      off_vocabulary: 0,
      // A column added here is a plain one — see `addColumn` on the server.
      environment: null,
      group_key: null,
      group_label: null,
      active: true,
    };

    return plain(
      audited(withColumnsAdded(snapshot, [column]), {
        scope: 'project',
        label: 'CONFIG',
        what: `column added — ${column.label}`,
      }),
    );
  }

  const columnPatch = at('config/columns/:key', 'PATCH');
  if (columnPatch) {
    must(snapshot, 'project.config');
    const key = columnPatch.key!;
    const columns = [...snapshot.config.columns];
    const index = columns.findIndex((column) => column.key === key);
    if (index < 0) throw new ApiError('not_found', 'That column is not configured.', 404);
    const column = columns[index]!;
    let what = '';

    if (body.counts !== undefined) {
      columns[index] = { ...column, counts: body.counts === true };
      what = `${column.label} ${body.counts === true ? 'now counts toward prod' : 'is now informational'}`;
    }
    if (body.allowed !== undefined) {
      const allowed = body.allowed as string[];
      columns[index] = { ...columns[index]!, allowed };
      what = `${column.label} statuses set to ${allowed.map((s) => statusEntry(s).label).join(', ')}`;
    }
    if (body.move !== undefined) {
      const target = body.move === 'up' ? index - 1 : index + 1;
      if (target >= 0 && target < columns.length) {
        const swap = columns[target]!;
        columns[target] = columns[index]!;
        columns[index] = swap;
        columns.forEach((entry, order) => (columns[order] = { ...entry, order_index: order }));
      }
      what = `${column.label} moved ${body.move}`;
    }

    const reordered = { ...snapshot, config: { ...snapshot.config, columns } };
    return plain(
      recountOffVocabulary(
        audited(
          {
            ...reordered,
            sub_modules: reordered.sub_modules.map((module) =>
              withDerived(module, columns, snapshot.config.stages.length),
            ),
          },
          { scope: 'project', label: 'CONFIG', what },
        ),
      ),
    );
  }

  const columnDelete = at('config/columns/:key', 'DELETE');
  if (columnDelete) {
    must(snapshot, 'project.config');
    const key = columnDelete.key!;
    const column = snapshot.config.columns.find((candidate) => candidate.key === key);
    const columns = snapshot.config.columns.filter((candidate) => candidate.key !== key);

    return plain(
      audited(
        {
          ...snapshot,
          config: { ...snapshot.config, columns },
          sub_modules: snapshot.sub_modules.map((module) =>
            withDerived(
              {
                ...module,
                cells: module.cells.filter((cell) => cell.column_key !== key),
                sub_activities: module.sub_activities.map((sub) => ({
                  ...sub,
                  cells: sub.cells.filter((cell) => cell.column_key !== key),
                  readiness: subReadiness(
                    { ...snapshot, config: { ...snapshot.config, columns } },
                    sub.cells.filter((cell) => cell.column_key !== key),
                  ),
                })),
              },
              columns,
              snapshot.config.stages.length,
            ),
          ),
        },
        { scope: 'project', label: 'CONFIG', what: `column removed: ${column?.full ?? key}` },
      ),
    );
  }

  /**
   * The client mirror of `setEnvironmentEnabled`.
   *
   * Nothing is removed here either — the columns keep their cells and only `active`
   * moves, which is what every readiness figure on the screen is recomputed against.
   */
  const environmentPatch = at('config/environments/:key', 'PATCH');
  if (environmentPatch) {
    must(snapshot, 'project.config');
    const key = environmentPatch.key!;
    const environment = snapshot.config.environments.find((entry) => entry.key === key);
    if (!environment) {
      throw new ApiError('not_found', 'That environment is not configured on this project.', 404);
    }
    const enabled = body.enabled === true;
    if (!enabled && key === PROD_ENVIRONMENT) {
      throw new ApiError(
        'bad_request',
        'Prod cannot be switched off — readiness is measured against it, and the FNI gate reads that percentage.',
        400,
      );
    }

    const environments = snapshot.config.environments.map((entry) =>
      entry.key === key ? { ...entry, enabled } : entry,
    );
    const columns = snapshot.config.columns.map((column) =>
      column.environment === key ? { ...column, active: enabled } : column,
    );
    const config = { ...snapshot.config, environments, columns };
    const affected = columns.filter((column) => column.environment === key).length;

    return plain(
      audited(
        {
          ...snapshot,
          config,
          sub_modules: snapshot.sub_modules.map((module) =>
            withDerived(
              {
                ...module,
                sub_activities: module.sub_activities.map((sub) => ({
                  ...sub,
                  readiness: subReadiness({ ...snapshot, config }, sub.cells),
                })),
              },
              columns,
              config.stages.length,
            ),
          ),
        },
        {
          scope: 'project',
          label: 'CONFIG',
          what: enabled
            ? `switched ${environment.label} back on — its ${affected} ${affected === 1 ? 'column is' : 'columns are'} back on the matrix, holding what was recorded before`
            : `switched ${environment.label} off — its ${affected} ${affected === 1 ? 'column leaves' : 'columns leave'} the matrix and the readiness maths, keeping every cell`,
        },
      ),
    );
  }

  if (at('config/lists', 'POST')) {
    must(snapshot, 'project.config');
    const list = String(body.list) as 'modules' | 'stages' | 'owners' | 'link_types';
    const action = String(body.action);
    const value = String(body.value);
    const config = { ...snapshot.config };

    if (list === 'stages') {
      config.stages =
        action === 'add'
          ? [...config.stages, { id: newId(), label: value }]
          : config.stages.filter((stage) => stage.id !== value && stage.label !== value);
    } else {
      // 'modules' on the wire, 'module_names' in the snapshot: the list holds the names, and
      // the records with ids are derived from them. One mapping rather than a second name.
      const field = list === 'modules' ? 'module_names' : list;
      const currentList = config[field];
      config[field] =
        action === 'add'
          ? currentList.includes(value)
            ? currentList
            : [...currentList, value]
          : currentList.filter((entry) => entry !== value);
    }

    return plain(
      audited(
        {
          ...snapshot,
          config,
          // Stage count changes re-bucket every module on the pipeline.
          sub_modules: snapshot.sub_modules.map((module) =>
            withDerived(module, config.columns, config.stages.length),
          ),
        },
        { scope: 'project', label: 'CONFIG', what: `${list}: ${action} ${value}` },
      ),
    );
  }

  // -- library --------------------------------------------------------------
  const cloneParams = at('library/:id/clone', 'POST');
  if (cloneParams) {
    must(snapshot, 'module.clone');
    const entry = snapshot.library.find((candidate) => candidate.id === cloneParams.id);
    if (!entry) throw new ApiError('not_found', 'That library entry does not exist.', 404);

    const sub_activities: SubActivityView[] = Array.from(
      { length: entry.sub_activity_count },
      (_, index) => ({
        id: newId(),
        name: `SubActivity ${index + 1}`,
        readiness: 0,
        cells: blankCells(snapshot),
        step_lists: [],
        owners: [],
        threads: [],
      }),
    );

    const created = reroll(snapshot, {
      id: newId(),
      module_name: entry.module_name,
      name: entry.name,
      owner: null,
      fni_target_date: null,
      closed: false,
      closed_by: null,
      readiness: 0,
      stage_index: 0,
      missing: [],
      blank_count: 0,
      cells: blankCells(snapshot),
      sub_activities,
      links: [],
      last_run: null,
      // A clone copies the shape of the work, not somebody else's checklist progress,
      // owners or discussion. Those belong to the sub-module they were recorded against.
      step_lists: [],
      owners: [],
      threads: [],
      created_at: new Date().toISOString(),
    });

    const config = snapshot.config.module_names.includes(entry.module_name)
      ? snapshot.config
      : { ...snapshot.config, module_names: [...snapshot.config.module_names, entry.module_name] };

    return {
      data: audited(
        {
          ...snapshot,
          config,
          sub_modules: [...snapshot.sub_modules, created],
          library: snapshot.library.map((candidate) =>
            candidate.id === entry.id
              ? { ...candidate, used_in_projects: candidate.used_in_projects + 1, in_this_project: true }
              : candidate,
          ),
        },
        { scope: 'module', label: 'MODULE', what: `cloned from the library`, moduleId: created.id },
      ),
      meta: { sub_module_id: created.id, module_name: entry.module_name },
    };
  }

  // -- access ---------------------------------------------------------------
  const grantParams = at('roles/:id/grants', 'PATCH');
  if (grantParams) {
    must(snapshot, 'admin.roles.manage');
    const permission = String(body.permission) as PermissionKey;
    const granted = body.granted === true;

    if (granted && !snapshot.me.permissions.includes(permission)) {
      throw new ApiError('forbidden', `You cannot grant ${permission} — you do not hold it yourself.`, 403);
    }

    const roles = snapshot.roles.map((role) =>
      role.id === grantParams.id
        ? {
            ...role,
            permissions: granted
              ? role.permissions.includes(permission)
                ? role.permissions
                : [...role.permissions, permission]
              : role.permissions.filter((key) => key !== permission),
          }
        : role,
    );

    // If the signed-in demo role just changed, the UI must gate on the new set at once.
    const mine = roles.find((role) => snapshot.me.role_names.includes(role.name));
    return plain(
      audited(
        {
          ...snapshot,
          roles,
          me: mine ? { ...snapshot.me, permissions: mine.permissions } : snapshot.me,
        },
        { scope: 'project', label: 'ACCESS', what: `${permission} ${granted ? 'granted' : 'revoked'}` },
      ),
    );
  }

  if (at('invitations', 'POST')) {
    must(snapshot, 'admin.users.manage');
    const email = String(body.email ?? '').trim().toLowerCase();
    const role = snapshot.roles.find((candidate) => candidate.id === body.role_id);
    const scopeId = (body.scope_project_id as string | null) ?? null;
    const scope = scopeId
      ? (snapshot.projects.find((project) => project.id === scopeId)?.key ?? 'unknown project')
      : `${snapshot.org.name} — all projects`;

    return {
      data: {
        ...snapshot,
        invitations: [
          {
            id: newId(),
            email,
            display_name: String(body.display_name ?? '').trim() || email,
            role_name: role?.name ?? '—',
            scope,
            state: 'Invited, just now — not accepted',
          },
          ...snapshot.invitations,
        ],
      },
      meta: { accept_url: '#demo-invitation-not-sent', demo: true },
    };
  }

  // -- projects -------------------------------------------------------------
  if (at('projects', 'POST')) {
    must(snapshot, 'project.create');
    const key = String(body.key ?? '').trim().toUpperCase();
    if (snapshot.projects.some((project) => project.key === key)) {
      throw new ApiError('validation_failed', 'A project with that key already exists.', 422);
    }
    const id = newId();
    const created = addProjectToWorkspace(snapshot, {
      id,
      key,
      name: String(body.name ?? '').trim() || key,
    });
    return {
      data: { ...snapshot, projects: created },
      meta: { project_id: id },
    };
  }

  /**
   * Switching project.
   *
   * Every project the demo knows about has its own snapshot in the workspace, so this is
   * a real switch: a project created a minute ago opens empty, with the set-up prompt and
   * the Configure screen, which is exactly what a new project looks like.
   */
  if (at('projects/select', 'POST')) {
    const target = String(body.project_id ?? '');
    const space = demoWorkspace();
    const next = space.snapshots[target];
    if (!next) throw new ApiError('not_found', 'That project is not in this demo.', 404);

    return plain({
      ...next,
      // The switcher, the signed-in person and their permissions belong to the session,
      // not to the project being opened.
      me: snapshot.me,
      // Scoped to the organisation being opened, so a project created in another one
      // never appears in this switcher.
      projects: projectSummaries(space, next.org.id),
    });
  }

  if (at('projects/members', 'POST')) {
    must(snapshot, 'project.members.manage');
    const user = snapshot.users.find((candidate) => candidate.id === body.user_id);
    const role = snapshot.roles.find((candidate) => candidate.id === body.role_id);
    if (!user || !role) throw new ApiError('not_found', 'No such user or role.', 404);

    return plain({
      ...snapshot,
      members: [
        ...snapshot.members,
        {
          membership_id: newId(),
          user_id: user.id,
          display_name: user.display_name,
          email: user.email,
          role_id: role.id,
          role_name: role.name,
          org_wide: false,
          status: user.status,
          editable: true,
          locked_reason: '',
        },
      ],
    });
  }

  const memberPatch = at('projects/members/:id', 'PATCH');
  if (memberPatch) {
    must(snapshot, 'project.members.manage');
    const role = snapshot.roles.find((candidate) => candidate.id === body.role_id);
    return plain({
      ...snapshot,
      members: snapshot.members.map((member) =>
        member.membership_id === memberPatch.id && role
          ? { ...member, role_id: role.id, role_name: role.name }
          : member,
      ),
    });
  }

  const memberDelete = at('projects/members/:id', 'DELETE');
  if (memberDelete) {
    must(snapshot, 'project.members.manage');
    return plain({
      ...snapshot,
      members: snapshot.members.filter((member) => member.membership_id !== memberDelete.id),
    });
  }

  // -- drift ----------------------------------------------------------------
  if (at('drift/promote', 'POST')) {
    must(snapshot, 'prod.confirm');
    const gate = snapshot.drift.gate;
    if (!gate.can_promote) {
      throw new ApiError(
        'bad_request',
        `Blocked — ${gate.checks.filter((check) => !check.passed).map((check) => check.text).join('; ')}`,
        400,
      );
    }

    const hashed = snapshot.drift.rows.filter((row) => row.full_hashes.preprod);
    return {
      data: audited(
        {
          ...snapshot,
          drift: {
            ...snapshot.drift,
            promotions: [
              {
                id: newId(),
                from_environment: String(body.from ?? 'preprod'),
                to_environment: String(body.to ?? 'prod'),
                promoted_by: snapshot.me.display_name,
                at: new Date().toISOString(),
                // Unconfirmed, and it stays that way: only an agent report from prod can
                // close it, and the demo has no agent.
                confirmed_at: null,
                column_count: hashed.length,
              },
              ...snapshot.drift.promotions,
            ],
          },
        },
        { scope: 'project', label: 'DRIFT', what: `promoted ${hashed.length} deliverables preprod → prod` },
      ),
      meta: { columns: hashed.length },
    };
  }

  if (at('drift/reports', 'POST')) {
    // Hashes come from an agent running on a server. There isn't one behind a static page.
    throw new ApiError(
      'bad_request',
      'Hash reports come from agent/report_hashes.py running on each environment. The demo has no agent, so the hashes it shows are the seeded ones.',
      400,
    );
  }

  const handled =
    routeSteps(snapshot, at, body) ??
    routeCollaboration(snapshot, at, body) ??
    routeConfigExtras(snapshot, at, body) ??
    routeAccessExtras(snapshot, at, body);
  if (handled) return handled;

  throw new ApiError(
    'not_found',
    `The demo has no handler for ${method} ${path}. Add one in lib/demo/runtime.ts.`,
    404,
  );
}

// ---------------------------------------------------------------------------
// The demo's own controls
// ---------------------------------------------------------------------------

/**
 * The role switcher. Not a real sign-in — it swaps the permission set so a client can
 * see the same screens as DevOps or a Viewer and watch the controls disable themselves.
 */
export function switchDemoRole(roleId: string): Snapshot {
  const snapshot = demoSnapshot();
  const role = snapshot.roles.find((candidate) => candidate.id === roleId);
  if (!role) return snapshot;

  // Re-derived, not just re-labelled: who may tick which step depends on the role, so a
  // checklist has to re-gate itself when the switcher moves — exactly as it would if a
  // different person had signed in.
  current = rederive({
    ...snapshot,
    me: { ...snapshot.me, role_names: [role.name], permissions: role.permissions },
  });
  // The workspace holds this project's snapshot too; leaving it behind would resurrect
  // the previous role the next time the project is switched away from and back.
  if (workspace) workspace.snapshots[current.project.id] = current;
  return current;
}

// ---------------------------------------------------------------------------
// The super admin console
// ---------------------------------------------------------------------------

/**
 * Adds a project to the workspace and returns the switcher's new contents.
 *
 * The project gets its own blank snapshot, so it is a real project from the moment it is
 * created — switch into it and you get the set-up prompt and the Configure screen, which
 * is what a new project actually looks like.
 */
function addProjectToWorkspace(
  from: Snapshot,
  project: { id: string; key: string; name: string },
  organisationId?: string,
): Snapshot['projects'] {
  const space = demoWorkspace();
  const orgId = organisationId ?? from.org.id;
  const organisation = space.organisations.find((candidate) => candidate.id === orgId);
  if (!organisation) throw new ApiError('not_found', 'That organisation does not exist.', 404);

  // A project in another organisation is built from that organisation's own snapshot when it
  // has one, so its people and roles carry over — and never from this one's.
  const sameOrgSource =
    orgId === from.org.id
      ? from
      : organisation.project_ids
          .map((id) => space.snapshots[id])
          .find((snapshot): snapshot is Snapshot => snapshot !== undefined);
  space.snapshots[project.id] = blankProjectSnapshot(sameOrgSource ?? from, project, {
    id: organisation.id,
    name: organisation.name,
    admins: organisation.admins,
  });
  organisation.project_ids.push(project.id);

  return projectSummaries(space, from.org.id);
}

function recordPlatform(actor: Snapshot['me'], action: string, what: string): void {
  demoWorkspace().audit.unshift({
    id: newId(),
    action,
    what,
    who: actor.display_name,
    at: new Date().toISOString(),
  });
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * The client mirror of `lib/server/platform.ts`.
 *
 * It refuses the same things for the same reasons — super admin is a flag on the account
 * and not a permission a role can grant, an organisation cannot suspend itself, an
 * organisation-wide administrator is not removed from one project's row — so a client
 * watching the console sees the real boundaries rather than a screen that always says yes.
 */
function routePlatform(
  snapshot: Snapshot,
  path: string,
  method: string,
  body: Body,
): { data: unknown; meta: Record<string, unknown> } {
  const at = (pattern: string, verb: string) => (method === verb ? match(path, pattern) : null);
  const space = demoWorkspace();

  if (!snapshot.me.is_super_admin) {
    // Deliberately the same wording as any other refusal: whether super admin exists at
    // all is not something an ordinary user learns from an error message.
    throw new ApiError('forbidden', 'That is not available to your account.', 403);
  }

  const view = () => ({ data: demoPlatformView(space, snapshot.me), meta: {} });

  if (at('platform/organisations', 'GET')) return view();

  if (at('platform/organisations', 'POST')) {
    const name = String(body.name ?? '').trim();
    if (!name) throw new ApiError('validation_failed', 'An organisation needs a name.', 422);

    const slug = (String(body.slug ?? '').trim() || slugify(name)).toLowerCase();
    if (space.organisations.some((organisation) => organisation.slug === slug)) {
      throw new ApiError('conflict', `An organisation with the slug "${slug}" already exists.`, 409);
    }

    const adminEmail = String(body.admin_email ?? '').trim().toLowerCase();
    if (!adminEmail.includes('@')) {
      throw new ApiError('validation_failed', 'That does not look like an email address.', 422);
    }

    const id = newId();
    space.organisations.push({
      id,
      name,
      slug,
      status: 'active',
      created_at: new Date().toISOString(),
      // Empty. Its own administrator decides what projects it needs.
      project_ids: [],
      admins: [
        {
          display_name: String(body.admin_name ?? '').trim() || adminEmail,
          email: adminEmail,
          status: 'invited',
        },
      ],
    });

    recordPlatform(
      snapshot.me,
      'organisation.created',
      `created ${name} and invited ${adminEmail} as its admin`,
    );

    return {
      data: demoPlatformView(space, snapshot.me),
      meta: {
        tenant_id: id,
        admin_email: adminEmail,
        // The static demo has no invitation store to redeem against, and a link that 404s
        // is worse than none — so the console is told there is nothing to send.
        accept_url: null,
      },
    };
  }

  const orgProjects = at('platform/organisations/:id/projects', 'POST');
  if (orgProjects) {
    const key = String(body.key ?? '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new ApiError(
        'validation_failed',
        'A project key is uppercase letters, digits and underscores, starting with a letter — like CR_AUTOMATION.',
        422,
      );
    }

    const organisation = space.organisations.find((candidate) => candidate.id === orgProjects.id);
    if (!organisation) throw new ApiError('not_found', 'That organisation does not exist.', 404);

    const clash = organisation.project_ids
      .map((projectId) => space.snapshots[projectId])
      .some((existing) => existing?.project.key === key);
    if (clash) {
      throw new ApiError('conflict', `${organisation.name} already has a project called ${key}.`, 409);
    }

    const id = newId();
    addProjectToWorkspace(
      snapshot,
      { id, key, name: String(body.name ?? '').trim() || key },
      organisation.id,
    );

    // The console answers with a PlatformView, so the snapshot the tracker is holding
    // would not otherwise learn about the new project and it would be missing from the
    // switcher until a reload. Refreshed here, and only when the project landed in the
    // organisation this session is actually signed in to.
    if (organisation.id === snapshot.org.id) {
      current = { ...snapshot, projects: projectSummaries(space, snapshot.org.id) };
      space.snapshots[snapshot.project.id] = current;
      saveSnapshot(current);
    }

    recordPlatform(
      snapshot.me,
      'project.created',
      `created the project ${key} in ${organisation.name}`,
    );

    return { data: demoPlatformView(space, snapshot.me), meta: { project_id: id, key } };
  }

  const orgStatus = at('platform/organisations/:id/status', 'PATCH');
  if (orgStatus) {
    const organisation = space.organisations.find((candidate) => candidate.id === orgStatus.id);
    if (!organisation) throw new ApiError('not_found', 'That organisation does not exist.', 404);

    const status = String(body.status ?? '').toLowerCase();
    if (status !== 'active' && status !== 'suspended') {
      throw new ApiError('validation_failed', 'Status must be "active" or "suspended".', 422);
    }
    // Locking yourself out of your own organisation is a support call, not a feature.
    if (status === 'suspended' && organisation.id === snapshot.org.id) {
      throw new ApiError(
        'validation_failed',
        'You cannot suspend the organisation your own account belongs to.',
        422,
      );
    }

    organisation.status = status;
    recordPlatform(
      snapshot.me,
      status === 'suspended' ? 'organisation.suspended' : 'organisation.restored',
      `${status === 'suspended' ? 'suspended' : 'restored'} ${organisation.name}`,
    );
    return view();
  }

  const addAdmin = at('platform/projects/:id/admins', 'POST');
  if (addAdmin) {
    const target = space.snapshots[addAdmin.id as string];
    if (!target) throw new ApiError('not_found', 'That project does not exist.', 404);

    const email = String(body.email ?? '').trim().toLowerCase();
    if (!email.includes('@')) {
      throw new ApiError('validation_failed', 'That does not look like an email address.', 422);
    }

    const organisation = space.organisations.find((candidate) =>
      candidate.project_ids.includes(addAdmin.id as string),
    );
    // An organisation-wide administrator already holds this project, so a second row
    // scoped to it would grant nothing and show as a duplicate.
    if (organisation?.admins.some((admin) => admin.email === email)) {
      throw new ApiError('conflict', `${email} already administers ${target.project.key}.`, 409);
    }

    const existing = space.project_admins[addAdmin.id as string] ?? [];
    if (existing.some((admin) => admin.email === email)) {
      throw new ApiError('conflict', `${email} already administers ${target.project.key}.`, 409);
    }

    // Somebody already in the organisation keeps their name and active status; somebody
    // new is invited, exactly as the server does it.
    const known = target.users.find((user) => user.email === email);
    space.project_admins[addAdmin.id as string] = [
      ...existing,
      {
        user_id: known?.id ?? newId(),
        membership_id: newId(),
        display_name: known?.display_name ?? (String(body.display_name ?? '').trim() || email),
        email,
        status: known?.status ?? 'invited',
        org_wide: false,
      },
    ];

    recordPlatform(
      snapshot.me,
      'project.admin.added',
      `made ${email} an administrator of ${target.project.key}`,
    );

    return {
      data: demoPlatformView(space, snapshot.me),
      meta: {
        admin_email: email,
        project_key: target.project.key,
        invited: known === undefined,
        accept_url: null,
      },
    };
  }

  const dropAdmin = at('platform/projects/:id/admins/:membershipId', 'DELETE');
  if (dropAdmin) {
    const projectId = dropAdmin.id as string;
    const membershipId = dropAdmin.membershipId as string;
    const target = space.snapshots[projectId];
    if (!target) throw new ApiError('not_found', 'That project does not exist.', 404);

    if (membershipId.startsWith('org:')) {
      throw new ApiError(
        'validation_failed',
        'That access is organisation-wide, so it covers every project. Change it on the organisation’s own Access screen.',
        422,
      );
    }

    const existing = space.project_admins[projectId] ?? [];
    const going = existing.find((admin) => admin.membership_id === membershipId);
    if (!going) throw new ApiError('not_found', 'That access does not exist.', 404);

    space.project_admins[projectId] = existing.filter(
      (admin) => admin.membership_id !== membershipId,
    );
    recordPlatform(
      snapshot.me,
      'project.admin.removed',
      `removed ${going.email} from ${target.project.key}`,
    );
    return view();
  }

  throw new ApiError(
    'not_found',
    `The demo has no handler for ${method} ${path}. Add one in lib/demo/runtime.ts.`,
    404,
  );
}

// ---------------------------------------------------------------------------
// Derived fields — recomputed after every request and every role switch
// ---------------------------------------------------------------------------

/** The role ids the signed-in demo role holds — what a step gate compares against. */
function myRoleIds(snapshot: Snapshot): string[] {
  return snapshot.roles
    .filter((role) => snapshot.me.role_names.includes(role.name))
    .map((role) => role.id);
}

/**
 * Re-gates one checklist for the current reader, and recounts it.
 *
 * `can_tick` and `locked_reason` are answers the server computes per reader. In the demo the
 * reader changes whenever the role switcher moves, so they are recomputed here with the same
 * `stepGate` the server projection calls — never patched by hand.
 */
function regateList(
  snapshot: Snapshot,
  list: StepListView,
  library: ReadonlyMap<string, StepDefinitionView>,
  mine: readonly string[],
  canConfigure: boolean,
): StepListView {
  const entries: StepEntryView[] = list.entries.map((entry) => {
    const definition = library.get(entry.definition_id);
    return {
      ...entry,
      name: definition?.name ?? entry.name,
      description: definition?.description ?? entry.description,
      allowed_roles: definition?.role_names ?? entry.allowed_roles,
    };
  });

  const gated = entries.map((entry, index) => {
    const definition = library.get(entry.definition_id);
    // A retired step still on a list has left the library; its roles are recovered from the
    // names it carries, which is all the view has.
    const roleIds =
      definition?.role_ids ??
      snapshot.roles.filter((role) => entry.allowed_roles.includes(role.name)).map((role) => role.id);
    const gate = stepGate({
      enforceOrder: list.enforce_order,
      earlier: entries.slice(0, index).map((earlier) => ({ name: earlier.name, state: earlier.state })),
      roleIds,
      allowedNames: entry.allowed_roles,
      myRoleIds: mine,
      canConfigure,
    });
    return {
      ...entry,
      can_tick: gate.canTick,
      is_override_for_me: gate.isOverrideForMe,
      locked_reason: gate.lockedReason,
    };
  });

  const done = gated.filter((entry) => entry.state === 'done').length;
  return {
    ...list,
    entries: gated,
    done_count: done,
    blocked_count: gated.filter((entry) => entry.state === 'blocked').length,
    readiness: gated.length === 0 ? 0 : Math.round((done / gated.length) * 100),
  };
}

/** Every checklist in the project, sub-module level and sub-activity level. */
function allLists(snapshot: Snapshot): StepListView[] {
  return snapshot.sub_modules.flatMap((subModule) => [
    ...subModule.step_lists,
    ...subModule.sub_activities.flatMap((subActivity) => subActivity.step_lists),
  ]);
}

/**
 * Everything derived, from the facts the snapshot holds.
 *
 * The single place the demo recomputes what `buildSnapshot` would have sent. Each figure
 * comes from the same pure function the server projection calls, which is what keeps the
 * demo from showing a number the real app would not:
 *
 * - who may tick which step (`stepGate`), for the role the switcher is on;
 * - the step library's role names and how many checklists use each step;
 * - the module records and their counts (`reconcileModules`);
 * - both timing panels (`columnTimings`, `stepTimings`);
 * - the unread badge, the switcher's entry for this project, and the promotion gate.
 */
export function rederive(snapshot: Snapshot): Snapshot {
  const roleNames = new Map(snapshot.roles.map((role) => [role.id, role.name]));

  const usedIn = new Map<string, number>();
  for (const list of allLists(snapshot)) {
    for (const entry of list.entries) {
      usedIn.set(entry.definition_id, (usedIn.get(entry.definition_id) ?? 0) + 1);
    }
  }

  const step_library = snapshot.step_library
    .map((definition) => ({
      ...definition,
      role_names: definition.role_ids
        .map((id) => roleNames.get(id))
        .filter((name): name is string => Boolean(name)),
      used_in: usedIn.get(definition.id) ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const library = new Map(step_library.map((definition) => [definition.id, definition]));
  const mine = myRoleIds(snapshot);
  const canConfigure = hasPermission(new Set(snapshot.me.permissions), 'project.config');
  const regate = (list: StepListView) => regateList(snapshot, list, library, mine, canConfigure);

  const sub_modules = snapshot.sub_modules.map((subModule) => ({
    ...subModule,
    step_lists: subModule.step_lists.map(regate),
    sub_activities: subModule.sub_activities.map((subActivity) => ({
      ...subActivity,
      step_lists: subActivity.step_lists.map(regate),
    })),
  }));

  const columns = snapshot.config.columns;
  const regated: Snapshot = { ...snapshot, sub_modules, step_library };

  return {
    ...regated,
    config: {
      ...snapshot.config,
      modules: reconcileModules(snapshot.config.modules, snapshot.config.module_names, sub_modules),
    },
    timing: columnTimings(
      columns.filter((column) => column.active),
      sub_modules,
    ),
    step_timing: stepTimings(allLists(regated)),
    unread_notifications: snapshot.notifications.filter((row) => row.unread).length,
    projects: snapshot.projects.map((project) =>
      project.id === snapshot.project.id
        ? { ...project, configured: columns.length > 0, sub_module_count: sub_modules.length }
        : project,
    ),
    drift: {
      ...snapshot.drift,
      gate: promotionGate(columns, sub_modules, snapshot.drift.rows),
    },
  };
}

// ---------------------------------------------------------------------------
// Shared validation, in the service's words
// ---------------------------------------------------------------------------

type At = (pattern: string, verb: string) => Record<string, string> | null;

function invalid(message: string): never {
  throw new ApiError('validation_failed', message, 422);
}

function notFound(message: string): never {
  throw new ApiError('not_found', message, 404);
}

/** Trimmed, non-empty and within the column's size — the service's `requireText`. */
function requireText(value: unknown, message: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) invalid(message);
  if (text.length > max) invalid(`That is longer than the ${max} characters this field holds.`);
  return text;
}

type ScopeType = 'module' | 'sub_module' | 'sub_activity';

function parseScope(value: unknown, message: string): ScopeType {
  const scope = String(value ?? '').trim().toLowerCase().replace(/-/g, '_');
  if (scope === 'module' || scope === 'sub_module' || scope === 'sub_activity') return scope;
  return invalid(message);
}

/** `validateAllowed` on the server: at least one status, and only ones this system knows. */
function validateAllowed(value: unknown): string[] {
  const allowed = Array.isArray(value) ? value.map(String) : [];
  if (allowed.length === 0) invalid('A column must allow at least one status.');
  const unknown = allowed.filter((status) => !isStatusKey(status));
  if (unknown.length > 0) invalid(`Not a status this system knows: ${unknown.join(', ')}.`);
  return allowed;
}

/** The key a typed name becomes — the same derivation the Configure screen does. */
function keyFrom(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function plainColumnInput(body: Body): {
  key: string;
  label: string;
  full: string;
  allowed: string[];
  counts: boolean;
} {
  const legacyName = typeof body.name === 'string' ? body.name.trim() : '';
  const full = (typeof body.full === 'string' ? body.full.trim() : '') || legacyName;
  const label =
    (typeof body.label === 'string' ? body.label.trim() : '') || full.toUpperCase().slice(0, 12);
  const key = keyFrom(typeof body.key === 'string' && body.key.trim() ? body.key : full || label);

  if (!full && !label) invalid('A column needs a name.');
  if (!key) invalid('A column name needs at least one letter or digit to key it by.');
  if (label.length > 12) invalid('A column header is at most 12 characters.');

  return {
    key,
    label,
    full: full || label,
    // A body with no statuses is the old `{ name }` shape; it gets the plain pair, as before.
    allowed: body.allowed === undefined ? [...STATUS_SETS.simple] : validateAllowed(body.allowed),
    counts: body.counts === undefined || body.counts === null ? true : body.counts === true,
  };
}

/** Puts new columns on the project, with a blank cell for each on every row. */
function withColumnsAdded(snapshot: Snapshot, added: ColumnView[]): Snapshot {
  const columns = [...snapshot.config.columns, ...added];
  const blank = (key: string): CellView => ({
    column_key: key,
    status: BLANK,
    rolled_up: false,
    sub_activity_count: 0,
    changed_by: null,
    changed_at: null,
  });

  return recountOffVocabulary({
    ...snapshot,
    config: { ...snapshot.config, columns },
    sub_modules: snapshot.sub_modules.map((module) => {
      const sub_activities = module.sub_activities.map((sub) => {
        const cells = [...sub.cells, ...added.map((column) => blank(column.key))];
        return { ...sub, cells, readiness: subReadiness({ ...snapshot, config: { ...snapshot.config, columns } }, cells) };
      });
      // A rolled-up row stays derived: its new cells are the roll-up of blanks, never stored.
      const withCells = {
        ...module,
        sub_activities,
        cells: [
          ...module.cells,
          ...added.map((column) => ({
            ...blank(column.key),
            rolled_up: module.sub_activities.length > 0,
            sub_activity_count: module.sub_activities.length,
          })),
        ],
      };
      return withDerived(withCells, columns, snapshot.config.stages.length);
    }),
  });
}

// ---------------------------------------------------------------------------
// Session — answered without a project
// ---------------------------------------------------------------------------

function routeSession(path: string, method: string): { data: unknown; meta: Record<string, unknown> } | null {
  if (method !== 'POST') return null;

  // There are no accounts to check a password against. The demo is always signed in as the
  // seeded super admin, and the role switcher in the header is where "who am I" is shown —
  // so signing in simply walks in.
  if (match(path, 'auth/login')) return { data: null, meta: { demo: true } };

  if (match(path, 'auth/accept-invite')) {
    throw new ApiError(
      'bad_request',
      'This is the offline demo, so no invitation was ever sent and there is no account to set a password for. Open the demo from its home page — it is already signed in, and the role switcher in the header shows each role.',
      400,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Checklists — the step library, the lists, and ticking
// ---------------------------------------------------------------------------

interface ListAt {
  list: StepListView;
  scopeType: 'sub_module' | 'sub_activity';
  subModule: SubModuleView;
  subActivity: SubActivityView | null;
}

function findList(snapshot: Snapshot, listId: string): ListAt {
  for (const subModule of snapshot.sub_modules) {
    const own = subModule.step_lists.find((list) => list.id === listId);
    if (own) return { list: own, scopeType: 'sub_module', subModule, subActivity: null };
    for (const subActivity of subModule.sub_activities) {
      const found = subActivity.step_lists.find((list) => list.id === listId);
      if (found) return { list: found, scopeType: 'sub_activity', subModule, subActivity };
    }
  }
  return notFound('That checklist is not in this project.');
}

function findEntry(snapshot: Snapshot, entryId: string): ListAt & { entry: StepEntryView } {
  for (const list of allLists(snapshot)) {
    const entry = list.entries.find((candidate) => candidate.id === entryId);
    if (entry) return { ...findList(snapshot, list.id), entry };
  }
  return notFound('That step is not here.');
}

/** Rewrites every checklist; returning null drops one. */
function mapLists(
  snapshot: Snapshot,
  fn: (list: StepListView) => StepListView | null,
): Snapshot {
  const each = (lists: StepListView[]) =>
    lists.map(fn).filter((list): list is StepListView => list !== null);
  return {
    ...snapshot,
    sub_modules: snapshot.sub_modules.map((subModule) => ({
      ...subModule,
      step_lists: each(subModule.step_lists),
      sub_activities: subModule.sub_activities.map((subActivity) => ({
        ...subActivity,
        step_lists: each(subActivity.step_lists),
      })),
    })),
  };
}

/** Adds a list to one sub-module or sub-activity. */
function attachList(
  snapshot: Snapshot,
  scopeType: 'sub_module' | 'sub_activity',
  scopeId: string,
  list: StepListView,
): Snapshot {
  return {
    ...snapshot,
    sub_modules: snapshot.sub_modules.map((subModule) =>
      scopeType === 'sub_module'
        ? subModule.id === scopeId
          ? { ...subModule, step_lists: [...subModule.step_lists, list] }
          : subModule
        : {
            ...subModule,
            sub_activities: subModule.sub_activities.map((subActivity) =>
              subActivity.id === scopeId
                ? { ...subActivity, step_lists: [...subActivity.step_lists, list] }
                : subActivity,
            ),
          },
    ),
  };
}

function definitionOf(snapshot: Snapshot, id: string): StepDefinitionView {
  return snapshot.step_library.find((definition) => definition.id === id) ?? notFound('That step is not in this project.');
}

/** A fresh, untouched entry for a definition. The gate fields are filled in by `rederive`. */
function newEntry(definition: StepDefinitionView): StepEntryView {
  return {
    id: newId(),
    definition_id: definition.id,
    name: definition.name,
    description: definition.description,
    state: 'todo',
    blocked_reason: null,
    changed_by: null,
    changed_at: null,
    allowed_roles: definition.role_names,
    can_tick: false,
    is_override_for_me: false,
    locked_reason: '',
    history: [],
    comments: [],
  };
}

function wordForState(state: string): string {
  return state === 'todo' ? 'not done' : state;
}

function stepsAudit(snapshot: Snapshot, at: ListAt | null, what: string): Snapshot {
  return audited(snapshot, {
    scope: at ? 'module' : 'project',
    label: 'STEPS',
    what,
    moduleId: at?.subModule.id ?? null,
  });
}

function routeSteps(snapshot: Snapshot, at: At, body: Body): Result | null {
  const plain = (data: Snapshot): Result => ({ data, meta: {} });

  // -- the library ----------------------------------------------------------
  if (at('steps/library', 'POST')) {
    must(snapshot, 'project.config');
    const name = requireText(body.name, 'A step needs a name.', 160);
    const roleIds = checkRoleIds(snapshot, body.role_ids);
    const definition: StepDefinitionView = {
      id: newId(),
      name,
      description: typeof body.description === 'string' ? body.description.trim() : '',
      role_ids: roleIds,
      role_names: [],
      used_in: 0,
    };
    return plain(
      stepsAudit(
        { ...snapshot, step_library: [...snapshot.step_library, definition] },
        null,
        `step added to the library — ${name}`,
      ),
    );
  }

  const libraryPatch = at('steps/library/:id', 'PATCH');
  if (libraryPatch) {
    must(snapshot, 'project.config');
    const definition = definitionOf(snapshot, libraryPatch.id!);
    const name =
      body.name === undefined || body.name === null
        ? definition.name
        : requireText(body.name, 'A step needs a name.', 160);
    const next: StepDefinitionView = {
      ...definition,
      name,
      description:
        typeof body.description === 'string' ? body.description.trim() : definition.description,
      // Narrowing the roles never touches what has been recorded — only who may tick next.
      role_ids:
        body.role_ids === undefined || body.role_ids === null
          ? definition.role_ids
          : checkRoleIds(snapshot, body.role_ids),
    };
    return plain(
      stepsAudit(
        {
          ...snapshot,
          step_library: snapshot.step_library.map((candidate) =>
            candidate.id === definition.id ? next : candidate,
          ),
        },
        null,
        `step updated — ${name}`,
      ),
    );
  }

  const libraryDelete = at('steps/library/:id', 'DELETE');
  if (libraryDelete) {
    must(snapshot, 'project.config');
    const definition = definitionOf(snapshot, libraryDelete.id!);
    // Retired, not deleted: it leaves the library and every checklist it was on, as on the
    // server, where a retired step's entries are left out when a list is read.
    const without = mapLists(
      { ...snapshot, step_library: snapshot.step_library.filter((d) => d.id !== definition.id) },
      (list) => ({ ...list, entries: list.entries.filter((entry) => entry.definition_id !== definition.id) }),
    );
    return plain(
      stepsAudit(without, null, `step retired — ${definition.name}, keeping everything recorded against it`),
    );
  }

  // -- checklists -----------------------------------------------------------
  if (at('steps/lists', 'POST')) {
    const scopeType = parseScope(
      body.scope_type,
      'A checklist attaches to a "sub_module" or a "sub_activity".',
    );
    must(snapshot, 'project.config');
    const scopeId = String(body.scope_id ?? '');

    if (scopeType === 'module') {
      // A module-level checklist is a template for sub-modules created later. The Configure
      // screen does not offer it, and nothing in the demo would read it.
      invalid('In the demo a checklist attaches to a sub-module or a sub-activity.');
    }
    const subModule =
      scopeType === 'sub_module'
        ? snapshot.sub_modules.find((candidate) => candidate.id === scopeId)
        : snapshot.sub_modules.find((candidate) => candidate.sub_activities.some((sub) => sub.id === scopeId));
    if (!subModule) {
      notFound(
        scopeType === 'sub_module'
          ? 'That sub-module is not in this project.'
          : 'That sub-activity is not in this project.',
      );
    }

    const name = requireText(body.name, 'A configuration needs a name.', 160);
    const stepIds = Array.isArray(body.step_ids) ? body.step_ids.map(String) : [];
    const entries = stepIds.map((id) => newEntry(definitionOf(snapshot, id)));

    const list: StepListView = {
      id: newId(),
      name,
      scope_type: scopeType,
      scope_id: scopeId,
      created_at: new Date().toISOString(),
      enforce_order: body.enforce_order === true,
      readiness: 0,
      done_count: 0,
      blocked_count: 0,
      entries,
    };

    return plain(
      audited(attachList(snapshot, scopeType, scopeId, list), {
        scope: 'module',
        label: 'STEPS',
        what: `checklist added — ${name}, ${entries.length} ${entries.length === 1 ? 'step' : 'steps'}`,
        moduleId: subModule.id,
      }),
    );
  }

  const listPatch = at('steps/lists/:id', 'PATCH');
  if (listPatch) {
    must(snapshot, 'project.config');
    const found = findList(snapshot, listPatch.id!);
    const name =
      body.name === undefined || body.name === null
        ? found.list.name
        : requireText(body.name, 'A configuration needs a name.', 160);
    const enforce =
      body.enforce_order === undefined || body.enforce_order === null
        ? found.list.enforce_order
        : body.enforce_order === true;
    const orderNote =
      enforce === found.list.enforce_order
        ? ''
        : enforce
          ? ', now in a strict order'
          : ', steps may now be done in any order';

    return plain(
      stepsAudit(
        mapLists(snapshot, (list) =>
          list.id === found.list.id ? { ...list, name, enforce_order: enforce } : list,
        ),
        found,
        `checklist updated — ${name}${orderNote}`,
      ),
    );
  }

  const listDelete = at('steps/lists/:id', 'DELETE');
  if (listDelete) {
    must(snapshot, 'project.config');
    const found = findList(snapshot, listDelete.id!);
    return plain(
      stepsAudit(
        mapLists(snapshot, (list) => (list.id === found.list.id ? null : list)),
        found,
        `checklist removed — ${found.list.name}, keeping its history`,
      ),
    );
  }

  const listOrder = at('steps/lists/:id/order', 'PATCH');
  if (listOrder) {
    must(snapshot, 'project.config');
    const found = findList(snapshot, listOrder.id!);
    const ids = Array.isArray(body.entry_ids) ? body.entry_ids.map(String) : [];
    const current = found.list.entries.map((entry) => entry.id);
    if (
      ids.length !== current.length ||
      new Set(ids).size !== ids.length ||
      !ids.every((id) => current.includes(id))
    ) {
      invalid('A reorder has to list every step in the checklist exactly once.');
    }
    return plain(
      stepsAudit(
        mapLists(snapshot, (list) =>
          list.id === found.list.id
            ? {
                ...list,
                entries: ids.map((id) => list.entries.find((entry) => entry.id === id)!),
              }
            : list,
        ),
        found,
        `checklist reordered — ${found.list.name}`,
      ),
    );
  }

  /**
   * "Apply to all" — a copy of this checklist on every other sub-module of one module.
   *
   * Copies the steps and the order rule, never the progress: a tick on one sub-module says
   * nothing about another. One that already has a list of the same name is skipped.
   */
  const listApply = at('steps/lists/:id/apply', 'POST');
  if (listApply) {
    must(snapshot, 'project.config');
    const found = findList(snapshot, listApply.id!);
    const moduleName = String(body.module_name ?? '');
    if (found.list.entries.length === 0) {
      invalid(`"${found.list.name}" has no steps on it yet, so there is nothing to apply.`);
    }
    const targets = snapshot.sub_modules.filter(
      (subModule) => subModule.module_name === moduleName && subModule.id !== found.list.scope_id,
    );
    if (targets.length === 0) invalid(`There are no other sub-modules on ${moduleName} to apply it to.`);

    let next = snapshot;
    let applied = 0;
    for (const target of targets) {
      if (target.step_lists.some((list) => list.name === found.list.name)) continue;
      applied++;
      next = attachList(next, 'sub_module', target.id, {
        id: newId(),
        name: found.list.name,
        scope_type: 'sub_module',
        scope_id: target.id,
        created_at: new Date().toISOString(),
        enforce_order: found.list.enforce_order,
        readiness: 0,
        done_count: 0,
        blocked_count: 0,
        entries: found.list.entries.map((entry) => ({
          ...newEntry(definitionOf(snapshot, entry.definition_id)),
        })),
      });
    }

    return {
      data: audited(next, {
        scope: 'project',
        label: 'STEPS',
        what:
          `checklist applied — ${found.list.name} to ${applied} ${applied === 1 ? 'sub-module' : 'sub-modules'} on ${moduleName}` +
          (applied !== targets.length ? ', skipping those that already had it' : ''),
      }),
      meta: { applied },
    };
  }

  const entryAdd = at('steps/lists/:id/entries', 'POST');
  if (entryAdd) {
    must(snapshot, 'project.config');
    const found = findList(snapshot, entryAdd.id!);
    const definition = definitionOf(snapshot, String(body.step_id ?? ''));
    if (found.list.entries.some((entry) => entry.definition_id === definition.id)) {
      throw new ApiError('conflict', `${definition.name} is already in ${found.list.name}.`, 409);
    }
    return plain(
      stepsAudit(
        mapLists(snapshot, (list) =>
          list.id === found.list.id ? { ...list, entries: [...list.entries, newEntry(definition)] } : list,
        ),
        found,
        `step added to ${found.list.name} — ${definition.name}`,
      ),
    );
  }

  const entryDelete = at('steps/entries/:id', 'DELETE');
  if (entryDelete) {
    must(snapshot, 'project.config');
    const found = findEntry(snapshot, entryDelete.id!);
    if (found.entry.state !== 'todo') {
      invalid(
        `${found.entry.name} has been ticked or blocked on this checklist, and removing it would destroy that record along with its comments. Retire the step in the library instead — it leaves every screen and keeps its history.`,
      );
    }
    return plain(
      stepsAudit(
        mapLists(snapshot, (list) =>
          list.id === found.list.id
            ? { ...list, entries: list.entries.filter((entry) => entry.id !== found.entry.id) }
            : list,
        ),
        found,
        `step removed from ${found.list.name} — ${found.entry.name}`,
      ),
    );
  }

  /**
   * Tick, un-tick, block. The rules, in the service's order: the reason a block needs, the
   * list's order (ticking only), then the role gate — which an admin may pass as a recorded
   * override. Every transition is appended to the history; nothing is rewritten.
   */
  const entryPatch = at('steps/entries/:id', 'PATCH');
  if (entryPatch) {
    const target = String(body.state ?? '').trim().toLowerCase();
    if (target !== 'todo' && target !== 'done' && target !== 'blocked') {
      invalid('A step is "todo", "done" or "blocked".');
    }
    must(snapshot, 'project.view');
    const found = findEntry(snapshot, entryPatch.id!);
    const { entry, list } = found;
    if (entry.state === target) return plain(snapshot);

    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (target === 'blocked' && !reason) {
      invalid(
        `Blocking "${entry.name}" needs a reason in writing. "Blocked" on its own tells nobody what to do about it.`,
      );
    }

    if (target === 'done' && list.enforce_order) {
      const index = list.entries.findIndex((candidate) => candidate.id === entry.id);
      const blocker = list.entries.slice(0, index).find((candidate) => candidate.state !== 'done');
      if (blocker) invalid(`${list.name} runs in a strict order, and "${blocker.name}" is not done yet.`);
    }

    const definition = snapshot.step_library.find((d) => d.id === entry.definition_id);
    const roleIds =
      definition?.role_ids ??
      snapshot.roles.filter((role) => entry.allowed_roles.includes(role.name)).map((role) => role.id);
    const liveNames = snapshot.roles
      .filter((role) => roleIds.includes(role.id))
      .map((role) => role.name)
      .sort((a, b) => a.localeCompare(b));
    const mayTick = roleIds.length > 0 && myRoleIds(snapshot).some((id) => roleIds.includes(id));
    const canConfigure = hasPermission(new Set(snapshot.me.permissions), 'project.config');

    if (!mayTick && !canConfigure) {
      throw new ApiError(
        'forbidden',
        liveNames.length === 0
          ? `"${entry.name}" names no role that still exists, so nobody can tick it. An admin picks one on the Configure screen; everything already recorded stands.`
          : `Only ${liveNames.join(' or ')} may tick "${entry.name}".`,
        403,
      );
    }
    const override = !mayTick;
    const now = new Date().toISOString();

    const event = {
      id: newId(),
      from: entry.state,
      to: target,
      what: `${wordForState(entry.state)} → ${wordForState(target)}`,
      is_override: override,
      reason: reason || null,
      by: snapshot.me.display_name,
      at: now,
    };

    const next = mapLists(snapshot, (candidate) =>
      candidate.id !== list.id
        ? candidate
        : {
            ...candidate,
            entries: candidate.entries.map((row) =>
              row.id !== entry.id
                ? row
                : {
                    ...row,
                    state: target,
                    blocked_reason: target === 'blocked' ? reason : null,
                    changed_by: snapshot.me.display_name,
                    changed_at: now,
                    // Newest first, as the server sends it.
                    history: [event, ...row.history],
                  },
            ),
          },
    );

    // The step.blocked and step.ready notifications go to owners and to the next step's role
    // holders, never to whoever acted. The demo has one signed-in person, so there is nobody
    // else whose inbox could show them; they are not invented here.
    const onBehalf = override
      ? ` (on behalf of ${liveNames.length ? liveNames.join(' or ') : 'a role that no longer exists'})`
      : '';
    return plain(
      audited(next, {
        scope: 'module',
        label: 'STEPS',
        what: `${entry.name} — ${wordForState(entry.state)} → ${wordForState(target)}${onBehalf}${target === 'blocked' ? ` — ${reason}` : ''}`,
        moduleId: found.subModule.id,
      }),
    );
  }

  const commentAdd = at('steps/entries/:id/comments', 'POST');
  if (commentAdd) {
    must(snapshot, 'project.view');
    const found = findEntry(snapshot, commentAdd.id!);
    const text = requireText(body.body, 'A comment cannot be empty.', 4000);
    const comment = {
      id: newId(),
      author: snapshot.me.display_name,
      body: text,
      created_at: new Date().toISOString(),
      mine: true,
    };
    return plain(
      mapLists(snapshot, (list) =>
        list.id !== found.list.id
          ? list
          : {
              ...list,
              entries: list.entries.map((row) =>
                row.id === found.entry.id ? { ...row, comments: [...row.comments, comment] } : row,
              ),
            },
      ),
    );
  }

  const commentDelete = at('steps/comments/:id', 'DELETE');
  if (commentDelete) {
    const owner = allLists(snapshot)
      .flatMap((list) => list.entries)
      .flatMap((entry) => entry.comments)
      .find((comment) => comment.id === commentDelete.id);
    if (!owner) notFound('That comment does not exist.');
    if (!owner.mine && !hasPermission(new Set(snapshot.me.permissions), 'project.config')) {
      throw new ApiError('forbidden', 'Only the author or an admin can remove a comment.', 403);
    }
    return plain(
      mapLists(snapshot, (list) => ({
        ...list,
        entries: list.entries.map((entry) => ({
          ...entry,
          comments: entry.comments.filter((comment) => comment.id !== owner.id),
        })),
      })),
    );
  }

  return null;
}

/** Role ids a step may name: real roles in this organisation. Hidden ones still count. */
function checkRoleIds(snapshot: Snapshot, value: unknown): string[] {
  const ids = Array.isArray(value) ? value.map(String) : [];
  for (const id of ids) {
    if (!snapshot.roles.some((role) => role.id === id)) invalid('That is not a role in this organisation.');
  }
  return [...new Set(ids)];
}

// ---------------------------------------------------------------------------
// Owners and discussions — at all three levels
// ---------------------------------------------------------------------------

interface Attachments {
  owners: OwnerGroupView[];
  threads: ThreadView[];
}

/** Rewrites the owners and threads of every module, sub-module and sub-activity. */
function mapAttachments(
  snapshot: Snapshot,
  fn: (scopeType: ScopeType, scopeId: string, current: Attachments) => Attachments,
): Snapshot {
  return {
    ...snapshot,
    config: {
      ...snapshot.config,
      modules: snapshot.config.modules.map((module) => ({
        ...module,
        ...fn('module', module.id, { owners: module.owners, threads: module.threads }),
      })),
    },
    sub_modules: snapshot.sub_modules.map((subModule) => ({
      ...subModule,
      ...fn('sub_module', subModule.id, { owners: subModule.owners, threads: subModule.threads }),
      sub_activities: subModule.sub_activities.map((subActivity) => ({
        ...subActivity,
        ...fn('sub_activity', subActivity.id, {
          owners: subActivity.owners,
          threads: subActivity.threads,
        }),
      })),
    })),
  };
}

/** Where a scope sits, for the audit row and the wording of it. */
function describeScope(
  snapshot: Snapshot,
  scopeType: ScopeType,
  scopeId: string,
): { what: string; moduleId: string | null; exists: boolean } {
  if (scopeType === 'module') {
    const module = snapshot.config.modules.find((candidate) => candidate.id === scopeId);
    return { what: module ? module.name : 'a module', moduleId: null, exists: Boolean(module) };
  }
  for (const subModule of snapshot.sub_modules) {
    if (scopeType === 'sub_module' && subModule.id === scopeId) {
      return { what: `${subModule.module_name} · ${subModule.name}`, moduleId: subModule.id, exists: true };
    }
    const subActivity = subModule.sub_activities.find((candidate) => candidate.id === scopeId);
    if (scopeType === 'sub_activity' && subActivity) {
      return {
        what: `${subModule.module_name} · ${subModule.name} → ${subActivity.name}`,
        moduleId: subModule.id,
        exists: true,
      };
    }
  }
  return {
    what: scopeType === 'sub_module' ? 'a sub-module' : 'a sub-activity',
    moduleId: null,
    exists: false,
  };
}

function scopedAudit(
  snapshot: Snapshot,
  scopeType: ScopeType,
  scopeId: string,
  label: string,
  what: string,
): Snapshot {
  const where = describeScope(snapshot, scopeType, scopeId);
  return audited(snapshot, {
    scope: scopeType === 'module' ? 'project' : 'module',
    label,
    what,
    moduleId: where.moduleId,
  });
}

/** Every owner row, wherever it sits. */
function findOwner(snapshot: Snapshot, ownerId: string) {
  let found: { scopeType: ScopeType; scopeId: string; name: string } | null = null;
  mapAttachments(snapshot, (scopeType, scopeId, current) => {
    for (const group of current.owners) {
      const person = group.people.find((candidate) => candidate.owner_id === ownerId);
      if (person) found = { scopeType, scopeId, name: person.display_name };
    }
    return current;
  });
  return found as { scopeType: ScopeType; scopeId: string; name: string } | null;
}

function findThread(snapshot: Snapshot, threadId: string) {
  let found: { scopeType: ScopeType; scopeId: string; thread: ThreadView } | null = null;
  mapAttachments(snapshot, (scopeType, scopeId, current) => {
    const thread = current.threads.find((candidate) => candidate.id === threadId);
    if (thread) found = { scopeType, scopeId, thread };
    return current;
  });
  return found as { scopeType: ScopeType; scopeId: string; thread: ThreadView } | null;
}

/**
 * Who an @handle in a comment names — the service's `Discussions.mentionedIn`.
 *
 * Each person answers to their display name and their email's local part, longest handle
 * first and case-insensitively, and a matched span is blanked so "@Paras" cannot also match
 * inside "@Paras Mahajan".
 */
function mentionedIn(text: string, users: Snapshot['users']): string[] {
  const handles = users
    .filter((user) => user.status !== 'deactivated')
    .flatMap((user) => [
      { id: user.id, handle: user.display_name.trim() },
      { id: user.id, handle: user.email.split('@')[0] ?? '' },
    ])
    .filter((candidate) => candidate.handle)
    .sort((a, b) => b.handle.length - a.handle.length);

  let haystack = text.toLowerCase();
  const found = new Set<string>();
  for (const candidate of handles) {
    const needle = `@${candidate.handle.toLowerCase()}`;
    let from = 0;
    for (;;) {
      const index = haystack.indexOf(needle, from);
      if (index < 0) break;
      const after = haystack[index + needle.length];
      if (after === undefined || !/[\p{L}\p{N}]/u.test(after)) {
        found.add(candidate.id);
        haystack =
          haystack.slice(0, index) + ' '.repeat(needle.length) + haystack.slice(index + needle.length);
        break;
      }
      from = index + 1;
    }
  }
  return [...found];
}

function newComment(snapshot: Snapshot, text: string): { comment: ThreadCommentView; mentioned: string[] } {
  const mentioned = mentionedIn(text, snapshot.users).filter((id) => id !== snapshot.me.user_id);
  return {
    comment: {
      id: newId(),
      author: snapshot.me.display_name,
      body: text,
      created_at: new Date().toISOString(),
      mine: true,
      // The author is never notified of their own mention.
      mentions_me: false,
    },
    mentioned,
  };
}

function mentionMeta(snapshot: Snapshot, mentioned: string[]): Record<string, unknown> {
  // A mention notifies the person named, in *their* inbox. The demo has one signed-in
  // account, so the names are returned for the screen rather than delivered anywhere.
  return {
    mentioned: mentioned.map(
      (id) => snapshot.users.find((user) => user.id === id)?.display_name ?? 'someone',
    ),
  };
}

function routeCollaboration(snapshot: Snapshot, at: At, body: Body): Result | null {
  const plain = (data: Snapshot): Result => ({ data, meta: {} });
  const canConfigure = hasPermission(new Set(snapshot.me.permissions), 'project.config');

  // -- owners ---------------------------------------------------------------
  if (at('owners', 'POST')) {
    if (body.user_id === undefined || body.user_id === null || body.user_id === '') {
      invalid('An owner is a person — send the account to assign.');
    }
    const scopeType = parseScope(
      body.scope_type,
      'An owner attaches to a "module", a "sub_module" or a "sub_activity".',
    );
    must(snapshot, 'module.edit');
    const scopeId = String(body.scope_id ?? '');
    const user = snapshot.users.find((candidate) => candidate.id === body.user_id);
    if (!user) notFound('That person is not in this organisation.');
    if (user.status === 'deactivated') {
      invalid(`${user.display_name} is deactivated. A deactivated account cannot own anything.`);
    }
    const roleId = (body.role_id as string | null | undefined) || null;
    const role = roleId ? snapshot.roles.find((candidate) => candidate.id === roleId) : null;
    if (roleId && !role) notFound('That team does not exist.');
    if (role?.hidden) {
      invalid(
        `${role.name} is hidden in this organisation, so it is not a team anything can be owned for. Show it again on the Access screen first.`,
      );
    }
    if (!describeScope(snapshot, scopeType, scopeId).exists) {
      notFound(`That ${scopeType.replace('_', '-')} is not in this project.`);
    }

    const person = {
      owner_id: newId(),
      user_id: user.id,
      display_name: user.display_name,
      email: user.email,
    };
    const next = mapAttachments(snapshot, (type, id, current) => {
      if (type !== scopeType || id !== scopeId) return current;
      const existing = current.owners.find((group) => group.role_id === roleId);
      const owners = existing
        ? current.owners.map((group) =>
            group === existing ? { ...group, people: [...group.people, person] } : group,
          )
        : [...current.owners, { role_id: roleId, label: role?.name ?? 'Overall', people: [person] }];
      // Overall first, then the teams alphabetically — the server's order, so it cannot
      // shuffle between renders.
      owners.sort((a, b) => {
        if (a.role_id === null) return -1;
        if (b.role_id === null) return 1;
        return a.label.localeCompare(b.label);
      });
      return { ...current, owners };
    });

    return plain(
      scopedAudit(
        next,
        scopeType,
        scopeId,
        'OWNERS',
        `owner added — ${user.display_name} for ${role?.name ?? 'Overall owner'} on ${describeScope(snapshot, scopeType, scopeId).what}`,
      ),
    );
  }

  const ownerDelete = at('owners/:id', 'DELETE');
  if (ownerDelete) {
    must(snapshot, 'module.edit');
    const found = findOwner(snapshot, ownerDelete.id!);
    if (!found) notFound('That owner is not in this project.');
    const next = mapAttachments(snapshot, (_type, _id, current) => ({
      ...current,
      owners: current.owners
        .map((group) => ({
          ...group,
          people: group.people.filter((person) => person.owner_id !== ownerDelete.id),
        }))
        // Only groups with somebody in them are sent — an emptied team simply leaves.
        .filter((group) => group.people.length > 0),
    }));
    return plain(
      scopedAudit(
        next,
        found.scopeType,
        found.scopeId,
        'OWNERS',
        `owner removed — ${found.name} from ${describeScope(snapshot, found.scopeType, found.scopeId).what}`,
      ),
    );
  }

  // -- discussions ----------------------------------------------------------
  if (at('discussions/threads', 'POST')) {
    const scopeType = parseScope(
      body.scope_type,
      'A topic attaches to a "module", a "sub_module" or a "sub_activity".',
    );
    must(snapshot, 'project.view');
    const topic = requireText(body.topic, 'A topic needs a title.', 240);
    const scopeId = String(body.scope_id ?? '');
    if (scopeType !== 'module' && !describeScope(snapshot, scopeType, scopeId).exists) {
      notFound(
        scopeType === 'sub_module'
          ? 'That sub-module is not in this project.'
          : 'That sub-activity is not in this project.',
      );
    }

    const opening = typeof body.body === 'string' && body.body.trim() ? body.body.trim() : null;
    if (opening && opening.length > 4000) {
      invalid('That is longer than the 4000 characters this field holds.');
    }
    const first = opening ? newComment(snapshot, opening) : null;
    const thread: ThreadView = {
      id: newId(),
      topic,
      opened_by: snapshot.me.display_name,
      opened_at: new Date().toISOString(),
      mine: true,
      mentions_me: false,
      comments: first ? [first.comment] : [],
    };

    const next = mapAttachments(snapshot, (type, id, current) =>
      type === scopeType && id === scopeId
        ? // Newest first, as the server sends them.
          { ...current, threads: [thread, ...current.threads] }
        : current,
    );
    return {
      data: scopedAudit(next, scopeType, scopeId, 'TOPIC', `topic raised — ${topic}`),
      meta: mentionMeta(snapshot, first?.mentioned ?? []),
    };
  }

  const threadComment = at('discussions/threads/:id/comments', 'POST');
  if (threadComment) {
    must(snapshot, 'project.view');
    const found = findThread(snapshot, threadComment.id!);
    if (!found) notFound('That topic is not in this project.');
    const text = requireText(body.body, 'A comment cannot be empty.', 4000);
    const { comment, mentioned } = newComment(snapshot, text);
    const next = mapAttachments(snapshot, (_type, _id, current) => ({
      ...current,
      threads: current.threads.map((thread) =>
        thread.id === found.thread.id ? { ...thread, comments: [...thread.comments, comment] } : thread,
      ),
    }));
    return { data: next, meta: mentionMeta(snapshot, mentioned) };
  }

  const threadDelete = at('discussions/threads/:id', 'DELETE');
  if (threadDelete) {
    const found = findThread(snapshot, threadDelete.id!);
    if (!found) notFound('That topic is not in this project.');
    if (!found.thread.mine && !canConfigure) {
      throw new ApiError('forbidden', 'Only whoever raised this topic, or an admin, can close it.', 403);
    }
    const next = mapAttachments(snapshot, (_type, _id, current) => ({
      ...current,
      threads: current.threads.filter((thread) => thread.id !== found.thread.id),
    }));
    return plain(
      scopedAudit(
        next,
        found.scopeType,
        found.scopeId,
        'TOPIC',
        `topic closed — ${found.thread.topic}, keeping everything said on it`,
      ),
    );
  }

  const commentDelete = at('discussions/comments/:id', 'DELETE');
  if (commentDelete) {
    let target: ThreadCommentView | null = null;
    mapAttachments(snapshot, (_type, _id, current) => {
      for (const thread of current.threads) {
        target = thread.comments.find((comment) => comment.id === commentDelete.id) ?? target;
      }
      return current;
    });
    const comment = target as ThreadCommentView | null;
    if (!comment) notFound('That comment does not exist.');
    if (!comment.mine && !canConfigure) {
      throw new ApiError('forbidden', 'Only the author or an admin can remove a comment.', 403);
    }
    return plain(
      mapAttachments(snapshot, (_type, _id, current) => ({
        ...current,
        threads: current.threads.map((thread) => ({
          ...thread,
          comments: thread.comments.filter((candidate) => candidate.id !== comment.id),
        })),
      })),
    );
  }

  // -- the inbox ------------------------------------------------------------
  // No permission and no audit, as on the server: reading your own inbox changes nothing
  // anybody else can see.
  const readOne = at('notifications/:id/read', 'POST');
  if (readOne) {
    return plain({
      ...snapshot,
      notifications: snapshot.notifications.map((row) =>
        row.id === readOne.id ? { ...row, unread: false } : row,
      ),
    });
  }

  if (at('notifications/read', 'POST')) {
    return plain({
      ...snapshot,
      notifications: snapshot.notifications.map((row) => ({ ...row, unread: false })),
    });
  }

  return null;
}

// ---------------------------------------------------------------------------
// Configuration the first port missed
// ---------------------------------------------------------------------------

const DEFAULT_WORDS = {
  module_label: 'Module',
  sub_module_label: 'Sub-module',
  sub_activity_label: 'Sub-activity',
} as const;

function routeConfigExtras(snapshot: Snapshot, at: At, body: Body): Result | null {
  const plain = (data: Snapshot): Result => ({ data, meta: {} });

  /** What this project calls its three levels. Blank means back to the default. */
  if (at('config/vocabulary', 'PATCH')) {
    must(snapshot, 'project.config');
    const before = snapshot.project;
    const next = { ...before };
    for (const field of ['module_label', 'sub_module_label', 'sub_activity_label'] as const) {
      const value = body[field];
      if (value === undefined || value === null) continue;
      const trimmed = String(value).trim().slice(0, 40);
      next[field] = trimmed || DEFAULT_WORDS[field];
    }
    const unchanged =
      next.module_label === before.module_label &&
      next.sub_module_label === before.sub_module_label &&
      next.sub_activity_label === before.sub_activity_label;
    if (unchanged) return plain(snapshot);

    return plain(
      audited(
        { ...snapshot, project: next },
        {
          scope: 'project',
          label: 'CONFIG',
          what: `wording — ${before.module_label} / ${before.sub_module_label} / ${before.sub_activity_label} → ${next.module_label} / ${next.sub_module_label} / ${next.sub_activity_label}`,
        },
      ),
    );
  }

  const moduleDescription = at('config/modules/:id', 'PATCH');
  if (moduleDescription) {
    must(snapshot, 'module.edit');
    const module: ModuleView | undefined = snapshot.config.modules.find(
      (candidate) => candidate.id === moduleDescription.id,
    );
    if (!module) notFound('That module is not in this project.');
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (description.length > 500) invalid('That is longer than the 500 characters this field holds.');
    if (description === module.description) return plain(snapshot);

    return plain(
      audited(
        {
          ...snapshot,
          config: {
            ...snapshot.config,
            modules: snapshot.config.modules.map((candidate) =>
              candidate.id === module.id ? { ...candidate, description } : candidate,
            ),
          },
        },
        {
          scope: 'project',
          label: 'CONFIG',
          what: description ? `description updated — ${module.name}` : `description cleared — ${module.name}`,
        },
      ),
    );
  }

  /**
   * One deliverable tracked on every environment: a header with a column per environment
   * under it, and only prod counting toward readiness.
   */
  if (at('config/columns/grouped', 'POST')) {
    must(snapshot, 'project.config');
    const key = String(body.group_key ?? '').trim().toLowerCase();
    if (!key) invalid('A deliverable needs a key.');
    if (!/^[a-z0-9_]+$/.test(key)) {
      invalid('A key is lowercase letters, digits and underscores — it becomes part of every column name under this header.');
    }
    if (key.length > 24) invalid('That key is too long once an environment name is appended to it.');
    const label = requireText(body.group_label, 'A header needs a label.', 12);
    const allowed = validateAllowed(body.allowed);
    const full = typeof body.full === 'string' && body.full.trim() ? body.full.trim() : label;

    const environments = snapshot.config.environments;
    if (environments.length === 0) {
      invalid(
        'This project has no environments configured, so there is nothing to spread a deliverable across. Add a plain column instead.',
      );
    }
    if (snapshot.config.columns.some((column) => column.group_key === key)) {
      throw new ApiError('conflict', `This project already tracks ${label}.`, 409);
    }
    for (const environment of environments) {
      const columnKey = `${key}_${environment.key}`;
      if (snapshot.config.columns.some((column) => column.key === columnKey)) {
        throw new ApiError('conflict', `This project already has a column called ${columnKey}.`, 409);
      }
    }

    // One per environment, including any switched off — they come back with it.
    const added: ColumnView[] = environments.map((environment, index) => ({
      id: newId(),
      project_id: snapshot.project.id,
      key: `${key}_${environment.key}`,
      label: environment.short,
      full: `${full} — ${environment.label}`,
      allowed: [...allowed],
      counts: environment.key === PROD_ENVIRONMENT,
      order_index: snapshot.config.columns.length + index,
      off_vocabulary: 0,
      environment: environment.key,
      group_key: key,
      group_label: label,
      active: environment.enabled,
    }));

    return plain(
      audited(withColumnsAdded(snapshot, added), {
        scope: 'project',
        label: 'CONFIG',
        what: `deliverable added — ${label}, one column per environment (${added.length}), with only prod counting toward readiness`,
      }),
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Roles and people the first port missed
// ---------------------------------------------------------------------------

function routeAccessExtras(snapshot: Snapshot, at: At, body: Body): Result | null {
  const plain = (data: Snapshot): Result => ({ data, meta: {} });
  const accessAudit = (data: Snapshot, what: string) =>
    audited(data, { scope: 'project', label: 'ACCESS', what });

  if (at('roles', 'POST')) {
    must(snapshot, 'admin.roles.manage');
    const name = String(body.name ?? '').trim();
    if (!name) invalid('A role needs a name.');
    if (name.length > 80) invalid('That is longer than the 80 characters a role name holds.');
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!key) invalid(`A role name needs at least one letter or digit — "${name}" leaves nothing to key it by.`);
    if (key === 'admin' || snapshot.roles.some((role) => role.key === key)) {
      throw new ApiError('conflict', `This organisation already has a role called ${name}. Pick a different name.`, 409);
    }
    return plain(
      accessAudit(
        {
          ...snapshot,
          roles: [
            ...snapshot.roles,
            {
              id: newId(),
              key,
              name,
              note: typeof body.note === 'string' ? body.note.trim() : '',
              permissions: [],
              is_system: false,
              hidden: false,
              member_count: 0,
            },
          ],
        },
        `role added — ${name}, with no permissions until they are granted`,
      ),
    );
  }

  const rolePatch = at('roles/:id', 'PATCH');
  if (rolePatch) {
    must(snapshot, 'admin.roles.manage');
    const role = snapshot.roles.find((candidate) => candidate.id === rolePatch.id);
    if (!role) notFound('That role does not exist.');
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : role.name;
    const note = typeof body.note === 'string' ? body.note.trim() : role.note;
    if (name === role.name && note === role.note) return plain(snapshot);

    // A role's name is shown in a lot of places that each carry their own copy of it. The
    // server re-reads them all from the role; the demo has to carry the rename to each.
    const rename = (value: string) => (value === role.name ? name : value);
    const renameList = (value: string) => value.split(', ').map(rename).join(', ');
    const next: Snapshot = {
      ...snapshot,
      me: { ...snapshot.me, role_names: snapshot.me.role_names.map(rename) },
      roles: snapshot.roles.map((candidate) =>
        candidate.id === role.id ? { ...candidate, name, note } : candidate,
      ),
      members: snapshot.members.map((member) =>
        member.role_id === role.id ? { ...member, role_name: name } : member,
      ),
      users: snapshot.users.map((user) => ({ ...user, role_name: renameList(user.role_name) })),
      invitations: snapshot.invitations.map((invitation) => ({
        ...invitation,
        role_name: rename(invitation.role_name),
      })),
    };
    const withOwners = mapAttachments(next, (_type, _id, current) => ({
      ...current,
      owners: current.owners.map((group) => (group.role_id === role.id ? { ...group, label: name } : group)),
    }));
    const withSteps = mapLists(withOwners, (list) => ({
      ...list,
      entries: list.entries.map((entry) => ({ ...entry, allowed_roles: entry.allowed_roles.map(rename) })),
    }));

    return plain(
      accessAudit(
        withSteps,
        name === role.name ? `role note updated — ${name}` : `role renamed — ${role.name} → ${name}`,
      ),
    );
  }

  const roleVisibility = at('roles/:id/visibility', 'PATCH');
  if (roleVisibility) {
    must(snapshot, 'admin.roles.manage');
    const role = snapshot.roles.find((candidate) => candidate.id === roleVisibility.id);
    if (!role) notFound('That role does not exist.');
    const hidden = body.hidden === true;
    if (role.hidden === hidden) return plain(snapshot);
    if (hidden && role.key === 'admin') {
      invalid(
        'The admin role cannot be hidden — it is the one an administrator is assigned, and without it this organisation could not be administered at all.',
      );
    }
    if (hidden && role.member_count > 0) {
      const n = role.member_count;
      invalid(
        `${n} ${n === 1 ? 'person still holds' : 'people still hold'} ${role.name}. Move them to another role first — hiding it now would leave access granted through a role no screen shows.`,
      );
    }
    return plain(
      accessAudit(
        {
          ...snapshot,
          roles: snapshot.roles.map((candidate) =>
            candidate.id === role.id ? { ...candidate, hidden } : candidate,
          ),
        },
        hidden
          ? `role hidden — ${role.name}, keeping everything recorded against it`
          : `role shown again — ${role.name}`,
      ),
    );
  }

  const userPatch = at('users/:id', 'PATCH');
  if (userPatch) {
    if (!snapshot.me.is_super_admin) must(snapshot, 'admin.users.manage');
    const user = snapshot.users.find((candidate) => candidate.id === userPatch.id);
    if (!user) notFound('That person is not in this organisation.');
    const name = String(body.display_name ?? '').trim();
    if (!name) invalid('A name cannot be blank.');
    if (name.length > 120) invalid('A name is at most 120 characters.');
    if (name === user.display_name) return plain(snapshot);

    const renamed: Snapshot = {
      ...snapshot,
      me: snapshot.me.user_id === user.id ? { ...snapshot.me, display_name: name } : snapshot.me,
      users: snapshot.users.map((candidate) =>
        candidate.id === user.id ? { ...candidate, display_name: name } : candidate,
      ),
      members: snapshot.members.map((member) =>
        member.user_id === user.id ? { ...member, display_name: name } : member,
      ),
    };
    const withOwners = mapAttachments(renamed, (_type, _id, current) => ({
      ...current,
      owners: current.owners.map((group) => ({
        ...group,
        people: group.people.map((person) =>
          person.user_id === user.id ? { ...person, display_name: name } : person,
        ),
      })),
    }));
    return plain(accessAudit(withOwners, `renamed ${user.email} to ${name}`));
  }

  /**
   * A password reset. The demo has no accounts and sends no email, so it says so — and hands
   * back a link that is plainly a placeholder rather than one that looks real and goes nowhere.
   */
  const reset = at('users/:id/reset-password', 'POST');
  if (reset) {
    if (!snapshot.me.is_super_admin) must(snapshot, 'admin.users.manage');
    const user = snapshot.users.find((candidate) => candidate.id === reset.id);
    if (!user) notFound('That person is not in this organisation.');
    if (user.status === 'invited') {
      invalid(
        `${user.email} has not accepted their invitation yet, so there is no password to reset. Reissue the invitation instead.`,
      );
    }
    if (user.status === 'deactivated') {
      invalid(
        `${user.email} is deactivated. Reactivate the account first — a reset link into a disabled account would be a way back in that nothing on screen accounts for.`,
      );
    }

    const resetUrl = `#demo-reset-link-for-${user.email}-not-sent`;
    const detail = 'This is the offline demo: no email is sent, and the link below is a placeholder that opens nothing.';
    const notification: NotificationView = {
      id: newId(),
      kind: 'account',
      title: `Password reset for ${user.display_name}`,
      body: `${detail} In the real app it works once, expires in seven days, and cannot be shown again.`,
      link: '/access',
      at: new Date().toISOString(),
      unread: true,
    };
    return {
      data: accessAudit(
        { ...snapshot, notifications: [notification, ...snapshot.notifications] },
        `password reset link issued for ${user.email} (demo — nothing sent)`,
      ),
      meta: {
        email: user.email,
        display_name: user.display_name,
        reset_url: resetUrl,
        delivery_state: 'not_sent',
        delivery_detail: detail,
        demo: true,
      },
    };
  }

  return null;
}
