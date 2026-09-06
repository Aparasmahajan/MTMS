import { ApiError } from '@/lib/client/api';
import { clearSnapshot, loadSnapshot, saveSnapshot } from '@/lib/demo/persistence';
import { optimisticAdvance, withDerived } from '@/lib/client/optimistic';
import { DEFECT_STATUS_ORDER, type DefectStatus } from '@/lib/shared/domain';
import { hasPermission, permissionDeniedReason, type PermissionKey } from '@/lib/shared/permissions';
import { promotionGate } from '@/lib/shared/promotion';
import { BLANK, readiness, rollUp, statusEntry, STATUS_SETS, toneOf } from '@/lib/shared/vocabulary';
import type { CellView, ModuleView, Snapshot, SubactivityView } from '@/lib/shared/views';

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

export function initDemoRuntime(snapshot: Snapshot): void {
  if (current) return;

  // Anything this browser saved earlier wins over the baked seed — that is what makes an
  // edit survive a reload. Falling back to a deep copy of the seed keeps the prerendered
  // snapshot itself unmutated, so a client-side navigation back to a static page still
  // renders what was built.
  current = loadSnapshot() ?? structuredCloneish(snapshot);
}

/**
 * Adopts a snapshot produced by another tab.
 *
 * Updating `current` is the part that matters and the part that is easy to miss: without
 * it this tab would re-render the incoming state but still hold its own stale copy, and
 * the next click here would be applied to the old snapshot and silently undo the other
 * tab's change.
 */
export function adoptSnapshot(snapshot: Snapshot): void {
  current = snapshot;
}

export function demoSnapshot(): Snapshot {
  if (!current) throw new ApiError('internal', 'The demo has not been started.', 500);
  return current;
}

