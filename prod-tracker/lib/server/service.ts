import { randomUUID } from 'node:crypto';
import type {
  Cell,
  DefectPhase,
  DefectSeverity,
  DefectStatus,
  DeliverableColumn,
  DriftVerdict,
  Module,
  ProjectConfig,
} from '../shared/domain';
import { DEFECT_STATUS_ORDER } from '../shared/domain';
import {
  hasPermission,
  isPermissionKey,
  resolveEffectiveAccess,
  type PermissionKey,
} from '../shared/permissions';
import {
  BLANK,
  isStatusKey,
  nextStatus,
  readiness,
  rollUp,
  stageIndex,
  statusEntry,
  STATUS_SETS,
  toneOf,
} from '../shared/vocabulary';
import type {
  AuditView,
  CellView,
  DefectView,
  DriftRowView,
  LibraryView,
  ModuleView,
  Snapshot,
  SubactivityView,
} from '../shared/views';
import type { Actor } from './auth';
import { badRequest, forbidden, notFound, validationFailed } from './errors';
import { mutate, nowIso, type StoreData } from './store';

/**
 * The tracker service. Every mutation below re-checks permissions server-side; the
 * client's copy of the permission set exists only to disable and explain controls.
 */

const TICKET_BASE_URL = process.env.TICKET_BASE_URL ?? 'https://tms.internal/browse';

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export interface Access {
  actor: Actor;
  projectId: string;
  permissions: Set<PermissionKey>;
  roleNames: string[];
}

export function resolveAccess(store: StoreData, actor: Actor, projectId: string): Access {
  const grants = store.memberships
    .filter((membership) => membership.tenant_id === actor.tenantId && membership.user_id === actor.userId)
    .map((membership) => {
      const role = store.roles.find((candidate) => candidate.id === membership.role_id);
      return {
        projectId: membership.project_id,
        permissions: role?.permissions ?? [],
        roleKey: role?.key ?? '',
      };
    });

  const effective = resolveEffectiveAccess(grants, projectId);
  const roleNames = [...effective.roleKeys]
    .map((key) => store.roles.find((role) => role.key === key)?.name ?? key)
    .filter(Boolean);

  return { actor, projectId, permissions: effective.permissions, roleNames };
}

function require_(access: Access, key: PermissionKey, what: string): void {
  if (!hasPermission(access.permissions, key)) {
    throw forbidden(`You cannot ${what} — that needs ${key} in this project.`);
  }
}

/** The default project a user lands on: the first they can see. */
export function defaultProjectId(store: StoreData, actor: Actor): string {
  const configured = store.projects.find(
    (project) => project.tenant_id === actor.tenantId && project.configured && !project.archived,
  );
  const any = store.projects.find((project) => project.tenant_id === actor.tenantId);
  const project = configured ?? any;
  if (!project) throw notFound('This organisation has no projects yet.');
  return project.id;
}

// ---------------------------------------------------------------------------
// Reading — the matrix projection
// ---------------------------------------------------------------------------

function configFor(store: StoreData, projectId: string): ProjectConfig {
  const config = store.project_config.find((entry) => entry.project_id === projectId);
  return config ?? { project_id: projectId, node_types: [], stages: [], owners: [], link_types: [] };
}

function columnsFor(store: StoreData, projectId: string): DeliverableColumn[] {
  return store.columns
    .filter((column) => column.project_id === projectId)
    .sort((a, b) => a.order_index - b.order_index);
}

function cellKey(moduleId: string, subactivityId: string | null, columnKey: string): string {
  return `${moduleId}/${subactivityId ?? ''}:${columnKey}`;
}

function indexCells(cells: readonly Cell[]): Map<string, Cell> {
  const index = new Map<string, Cell>();
  for (const cell of cells) {
    index.set(cellKey(cell.module_id, cell.subactivity_id, cell.column_key), cell);
  }
  return index;
}