/** Puts the demo back to the seeded state, and forgets what was saved. */
export function resetDemo(seed: Snapshot): Snapshot {
  current = structuredCloneish(seed);
  clearSnapshot();
  saveSnapshot(current);
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

function moduleOf(snapshot: Snapshot, id: string): ModuleView {
  const module = snapshot.modules.find((candidate) => candidate.id === id);
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
    ? snapshot.modules.find((candidate) => candidate.id === entry.moduleId)
    : undefined;

  return {
    ...snapshot,
    audit: [
      {
        id: newId(),
        scope: entry.scope,
        module_id: entry.moduleId ?? null,
        module_label: module ? `${module.node_type} · ${module.name}` : '—',
        label: entry.label,
        what: entry.what,
        who: snapshot.me.display_name,
        at: new Date().toISOString(),
      },
      ...snapshot.audit,
    ],
  };
}

function replaceModule(snapshot: Snapshot, next: ModuleView): Snapshot {
  return {
    ...snapshot,
    modules: snapshot.modules.map((module) => (module.id === next.id ? next : module)),
  };
}

function blankCells(snapshot: Snapshot): CellView[] {
  return snapshot.config.columns.map((column) => ({
    column_key: column.key,
    status: BLANK,
    rolled_up: false,
    subactivity_count: 0,
    changed_by: null,
    changed_at: null,
  }));
}

/** Re-derives a module's own cells from its subactivities, then everything downstream. */
function reroll(snapshot: Snapshot, module: ModuleView): ModuleView {
  const subs = module.subactivities;
  const cells: CellView[] = module.cells.map((cell) =>
    subs.length === 0
      ? { ...cell, rolled_up: false, subactivity_count: 0 }
      : {
          ...cell,
          rolled_up: true,
          subactivity_count: subs.length,
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
  const counted = snapshot.config.columns.filter((column) => column.counts);
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
        for (const module of snapshot.modules) {
          const rows: readonly { cells: CellView[] }[] =
            module.subactivities.length > 0 ? module.subactivities : [module];
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

export function demoRequest(path: string, method: string, body: Body): Result {
  const snapshot = demoSnapshot();
  const next = route(snapshot, path, method, body);

  // The promotion gate reads module readiness and the drift verdicts, so it has to be
  // recomputed after anything that could move either — which, since a client can edit any
  // cell, is most requests. Same function the server uses.
  const data: Snapshot = {
    ...next.data,
    drift: {
      ...next.data.drift,
      gate: promotionGate(next.data.config.columns, next.data.modules, next.data.drift.rows),
    },
  };

  current = data;

  // The single write point for the whole in-browser store: persist, and tell the other
  // tabs. Every mutation funnels through here, so there is one place to get this right
  // rather than one per handler.
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
    const moduleId = String(body.module_id);
    const subactivityId = (body.subactivity_id as string | null) ?? null;
    const columnKey = String(body.column_key);

    const module = moduleOf(snapshot, moduleId);
    if (module.closed) {
      throw new ApiError('bad_request', 'This module is closed. Reopen it before changing a deliverable.', 400);
    }
    if (subactivityId === null && module.subactivities.length > 0) {
      throw new ApiError(
        'bad_request',
        'This module has subactivities, so its row is a roll-up. Change the subactivity instead.',
        400,
      );
    }

    const column = snapshot.config.columns.find((candidate) => candidate.key === columnKey);
    if (!column) throw new ApiError('not_found', 'That deliverable column is not configured.', 404);

    const before =
      subactivityId === null
        ? module.cells.find((cell) => cell.column_key === columnKey)?.status
        : module.subactivities
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
        ? advanced.modules.find((m) => m.id === moduleId)?.cells.find((c) => c.column_key === columnKey)?.status
        : advanced.modules
            .find((m) => m.id === moduleId)
            ?.subactivities.find((s) => s.id === subactivityId)
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
  const moduleParams = at('modules/:id', 'PATCH');
  if (moduleParams) {
    const module = moduleOf(snapshot, moduleParams.id!);
    let updated = module;
    let what = '';

    if (body.owner !== undefined) {
      must(snapshot, 'module.edit');
      const owner = (body.owner as string | null) || null;
      updated = { ...updated, owner };
      what = `owner set to ${owner ?? 'unassigned'}`;
    }
    if (body.fni_target_date !== undefined) {
      must(snapshot, 'fni.date');
      const date = (body.fni_target_date as string | null) || null;
      updated = { ...updated, fni_target_date: date };
      what = `FNI target date set to ${date ?? 'not set'}`;
    }

    return plain(
      audited(replaceModule(snapshot, updated), {
        scope: 'module',
        label: 'MODULE',
        what,
        moduleId: module.id,
      }),
    );
  }

  // -- FNI sign-off ---------------------------------------------------------
  const fniParams = at('modules/:id/fni', 'POST');
  if (fniParams) {
    must(snapshot, 'fni.signoff');
    const module = moduleOf(snapshot, fniParams.id!);
    const close = body.close === true;

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

    const updated: ModuleView = {
      ...module,
      closed: close,
      closed_by: close ? snapshot.me.display_name : null,
    };
    return plain(
      audited(replaceModule(snapshot, updated), {
        scope: 'module',
        label: 'MODULE',
        what: close ? 'FNI signed off — module closed' : 'reopened',
        moduleId: module.id,
      }),
    );
  }

  // -- DevOps prod confirmation --------------------------------------------
  const confirmParams = at('modules/:id/confirm-prod', 'POST');
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

    let updated: ModuleView =
      module.subactivities.length > 0
        ? {
            ...module,
            subactivities: module.subactivities.map((sub) => {
              const cells = applyRow(sub.cells);
              return { ...sub, cells, readiness: subReadiness(snapshot, cells) };
            }),
          }
        : { ...module, cells: applyRow(module.cells) };

    updated = reroll(snapshot, updated);

    return {
      data: recountOffVocabulary(
        audited(replaceModule(snapshot, updated), {
          scope: 'cell',
          label: 'ALL',
          what: `${changed} cells confirmed loaded in prod`,
          moduleId: module.id,
        }),
      ),
      meta: { changed },
    };
  }

  // -- links ----------------------------------------------------------------
  const linkParams = at('modules/:id/links', 'POST');
  if (linkParams) {
    must(snapshot, 'module.edit');
    const module = moduleOf(snapshot, linkParams.id!);
    const url = String(body.url ?? '').trim();
    if (!url) throw new ApiError('validation_failed', 'A link needs a URL.', 422);

    const updated: ModuleView = {
      ...module,
      links: [
        ...module.links,
        {
          id: newId(),
          type: String(body.type ?? 'Repo'),
          label: String(body.label ?? '').trim() || url,
          url,
        },
      ],
    };
    return plain(replaceModule(snapshot, updated));
  }

  const linkDelete = at('links/:id', 'DELETE');
  if (linkDelete) {
    must(snapshot, 'module.edit');
    return plain({
      ...snapshot,
      modules: snapshot.modules.map((module) => ({
        ...module,
        links: module.links.filter((link) => link.id !== linkDelete.id),
      })),
    });
  }

  // -- modules --------------------------------------------------------------
  if (at('modules', 'POST')) {
    must(snapshot, 'module.create');
    const nodeType = String(body.node_type ?? '').trim();
    const name = String(body.name ?? '').trim();
    if (
      snapshot.modules.some(
        (module) => module.node_type === nodeType && module.name === name,
      )
    ) {
      throw new ApiError('validation_failed', 'That node type and activity already exist in this project.', 422);
    }

    const created = withDerived(
      {
        id: newId(),
        node_type: nodeType,
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
        subactivities: [],
        links: [],
        last_run: null,
      },
      snapshot.config.columns,
      snapshot.config.stages.length,
    );

    const withNodeType = snapshot.config.node_types.includes(nodeType)
      ? snapshot.config
      : { ...snapshot.config, node_types: [...snapshot.config.node_types, nodeType] };

    const library =
      body.add_to_library === true
        ? [
            ...snapshot.library,
            {
              id: newId(),
              node_type: nodeType,
              name,
              version: 'v1',
              subactivity_count: 0,
              used_in_projects: 1,
              in_this_project: true,
            },
          ]
        : snapshot.library;

    return {
      data: audited(
        { ...snapshot, config: withNodeType, library, modules: [...snapshot.modules, created] },
        { scope: 'module', label: 'MODULE', what: `created ${nodeType} · ${name}`, moduleId: created.id },
      ),
      meta: { module_id: created.id, node_type: nodeType },
    };
  }

  // -- subactivities --------------------------------------------------------
  const subAdd = at('modules/:id/subactivities', 'POST');
  if (subAdd) {
    must(snapshot, 'module.edit');
    const module = moduleOf(snapshot, subAdd.id!);
    if (module.closed) throw new ApiError('bad_request', 'This module is closed.', 400);

    // Adding the first subactivity moves the module's own row onto it, so readiness
    // does not jump when a module gains its first child.
    const seededCells: CellView[] =
      module.subactivities.length === 0
        ? module.cells.map((cell) => ({ ...cell, rolled_up: false, subactivity_count: 0 }))
        : blankCells(snapshot);

    const created: SubactivityView = {
      id: newId(),
      name: String(body.name ?? '').trim(),
      readiness: subReadiness(snapshot, seededCells),
      cells: seededCells,
    };

    const updated = reroll(snapshot, {
      ...module,
      subactivities: [...module.subactivities, created],
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

  const subEdit = at('modules/:id/subactivities/:subId', 'PATCH');
  if (subEdit) {
    must(snapshot, 'module.edit');
    const module = moduleOf(snapshot, subEdit.id!);
    const updated: ModuleView = {
      ...module,
      subactivities: module.subactivities.map((sub) =>
        sub.id === subEdit.subId ? { ...sub, name: String(body.name ?? '').trim() } : sub,
      ),
    };
    return plain(replaceModule(snapshot, updated));
  }

  const subDelete = at('modules/:id/subactivities/:subId', 'DELETE');
  if (subDelete) {
    must(snapshot, 'module.edit');
    const module = moduleOf(snapshot, subDelete.id!);
    if (module.closed) throw new ApiError('bad_request', 'This module is closed.', 400);

    const remaining = module.subactivities.filter((sub) => sub.id !== subDelete.subId);
    const removed = module.subactivities.find((sub) => sub.id === subDelete.subId);

    // Removing the last one materialises the module's row from what the roll-up showed,
    // so the module keeps the readiness it had a moment earlier.
    const updated =
      remaining.length === 0
        ? withDerived(
            {
              ...module,
              subactivities: [],
              cells: module.cells.map((cell) => ({
                ...cell,
                rolled_up: false,
                subactivity_count: 0,
              })),
            },
            snapshot.config.columns,
            snapshot.config.stages.length,
          )
        : reroll(snapshot, { ...module, subactivities: remaining });

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
    const module = moduleOf(snapshot, String(body.module_id));
    const ticket = String(body.ticket_key ?? '').trim();

    return plain({
      ...snapshot,
      defects: [
        {
          id: newId(),
          module_id: module.id,
          module_label: `${module.node_type} · ${module.name}`,
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
  if (at('config/columns', 'POST')) {
    must(snapshot, 'project.config');
    const full = String(body.name ?? '').trim();
    const key = `x_${full.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    if (snapshot.config.columns.some((column) => column.key === key)) {
      throw new ApiError('validation_failed', 'A column with that name already exists.', 422);
    }

    const column = {
      id: newId(),
      project_id: snapshot.project.id,
      key,
      label: full.toUpperCase().slice(0, 8),
      full,
      allowed: [...STATUS_SETS.simple],
      counts: true,
      order_index: snapshot.config.columns.length,
      off_vocabulary: 0,
    };

    const blank: CellView = {
      column_key: key,
      status: BLANK,
      rolled_up: false,
      subactivity_count: 0,
      changed_by: null,
      changed_at: null,
    };

    return plain(
      audited(
        {
          ...snapshot,
          config: { ...snapshot.config, columns: [...snapshot.config.columns, column] },
          modules: snapshot.modules.map((module) =>
            withDerived(
              {
                ...module,
                cells: [...module.cells, { ...blank, rolled_up: module.subactivities.length > 0, subactivity_count: module.subactivities.length }],
                subactivities: module.subactivities.map((sub) => ({
                  ...sub,
                  cells: [...sub.cells, { ...blank }],
                })),
              },
              [...snapshot.config.columns, column],
              snapshot.config.stages.length,
            ),
          ),
        },
        { scope: 'project', label: 'CONFIG', what: `column added: ${full}` },
      ),
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
            modules: reordered.modules.map((module) =>
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
          modules: snapshot.modules.map((module) =>
            withDerived(
              {
                ...module,
                cells: module.cells.filter((cell) => cell.column_key !== key),
                subactivities: module.subactivities.map((sub) => ({
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

  if (at('config/lists', 'POST')) {
    must(snapshot, 'project.config');
    const list = String(body.list) as 'node_types' | 'stages' | 'owners' | 'link_types';
    const action = String(body.action);
    const value = String(body.value);
    const config = { ...snapshot.config };

    if (list === 'stages') {
      config.stages =
        action === 'add'
          ? [...config.stages, { id: newId(), label: value }]
          : config.stages.filter((stage) => stage.id !== value && stage.label !== value);
    } else {
      const currentList = config[list];
      config[list] =
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
          modules: snapshot.modules.map((module) =>
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

    const subactivities: SubactivityView[] = Array.from(
      { length: entry.subactivity_count },
      (_, index) => ({
        id: newId(),
        name: `Subactivity ${index + 1}`,
        readiness: 0,
        cells: blankCells(snapshot),
      }),
    );

    const created = reroll(snapshot, {
      id: newId(),
      node_type: entry.node_type,
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
      subactivities,
      links: [],
      last_run: null,
    });

    const config = snapshot.config.node_types.includes(entry.node_type)
      ? snapshot.config
      : { ...snapshot.config, node_types: [...snapshot.config.node_types, entry.node_type] };

    return {
      data: audited(
        {
          ...snapshot,
          config,
          modules: [...snapshot.modules, created],
          library: snapshot.library.map((candidate) =>
            candidate.id === entry.id
              ? { ...candidate, used_in_projects: candidate.used_in_projects + 1, in_this_project: true }
              : candidate,
          ),
        },
        { scope: 'module', label: 'MODULE', what: `cloned from the library`, moduleId: created.id },
      ),
      meta: { module_id: created.id, node_type: entry.node_type },
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
    return {
      data: {
        ...snapshot,
        projects: [
          ...snapshot.projects,
          { id, key, name: String(body.name ?? '').trim() || key, configured: false, module_count: 0 },
        ],
      },
      meta: { project_id: id },
    };
  }

  if (at('projects/select', 'POST')) {
    // Only the seeded project has data baked in; the demo says so rather than showing
    // an empty app as though it were a bug.
    if (body.project_id !== snapshot.project.id) {
      throw new ApiError(
        'bad_request',
        'The demo carries data for CR_AUTOMATION only. Other projects show as unconfigured, which is what a new project really looks like.',
        400,
      );
    }
    return plain(snapshot);
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

  // -- platform --------------------------------------------------------------
  if (path.startsWith('/api/v1/platform/')) {
    // The super admin console creates organisations, each with its own roles, users and
    // projects. The demo carries one baked organisation and no way to sign into another,
    // so a created one would be a row that leads nowhere — worse than saying so.
    throw new ApiError(
      'bad_request',
      'The super admin console creates organisations and their first administrators, which needs a real server. The demo carries one organisation, Flow One.',
      400,
    );
  }

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

  current = {
    ...snapshot,
    me: { ...snapshot.me, role_names: [role.name], permissions: role.permissions },
  };
  return current;
}