function driftVerdict(row: { repo: string; lab: string; preprod: string; prod: string }): DriftVerdict {
  if (row.prod === 'unknown' || !row.prod) return 'Never verified';
  if (row.preprod === row.prod && row.repo !== row.prod) return 'Patched in place';
  if (row.preprod !== row.prod) return 'Prod behind';
  return 'In step';
}

/**
 * Assembles everything the ten screens read, in one pass. The whole project is a few
 * hundred cells, so a single projection is both simpler and faster than per-screen
 * queries; the Redis cache the README calls for slots in exactly here.
 */
export function buildSnapshot(store: StoreData, actor: Actor, projectId: string): Snapshot {
  const tenant = store.tenants.find((candidate) => candidate.id === actor.tenantId);
  const project = store.projects.find(
    (candidate) => candidate.id === projectId && candidate.tenant_id === actor.tenantId,
  );
  if (!tenant || !project) throw notFound('That project does not exist.');

  const access = resolveAccess(store, actor, projectId);
  require_(access, 'project.view', 'open this project');

  const config = configFor(store, projectId);
  const columns = columnsFor(store, projectId);
  const countedColumns = columns.filter((column) => column.counts);
  const cellIndex = indexCells(store.cells);

  const statusOf = (moduleId: string, subactivityId: string | null, columnKey: string): Cell =>
    cellIndex.get(cellKey(moduleId, subactivityId, columnKey)) ?? {
      module_id: moduleId,
      subactivity_id: subactivityId,
      column_key: columnKey,
      status: BLANK,
      changed_by: null,
      changed_at: null,
    };

  const projectModules = store.modules.filter((module) => module.project_id === projectId);

  const modules: ModuleView[] = projectModules.map((module) => {
    const subs = store.subactivities
      .filter((subactivity) => subactivity.module_id === module.id)
      .sort((a, b) => a.order_index - b.order_index);

    const subactivityViews: SubactivityView[] = subs.map((subactivity) => {
      const cells = columns.map<CellView>((column) => {
        const cell = statusOf(module.id, subactivity.id, column.key);
        return {
          column_key: column.key,
          status: cell.status,
          rolled_up: false,
          subactivity_count: 0,
          changed_by: cell.changed_by,
          changed_at: cell.changed_at,
        };
      });
      const counted = countedColumns.map(
        (column) => cells.find((cell) => cell.column_key === column.key)?.status ?? BLANK,
      );
      return {
        id: subactivity.id,
        name: subactivity.name,
        readiness: readiness(counted),
        cells,
      };
    });

    const cells = columns.map<CellView>((column) => {
      if (subs.length > 0) {
        // Derived, never stored — and read-only in the UI for exactly that reason.
        const status = rollUp(
          subs.map((subactivity) => statusOf(module.id, subactivity.id, column.key).status),
        );
        return {
          column_key: column.key,
          status,
          rolled_up: true,
          subactivity_count: subs.length,
          changed_by: null,
          changed_at: null,
        };
      }
      const cell = statusOf(module.id, null, column.key);
      return {
        column_key: column.key,
        status: cell.status,
        rolled_up: false,
        subactivity_count: 0,
        changed_by: cell.changed_by,
        changed_at: cell.changed_at,
      };
    });

    const statusFor = (columnKey: string): string =>
      cells.find((cell) => cell.column_key === columnKey)?.status ?? BLANK;

    const percent = readiness(countedColumns.map((column) => statusFor(column.key)));
    const run = store.runs.find((candidate) => candidate.module_id === module.id) ?? null;

    return {
      id: module.id,
      node_type: module.node_type,
      name: module.name,
      owner: module.owner,
      fni_target_date: module.fni_target_date,
      closed: module.fni_closed_at !== null,
      closed_by: module.fni_closed_by,
      readiness: percent,
      stage_index: stageIndex(percent, config.stages.length),
      missing: countedColumns
        .filter((column) => toneOf(statusFor(column.key)) !== 'done')
        .map((column) => column.label),
      blank_count: columns.filter((column) => statusFor(column.key) === BLANK).length,
      cells,
      subactivities: subactivityViews,
      links: store.links
        .filter((link) => link.module_id === module.id)
        .map((link) => ({ id: link.id, type: link.type, label: link.label, url: link.url })),
      last_run: run
        ? { child_req_id: run.child_req_id, phases: run.phases, artifacts: run.artifacts }
        : null,
    };
  });

  const moduleLabel = (moduleId: string): string => {
    const module = projectModules.find((candidate) => candidate.id === moduleId);
    return module ? `${module.node_type} · ${module.name}` : '—';
  };

  const audit: AuditView[] = store.cell_audit
    .filter((entry) => entry.project_id === projectId)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .map((entry) => ({
      id: entry.id,
      module_id: entry.module_id,
      column_label: entry.column_label,
      what: entry.what,
      who: entry.who,
      at: entry.at,
    }));

  const defects: DefectView[] = store.defects
    .filter((defect) => defect.project_id === projectId)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .map((defect) => ({
      id: defect.id,
      module_id: defect.module_id,
      module_label: moduleLabel(defect.module_id),
      phase: defect.phase,
      ticket_key: defect.ticket_key,
      ticket_url: defect.ticket_key ? `${TICKET_BASE_URL}/${defect.ticket_key}` : '',
      child_req_id: defect.child_req_id,
      severity: defect.severity,
      description: defect.description,
      raised_by: defect.raised_by,
      assignee: defect.assignee,
      status: defect.status,
      created_at: defect.created_at,
    }));

  const library: LibraryView[] = store.library
    .filter((entry) => entry.tenant_id === actor.tenantId)
    .map((entry) => ({
      id: entry.id,
      node_type: entry.node_type,
      name: entry.name,
      version: entry.version,
      subactivity_count: entry.subactivity_names.length,
      used_in_projects: entry.used_in_projects,
      in_this_project: projectModules.some(
        (module) => module.node_type === entry.node_type && module.name === entry.name,
      ),
    }));

  const roleById = new Map(store.roles.map((role) => [role.id, role]));
  const projectName = (id: string | null): string =>
    id === null
      ? `${tenant.name} — all projects`
      : (store.projects.find((candidate) => candidate.id === id)?.key ?? 'unknown project');

  const users = store.users
    .filter((user) => user.tenant_id === actor.tenantId && user.status !== 'deactivated')
    .map((user) => {
      const memberships = store.memberships.filter((membership) => membership.user_id === user.id);
      return {
        id: user.id,
        display_name: user.display_name,
        email: user.email,
        role_name: memberships
          .map((membership) => roleById.get(membership.role_id)?.name ?? '—')
          .join(', '),
        scope: memberships.map((membership) => projectName(membership.project_id)).join(', '),
        status: user.status,
      };
    });

  const invitations = store.invitations
    .filter((invitation) => invitation.tenant_id === actor.tenantId)
    .sort((a, b) => (a.invited_at < b.invited_at ? 1 : -1))
    .map((invitation) => ({
      id: invitation.id,
      email: invitation.email,
      display_name: invitation.display_name,
      role_name: roleById.get(invitation.role_id)?.name ?? '—',
      scope: projectName(invitation.project_id),
      state: invitation.accepted_at
        ? `Accepted, ${shortDate(invitation.accepted_at)}`
        : `Invited, ${shortDate(invitation.invited_at)} — not accepted`,
    }));

  const driftRows: DriftRowView[] = store.drift_rows
    .filter((row) => row.project_id === projectId)
    .map((row) => ({
      id: row.id,
      layer: row.layer,
      scope: row.scope,
      cadence: row.cadence,
      repo: row.repo,
      lab: row.lab,
      preprod: row.preprod,
      prod: row.prod,
      verdict: driftVerdict(row),
    }));

  return {
    me: {
      user_id: actor.userId,
      display_name: actor.displayName,
      email: actor.email,
      role_names: access.roleNames,
      permissions: [...access.permissions],
    },
    org: { id: tenant.id, name: tenant.name },
    project: { id: project.id, key: project.key, name: project.name },
    projects: store.projects
      .filter((candidate) => candidate.tenant_id === actor.tenantId && !candidate.archived)
      .map((candidate) => ({
        id: candidate.id,
        key: candidate.key,
        name: candidate.name,
        configured: candidate.configured,
        module_count: store.modules.filter((module) => module.project_id === candidate.id).length,
      })),
    config: {
      columns,
      node_types: config.node_types,
      stages: config.stages,
      owners: config.owners,
      link_types: config.link_types,
      phases: ['Staging test', 'Preprod test', 'Prod deployment'],
    },
    modules,
    audit,
    defects,
    library,
    roles: store.roles
      .filter((role) => role.tenant_id === actor.tenantId)
      .map((role) => ({
        id: role.id,
        key: role.key,
        name: role.name,
        note: role.note,
        permissions: role.permissions,
      })),
    users,
    invitations,
    drift: {
      rows: driftRows,
      warnings: store.drift_warnings
        .filter((warning) => warning.project_id === projectId)
        .map((warning) => ({
          id: warning.id,
          severity: warning.severity,
          text: warning.text,
          where: warning.where,
        })),
    },
  };
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function findModule(store: StoreData, projectId: string, moduleId: string): Module {
  const module = store.modules.find(
    (candidate) => candidate.id === moduleId && candidate.project_id === projectId,
  );
  if (!module) throw notFound('That module is not in this project.');
  return module;
}

function findColumn(store: StoreData, projectId: string, columnKey: string): DeliverableColumn {
  const column = store.columns.find(
    (candidate) => candidate.project_id === projectId && candidate.key === columnKey,
  );
  if (!column) throw notFound('That deliverable column is not configured on this project.');
  return column;
}

/**
 * Advances one cell through its column's configured statuses and stamps the change.
 * A module cell that is a roll-up is refused here as well as disabled in the UI —
 * the derived value must not be writable by any route.
 */
export async function advanceCell(
  actor: Actor,
  projectId: string,
  input: { moduleId: string; subactivityId: string | null; columnKey: string; status?: string },
): Promise<void> {
  await mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'deliverable.update', 'change a deliverable status');

    const module = findModule(store, projectId, input.moduleId);
    const column = findColumn(store, projectId, input.columnKey);

    if (module.fni_closed_at) {
      throw badRequest('This module is closed. Reopen it before changing a deliverable.');
    }

    const subs = store.subactivities.filter((sub) => sub.module_id === module.id);
    if (input.subactivityId === null && subs.length > 0) {
      throw badRequest(
        'This module has subactivities, so its row is a roll-up. Change the subactivity instead.',
      );
    }
    if (input.subactivityId !== null && !subs.some((sub) => sub.id === input.subactivityId)) {
      throw notFound('That subactivity is not on this module.');
    }

    const existing = store.cells.find(
      (cell) =>
        cell.module_id === module.id &&
        cell.subactivity_id === input.subactivityId &&
        cell.column_key === column.key,
    );
    const current = existing?.status ?? BLANK;

    // An explicit status is honoured only if the column allows it; otherwise advance.
    const next =
      input.status !== undefined
        ? input.status
        : nextStatus(current, column.allowed);
    if (input.status !== undefined && !column.allowed.includes(input.status)) {
      throw validationFailed(
        `${column.label} cannot take that status. It allows: ${column.allowed
          .map((key) => statusEntry(key).label)
          .join(', ')}.`,
      );
    }

    const at = nowIso();
    if (existing) {
      existing.status = next;
      existing.changed_by = actor.displayName;
      existing.changed_at = at;
    } else {
      store.cells.push({
        module_id: module.id,
        subactivity_id: input.subactivityId,
        column_key: column.key,
        status: next,
        changed_by: actor.displayName,
        changed_at: at,
      });
    }

    store.cell_audit.push({
      id: randomUUID(),
      project_id: projectId,
      module_id: module.id,
      subactivity_id: input.subactivityId,
      column_key: column.key,
      column_label: column.label,
      what: `${statusEntry(current).label} → ${statusEntry(next).label}`,
      who: actor.displayName,
      at,
    });
  });
}

/**
 * Readiness for the FNI gate, recomputed from the store rather than trusted from the
 * client. Mirrors the projection in `buildSnapshot`.
 */
function moduleReadiness(store: StoreData, module: Module): { percent: number; fniDone: boolean } {
  const columns = columnsFor(store, module.project_id);
  const counted = columns.filter((column) => column.counts);
  const subs = store.subactivities.filter((sub) => sub.module_id === module.id);
  const index = indexCells(store.cells);

  const statusFor = (columnKey: string): string => {
    if (subs.length > 0) {
      return rollUp(
        subs.map((sub) => index.get(cellKey(module.id, sub.id, columnKey))?.status ?? BLANK),
      );
    }
    return index.get(cellKey(module.id, null, columnKey))?.status ?? BLANK;
  };

  const fniColumn = columns.find((column) => column.key === 'fni');
  return {
    percent: readiness(counted.map((column) => statusFor(column.key))),
    fniDone: fniColumn ? toneOf(statusFor(fniColumn.key)) === 'done' : false,
  };
}

/** The blocking reasons the disabled control states. Empty means the gate is open. */
export function fniBlockers(store: StoreData, module: Module): string[] {
  const { percent, fniDone } = moduleReadiness(store, module);
  const blockers: string[] = [];
  if (percent !== 100) {
    blockers.push('DevOps has not confirmed every deliverable loaded in prod');
  }
  if (!fniDone) blockers.push('FNI final submission is not complete');
  return blockers;
}

export async function setModuleFields(
  actor: Actor,
  projectId: string,
  moduleId: string,
  input: { owner?: string | null; fniTargetDate?: string | null },
): Promise<void> {
  await mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    const module = findModule(store, projectId, moduleId);

    if (input.owner !== undefined) {
      require_(access, 'module.edit', 'change the owner');
      module.owner = input.owner || null;
    }
    if (input.fniTargetDate !== undefined) {
      require_(access, 'fni.date', 'set the FNI target date');
      module.fni_target_date = input.fniTargetDate || null;
    }
  });
}

/**
 * The FNI rule, step 5. Closing is permitted only when readiness is 100% and the FNI
 * column is done — enforced here, not only in the UI.
 */
export async function signOffFni(
  actor: Actor,
  projectId: string,
  moduleId: string,
  close: boolean,
): Promise<void> {
  await mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'fni.signoff', 'sign off FNI');

    const module = findModule(store, projectId, moduleId);

    if (close) {
      const blockers = fniBlockers(store, module);
      if (blockers.length > 0) {
        throw badRequest(`Blocked — ${blockers.join('; ')}`);
      }
      module.fni_closed_at = nowIso();
      module.fni_closed_by = actor.displayName;
    } else {
      module.fni_closed_at = null;
      module.fni_closed_by = null;
    }
  });
}

/**
 * DevOps confirming the whole row: sets every counted column that has a `prod`-tone
 * status available to its done status. Columns whose vocabulary has no done status
 * are left alone.
 */
export async function confirmLoadedInProd(
  actor: Actor,
  projectId: string,
  moduleId: string,
): Promise<{ changed: number }> {
  return mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'prod.confirm', 'confirm a module is loaded in prod');

    const module = findModule(store, projectId, moduleId);
    if (module.fni_closed_at) throw badRequest('This module is closed.');

    const columns = columnsFor(store, projectId).filter((column) => column.counts);
    const subs = store.subactivities.filter((sub) => sub.module_id === module.id);
    const targets: (string | null)[] = subs.length ? subs.map((sub) => sub.id) : [null];
    const at = nowIso();
    let changed = 0;

    for (const column of columns) {
      const done = column.allowed.find((status) => toneOf(status) === 'done');
      if (!done) continue;

      for (const target of targets) {
        const existing = store.cells.find(
          (cell) =>
            cell.module_id === module.id &&
            cell.subactivity_id === target &&
            cell.column_key === column.key,
        );
        const current = existing?.status ?? BLANK;
        if (current === done) continue;

        if (existing) {
          existing.status = done;
          existing.changed_by = actor.displayName;
          existing.changed_at = at;
        } else {
          store.cells.push({
            module_id: module.id,
            subactivity_id: target,
            column_key: column.key,
            status: done,
            changed_by: actor.displayName,
            changed_at: at,
          });
        }

        store.cell_audit.push({
          id: randomUUID(),
          project_id: projectId,
          module_id: module.id,
          subactivity_id: target,
          column_key: column.key,
          column_label: column.label,
          what: `${statusEntry(current).label} → ${statusEntry(done).label} (prod confirmation)`,
          who: actor.displayName,
          at,
        });
        changed++;
      }
    }

    return { changed };
  });
}

// ---------------------------------------------------------------------------
// Defects
// ---------------------------------------------------------------------------

export async function createDefect(
  actor: Actor,
  projectId: string,
  input: {
    moduleId: string;
    phase: DefectPhase;
    ticketKey: string;
    childReqId: string;
    severity: DefectSeverity;
    description: string;
  },
): Promise<void> {
  await mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'defect.create', 'log a defect');
    findModule(store, projectId, input.moduleId);

    store.defects.push({
      id: randomUUID(),
      project_id: projectId,
      module_id: input.moduleId,
      phase: input.phase,
      ticket_key: input.ticketKey.trim(),
      child_req_id: input.childReqId.trim(),
      severity: input.severity,
      description: input.description.trim(),
      raised_by: actor.displayName,
      assignee: null,
      status: 'Open',
      created_at: nowIso(),
    });
  });
}

export async function transitionDefect(
  actor: Actor,
  projectId: string,
  defectId: string,
  status?: DefectStatus,
): Promise<void> {
  await mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'defect.transition', 'change a defect status');

    const defect = store.defects.find(
      (candidate) => candidate.id === defectId && candidate.project_id === projectId,
    );
    if (!defect) throw notFound('That defect does not exist.');

    if (status) {
      defect.status = status;
    } else {
      const index = DEFECT_STATUS_ORDER.indexOf(defect.status);
      defect.status = DEFECT_STATUS_ORDER[(index + 1) % DEFECT_STATUS_ORDER.length] as DefectStatus;
    }
  });
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export async function addLink(
  actor: Actor,
  projectId: string,
  moduleId: string,
  input: { type: string; label: string; url: string },
): Promise<void> {
  await mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'module.edit', 'add a link');
    findModule(store, projectId, moduleId);

    const url = input.url.trim();
    if (!url) throw validationFailed('A link needs a URL.');

    store.links.push({
      id: randomUUID(),
      module_id: moduleId,
      type: input.type,
      label: input.label.trim() || url,
      url,
    });
  });
}

export async function removeLink(actor: Actor, projectId: string, linkId: string): Promise<void> {
  await mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'module.edit', 'remove a link');

    const index = store.links.findIndex((link) => link.id === linkId);
    if (index < 0) throw notFound('That link does not exist.');
    findModule(store, projectId, store.links[index]!.module_id);
    store.links.splice(index, 1);
  });
}

// ---------------------------------------------------------------------------
// Project configuration
// ---------------------------------------------------------------------------

export async function addColumn(
  actor: Actor,
  projectId: string,
  name: string,
): Promise<void> {
  await mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'project.config', 'add a deliverable column');

    const full = name.trim();
    if (!full) throw validationFailed('A column needs a name.');

    const key = `x_${full.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    if (store.columns.some((column) => column.project_id === projectId && column.key === key)) {
      throw validationFailed('A column with that name already exists on this project.');
    }

    const columns = columnsFor(store, projectId);
    store.columns.push({
      id: randomUUID(),
      project_id: projectId,
      key,
      label: full.toUpperCase().slice(0, 8),
      full,
      allowed: [...STATUS_SETS.simple],
      counts: true,
      order_index: columns.length,
    });
  });
}

export async function removeColumn(actor: Actor, projectId: string, columnKey: string): Promise<void> {
  await mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'project.config', 'remove a deliverable column');

    const index = store.columns.findIndex(
      (column) => column.project_id === projectId && column.key === columnKey,
    );
    if (index < 0) throw notFound('That column is not configured on this project.');

    store.columns.splice(index, 1);
    // The cells go with it: a column that is not configured has no meaning, and
    // leaving orphans behind would quietly resurrect them if the name were reused.
    store.cells = store.cells.filter((cell) => {
      const module = store.modules.find((candidate) => candidate.id === cell.module_id);
      return !(module?.project_id === projectId && cell.column_key === columnKey);
    });
  });
}

export async function setColumnCounts(
  actor: Actor,
  projectId: string,
  columnKey: string,
  counts: boolean,
): Promise<void> {
  await mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'project.config', 'change whether a column counts toward prod');
    findColumn(store, projectId, columnKey).counts = counts;
  });
}

export async function updateConfigList(
  actor: Actor,
  projectId: string,
  list: 'node_types' | 'stages' | 'owners' | 'link_types',
  action: 'add' | 'remove',
  value: string,
): Promise<void> {
  await mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'project.config', 'change project configuration');

    let config = store.project_config.find((entry) => entry.project_id === projectId);
    if (!config) {
      config = { project_id: projectId, node_types: [], stages: [], owners: [], link_types: [] };
      store.project_config.push(config);
    }

    if (list === 'stages') {
      if (action === 'add') {
        const label = value.trim();
        if (!label) throw validationFailed('A stage needs a name.');
        config.stages.push({ id: randomUUID(), label });
      } else {
        config.stages = config.stages.filter((stage) => stage.id !== value && stage.label !== value);
      }
      return;
    }

    const current = config[list];
    if (action === 'add') {
      const entry = value.trim();
      if (!entry) throw validationFailed('That cannot be empty.');
      if (!current.includes(entry)) current.push(entry);
    } else {
      config[list] = current.filter((item) => item !== value);
    }
  });
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

/**
 * Cloning copies the definition and starts fresh tracking. The library entry is
 * unaffected, and the node type joins the project's list if it is not already there.
 */
export async function cloneFromLibrary(
  actor: Actor,
  projectId: string,
  entryId: string,
): Promise<{ moduleId: string; nodeType: string }> {
  return mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'module.clone', 'clone a module from the library');

    const entry = store.library.find(
      (candidate) => candidate.id === entryId && candidate.tenant_id === actor.tenantId,
    );
    if (!entry) throw notFound('That library entry does not exist.');

    const moduleId = randomUUID();
    store.modules.push({
      id: moduleId,
      project_id: projectId,
      node_type: entry.node_type,
      name: entry.name,
      library_entry_id: entry.id,
      owner: null,
      fni_target_date: null,
      fni_closed_at: null,
      fni_closed_by: null,
      created_at: nowIso(),
    });

    entry.subactivity_names.forEach((name, index) => {
      store.subactivities.push({
        id: randomUUID(),
        module_id: moduleId,
        name,
        order_index: index,
      });
    });
    entry.used_in_projects += 1;

    // A clone starts with an empty deliverable row: every cell blank, so the gaps show.
    const columns = columnsFor(store, projectId);
    const targets: (string | null)[] = entry.subactivity_names.length
      ? store.subactivities.filter((sub) => sub.module_id === moduleId).map((sub) => sub.id)
      : [null];
    for (const target of targets) {
      for (const column of columns) {
        store.cells.push({
          module_id: moduleId,
          subactivity_id: target,
          column_key: column.key,
          status: BLANK,
          changed_by: null,
          changed_at: null,
        });
      }
    }

    const config = store.project_config.find((candidate) => candidate.project_id === projectId);
    if (config && !config.node_types.includes(entry.node_type)) {
      config.node_types.push(entry.node_type);
    }

    return { moduleId, nodeType: entry.node_type };
  });
}

// ---------------------------------------------------------------------------
// Access screen
// ---------------------------------------------------------------------------

export async function toggleGrant(
  actor: Actor,
  projectId: string,
  roleId: string,
  permission: string,
  granted: boolean,
): Promise<void> {
  await mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'admin.roles.manage', 'change what a role may do');

    if (!isPermissionKey(permission)) throw validationFailed('That is not a permission key.');

    const role = store.roles.find(
      (candidate) => candidate.id === roleId && candidate.tenant_id === actor.tenantId,
    );
    if (!role) throw notFound('That role does not exist.');

    // Nobody can grant a permission they do not themselves hold.
    if (granted && !access.permissions.has(permission)) {
      throw forbidden(`You cannot grant ${permission} — you do not hold it yourself.`);
    }

    const held = role.permissions.includes(permission);
    if (granted && !held) role.permissions.push(permission);
    if (!granted && held) {
      role.permissions = role.permissions.filter((key) => key !== permission);
    }
  });
}

export async function inviteUser(
  actor: Actor,
  projectId: string,
  input: { email: string; displayName: string; roleId: string; scopeProjectId: string | null },
): Promise<{ inviteToken: string; email: string }> {
  const { newInviteToken } = await import('./auth');

  return mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'admin.users.manage', 'invite a user');

    const email = input.email.trim().toLowerCase();
    if (!email.includes('@')) throw validationFailed('That does not look like an email address.');

    const role = store.roles.find(
      (candidate) => candidate.id === input.roleId && candidate.tenant_id === actor.tenantId,
    );
    if (!role) throw notFound('That role does not exist.');

    // Nobody can hand out more than they hold, invitation included.
    const excess = role.permissions.filter((key) => !access.permissions.has(key));
    if (excess.length > 0) {
      throw forbidden(
        `You cannot invite someone as ${role.name} — that role holds ${excess.join(', ')}, which you do not.`,
      );
    }

    if (store.users.some((user) => user.tenant_id === actor.tenantId && user.email === email)) {
      throw validationFailed('That email already has an account in this organisation.');
    }

    const invite = newInviteToken();
    const userId = randomUUID();
    const at = nowIso();

    store.users.push({
      id: userId,
      tenant_id: actor.tenantId,
      email,
      display_name: input.displayName.trim() || email,
      status: 'invited',
      last_login_at: null,
      created_at: at,
      password_hash: '',
      invite_token_hash: invite.hash,
      invite_expires_at: invite.expiresAt,
    });

    store.memberships.push({
      id: randomUUID(),
      tenant_id: actor.tenantId,
      user_id: userId,
      project_id: input.scopeProjectId,
      role_id: role.id,
      created_at: at,
    });

    store.invitations.push({
      id: randomUUID(),
      tenant_id: actor.tenantId,
      email,
      display_name: input.displayName.trim() || email,
      role_id: role.id,
      project_id: input.scopeProjectId,
      invited_by: actor.displayName,
      invited_at: at,
      accepted_at: null,
    });

    // No mail transport in this release — the caller surfaces the link so an admin can
    // pass it on. A Kafka `user.invited` event replaces this.
    return { inviteToken: invite.token, email };
  });
}

export { isStatusKey };
