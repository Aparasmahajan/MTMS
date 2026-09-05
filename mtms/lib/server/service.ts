import { randomUUID } from 'node:crypto';
import type {
  AuditScope,
  Cell,
  DefectPhase,
  DefectSeverity,
  DefectStatus,
  DeliverableColumn,
  DriftEnvironment,
  DriftLayer,
  Module,
  ProjectConfig,
  Role,
  Subactivity,
} from '../shared/domain';
import { DEFECT_STATUS_ORDER, DRIFT_ENVIRONMENTS, projectKeySchema } from '../shared/domain';
import {
  buildPromotion,
  confirmPromotions,
  driftRows,
  driftWarnings,
  promotionGate,
} from './drift';
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
  MemberView,
  ModuleView,
  Snapshot,
  SubactivityView,
} from '../shared/views';
import type { Actor } from './auth';
import { badRequest, conflict, forbidden, notFound, validationFailed } from './errors';
import { emit } from './events';
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

/**
 * Records a change. Every mutation that alters what the matrix shows goes through here:
 * a deliverable status is only part of the record, and "who created this module" or "who
 * dropped that column" are questions a release manager has to answer months later.
 */
function record(
  store: StoreData,
  projectId: string,
  actor: Actor,
  entry: {
    scope: AuditScope;
    label: string;
    what: string;
    moduleId?: string | null;
    subactivityId?: string | null;
  },
): void {
  store.audit.push({
    id: randomUUID(),
    project_id: projectId,
    module_id: entry.moduleId ?? null,
    subactivity_id: entry.subactivityId ?? null,
    scope: entry.scope,
    label: entry.label,
    what: entry.what,
    who: actor.displayName,
    at: nowIso(),
  });
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

/**
 * Cells holding a status their column no longer allows. Editing a column's vocabulary
 * leaves filled-in cells alone rather than rewriting them, so this is how the Configure
 * screen tells someone what they left behind. Blanks are never counted — a blank is not
 * a status, so it cannot be off-vocabulary.
 */
function offVocabularyCount(
  store: StoreData,
  projectId: string,
  column: DeliverableColumn,
): number {
  const modules = new Set(
    store.modules.filter((module) => module.project_id === projectId).map((module) => module.id),
  );
  const allowed = new Set(column.allowed);
  return store.cells.filter(
    (cell) =>
      cell.column_key === column.key &&
      modules.has(cell.module_id) &&
      cell.status !== BLANK &&
      !allowed.has(cell.status),
  ).length;
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

  const audit: AuditView[] = store.audit
    .filter((entry) => entry.project_id === projectId)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .map((entry) => ({
      id: entry.id,
      scope: entry.scope,
      module_id: entry.module_id,
      module_label: entry.module_id ? moduleLabel(entry.module_id) : '—',
      label: entry.label,
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

  /**
   * Who can see the project currently open — the per-project memberships plus the
   * organisation-wide ones, which apply everywhere and are therefore listed but not
   * editable from here.
   */
  const members: MemberView[] = store.memberships
    .filter(
      (membership) =>
        membership.tenant_id === actor.tenantId &&
        (membership.project_id === projectId || membership.project_id === null),
    )
    .map((membership) => {
      const user = store.users.find((candidate) => candidate.id === membership.user_id);
      const role = roleById.get(membership.role_id);
      const orgWide = membership.project_id === null;
      const self = membership.user_id === actor.userId;
      return {
        membership_id: membership.id,
        user_id: membership.user_id,
        display_name: user?.display_name ?? 'unknown user',
        email: user?.email ?? '',
        role_id: membership.role_id,
        role_name: role?.name ?? '—',
        org_wide: orgWide,
        status: user?.status ?? 'unknown',
        editable: !orgWide && !self,
        locked_reason: orgWide
          ? 'Organisation-wide access — change it on the Access screen'
          : self
            ? 'You cannot change your own access'
            : '',
      };
    })
    .sort((a, b) => a.display_name.localeCompare(b.display_name));

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

  // Drift is derived end to end from the reported hashes — see lib/server/drift.ts.
  const driftRowViews = driftRows(store, projectId);
  const driftWarningViews = driftWarnings(store, projectId, modules);
  const gate = promotionGate(store, projectId, modules, driftRowViews);

  const latestReports = DRIFT_ENVIRONMENTS.map((environment) => {
    const report = store.drift_reports
      .filter((candidate) => candidate.project_id === projectId && candidate.environment === environment)
      .sort((a, b) => (a.at < b.at ? 1 : -1))[0];
    return report
      ? {
          environment,
          agent: report.agent,
          at: report.at,
          observation_count: report.observation_count,
        }
      : { environment, agent: 'no agent', at: '', observation_count: 0 };
  });

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
      columns: columns.map((column) => ({
        ...column,
        off_vocabulary: offVocabularyCount(store, projectId, column),
      })),
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
    members,
    invitations,
    drift: {
      rows: driftRowViews,
      gate,
      reports: latestReports,
      promotions: store.drift_promotions
        .filter((promotion) => promotion.project_id === projectId)
        .sort((a, b) => (a.at < b.at ? 1 : -1))
        .slice(0, 5)
        .map((promotion) => ({
          id: promotion.id,
          from_environment: promotion.from_environment,
          to_environment: promotion.to_environment,
          promoted_by: promotion.promoted_by,
          at: promotion.at,
          confirmed_at: promotion.confirmed_at,
          column_count: Object.keys(promotion.hashes).length,
        })),
      warnings: driftWarningViews,
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

    record(store, projectId, actor, {
      scope: 'cell',
      label: column.label,
      what: `${statusEntry(current).label} → ${statusEntry(next).label}`,
      moduleId: module.id,
      subactivityId: input.subactivityId,
    });

    // Partitioned by module, so a consumer sees one module's cell changes in the order
    // they happened even when several people are editing different modules at once.
    emit(store, {
      name: 'cell.changed',
      tenantId: actor.tenantId,
      projectId,
      partitionKey: module.id,
      actor: actor.displayName,
      payload: {
        module_id: module.id,
        subactivity_id: input.subactivityId,
        column_key: column.key,
        from: current,
        to: next,
      },
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
      const before = module.owner ?? 'unassigned';
      module.owner = input.owner || null;
      record(store, projectId, actor, {
        scope: 'module',
        label: 'MODULE',
        what: `owner ${before} → ${module.owner ?? 'unassigned'}`,
        moduleId: module.id,
      });
    }
    if (input.fniTargetDate !== undefined) {
      require_(access, 'fni.date', 'set the FNI target date');
      const before = module.fni_target_date ?? 'not set';
      module.fni_target_date = input.fniTargetDate || null;
      record(store, projectId, actor, {
        scope: 'module',
        label: 'MODULE',
        what: `FNI target date ${before} → ${module.fni_target_date ?? 'not set'}`,
        moduleId: module.id,
      });
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
      emit(store, {
        name: 'module.closed',
        tenantId: actor.tenantId,
        projectId,
        partitionKey: module.id,
        actor: actor.displayName,
        payload: { module_id: module.id, node_type: module.node_type, name: module.name },
      });
    } else {
      module.fni_closed_at = null;
      module.fni_closed_by = null;
    }

    record(store, projectId, actor, {
      scope: 'module',
      label: 'FNI',
      what: close ? 'FNI signed off — module closed' : 'module reopened',
      moduleId: module.id,
    });
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

        record(store, projectId, actor, {
          scope: 'cell',
          label: column.label,
          what: `${statusEntry(current).label} → ${statusEntry(done).label} (prod confirmation)`,
          moduleId: module.id,
          subactivityId: target,
        });
        changed++;
      }
    }

    if (changed > 0) {
      emit(store, {
        name: 'deployment.confirmed',
        tenantId: actor.tenantId,
        projectId,
        partitionKey: module.id,
        actor: actor.displayName,
        payload: { module_id: module.id, cells_changed: changed },
      });
    }

    return { changed };
  });
}

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

/** Every cell blank, so a new module's gaps are conspicuous from the moment it exists. */
function fillBlankCells(store: StoreData, moduleId: string, projectId: string, target: string | null): void {
  for (const column of columnsFor(store, projectId)) {
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

/**
 * Creates a module directly, for the activity that is not in the library. The normal
 * path is still cloning — `addToLibrary` is how a genuinely reusable one gets catalogued
 * at the moment it is created, rather than every project one-off polluting the library.
 */
export async function createModule(
  actor: Actor,
  projectId: string,
  input: { nodeType: string; name: string; addToLibrary: boolean },
): Promise<{ moduleId: string }> {
  return mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'module.create', 'create a module');

    const nodeType = input.nodeType.trim();
    const name = input.name.trim();
    if (!nodeType) throw validationFailed('A module needs a node type.');
    if (!name) throw validationFailed('A module needs an activity name.');

    const config = configFor(store, projectId);
    if (!config.node_types.includes(nodeType)) {
      throw validationFailed(
        `${nodeType} is not a node type on this project. Add it on the Configure screen first.`,
      );
    }

    // The node type and the activity name together are the module's identity: the same
    // activity on two node types is two modules, tracked separately.
    const duplicate = store.modules.some(
      (module) =>
        module.project_id === projectId && module.node_type === nodeType && module.name === name,
    );
    if (duplicate) {
      throw conflict(`${nodeType} · ${name} is already tracked on this project.`);
    }

    const moduleId = randomUUID();
    store.modules.push({
      id: moduleId,
      project_id: projectId,
      node_type: nodeType,
      name,
      library_entry_id: null,
      owner: null,
      fni_target_date: null,
      fni_closed_at: null,
      fni_closed_by: null,
      created_at: nowIso(),
    });
    fillBlankCells(store, moduleId, projectId, null);
    record(store, projectId, actor, {
      scope: 'module',
      label: 'MODULE',
      what: `created ${nodeType} · ${name}${input.addToLibrary ? ', added to the library' : ''}`,
      moduleId,
    });

    if (input.addToLibrary) {
      const existing = store.library.find(
        (entry) =>
          entry.tenant_id === actor.tenantId &&
          entry.node_type === nodeType &&
          entry.name === name,
      );
      if (existing) {
        existing.used_in_projects += 1;
        store.modules.find((module) => module.id === moduleId)!.library_entry_id = existing.id;
      } else {
        const entryId = randomUUID();
        store.library.push({
          id: entryId,
          tenant_id: actor.tenantId,
          node_type: nodeType,
          name,
          version: 'v1',
          subactivity_names: [],
          used_in_projects: 1,
        });
        store.modules.find((module) => module.id === moduleId)!.library_entry_id = entryId;
      }
    }

    return { moduleId };
  });
}

// ---------------------------------------------------------------------------
// Subactivities
// ---------------------------------------------------------------------------

function subactivitiesOf(store: StoreData, moduleId: string): Subactivity[] {
  return store.subactivities
    .filter((subactivity) => subactivity.module_id === moduleId)
    .sort((a, b) => a.order_index - b.order_index);
}

/**
 * Adding a subactivity turns the module's row from directly editable into a roll-up.
 *
 * The first one inherits the module's own cells rather than starting blank: the row
 * already recorded real work, and stranding it would make the module read as untouched
 * the moment somebody broke it into parts. Removing the last one reverses this.
 */
export async function addSubactivity(
  actor: Actor,
  projectId: string,
  moduleId: string,
  name: string,
): Promise<{ subactivityId: string }> {
  return mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'module.edit', 'add a subactivity');

    const module = findModule(store, projectId, moduleId);
    if (module.fni_closed_at) {
      throw badRequest('This module is closed. Reopen it before changing its subactivities.');
    }

    const label = name.trim();
    if (!label) throw validationFailed('A subactivity needs a name.');

    const existing = subactivitiesOf(store, moduleId);
    if (existing.some((subactivity) => subactivity.name === label)) {
      throw conflict(`This module already has a subactivity called ${label}.`);
    }

    const subactivityId = randomUUID();
    store.subactivities.push({
      id: subactivityId,
      module_id: moduleId,
      name: label,
      order_index: existing.length,
    });

    if (existing.length === 0) {
      // Carry the module's own row down onto the first subactivity, then drop it — the
      // module's cells are derived from here on.
      const ownCells = store.cells.filter(
        (cell) => cell.module_id === moduleId && cell.subactivity_id === null,
      );
      for (const cell of ownCells) cell.subactivity_id = subactivityId;
    } else {
      fillBlankCells(store, moduleId, projectId, subactivityId);
    }

    record(store, projectId, actor, {
      scope: 'module',
      label: 'SUBACT',
      what:
        existing.length === 0
          ? `added subactivity ${label} — the module row is now a roll-up, carrying what it already held`
          : `added subactivity ${label}, starting blank`,
      moduleId,
      subactivityId,
    });

    return { subactivityId };
  });
}

export async function renameSubactivity(
  actor: Actor,
  projectId: string,
  moduleId: string,
  subactivityId: string,
  name: string,
): Promise<void> {
  await mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'module.edit', 'rename a subactivity');
    findModule(store, projectId, moduleId);

    const label = name.trim();
    if (!label) throw validationFailed('A subactivity needs a name.');

    const subactivity = store.subactivities.find(
      (candidate) => candidate.id === subactivityId && candidate.module_id === moduleId,
    );
    if (!subactivity) throw notFound('That subactivity is not on this module.');

    // A rename changes no status, so it is allowed even on a closed module.
    const before = subactivity.name;
    subactivity.name = label;
    record(store, projectId, actor, {
      scope: 'module',
      label: 'SUBACT',
      what: `renamed subactivity ${before} → ${label}`,
      moduleId,
      subactivityId,
    });
  });
}

/**
 * Removing the last subactivity hands the module its row back. The cells are
 * materialised from the roll-up as it stood a moment before, so the row shows what the
 * module was already showing rather than resetting to blank.
 */
export async function removeSubactivity(
  actor: Actor,
  projectId: string,
  moduleId: string,
  subactivityId: string,
): Promise<void> {
  await mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'module.edit', 'remove a subactivity');

    const module = findModule(store, projectId, moduleId);
    if (module.fni_closed_at) {
      throw badRequest('This module is closed. Reopen it before changing its subactivities.');
    }

    const existing = subactivitiesOf(store, moduleId);
    const going = existing.find((subactivity) => subactivity.id === subactivityId);
    if (!going) throw notFound('That subactivity is not on this module.');

    const columns = columnsFor(store, projectId);
    const index = indexCells(store.cells);
    const lastOne = existing.length === 1;

    // Capture the roll-up before anything is deleted.
    const rolledUp = new Map<string, string>();
    if (lastOne) {
      for (const column of columns) {
        rolledUp.set(
          column.key,
          rollUp(
            existing.map(
              (subactivity) =>
                index.get(cellKey(moduleId, subactivity.id, column.key))?.status ?? BLANK,
            ),
          ),
        );
      }
    }

    store.subactivities = store.subactivities.filter(
      (candidate) => candidate.id !== subactivityId,
    );
    store.cells = store.cells.filter(
      (cell) => !(cell.module_id === moduleId && cell.subactivity_id === subactivityId),
    );

    if (lastOne) {
      const at = nowIso();
      for (const column of columns) {
        store.cells.push({
          module_id: moduleId,
          subactivity_id: null,
          column_key: column.key,
          status: rolledUp.get(column.key) ?? BLANK,
          changed_by: actor.displayName,
          changed_at: at,
        });
      }
    } else {
      subactivitiesOf(store, moduleId).forEach((subactivity, position) => {
        subactivity.order_index = position;
      });
    }

    record(store, projectId, actor, {
      scope: 'module',
      label: 'SUBACT',
      what: lastOne
        ? `removed the last subactivity ${going.name} — the module row is directly tracked again, keeping what it showed`
        : `removed subactivity ${going.name} and its deliverable row`,
      moduleId,
    });
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

    const defectId = randomUUID();
    emit(store, {
      name: 'defect.raised',
      tenantId: actor.tenantId,
      projectId,
      partitionKey: input.moduleId,
      actor: actor.displayName,
      payload: {
        defect_id: defectId,
        module_id: input.moduleId,
        severity: input.severity,
        phase: input.phase,
        ticket_key: input.ticketKey.trim(),
      },
    });
    store.defects.push({
      id: defectId,
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

    const before = defect.status;
    if (status) {
      defect.status = status;
    } else {
      const index = DEFECT_STATUS_ORDER.indexOf(defect.status);
      defect.status = DEFECT_STATUS_ORDER[(index + 1) % DEFECT_STATUS_ORDER.length] as DefectStatus;
    }

    emit(store, {
      name: 'defect.transitioned',
      tenantId: actor.tenantId,
      projectId,
      partitionKey: defect.module_id,
      actor: actor.displayName,
      payload: { defect_id: defect.id, from: before, to: defect.status },
    });

    record(store, projectId, actor, {
      scope: 'module',
      label: 'DEFECT',
      what: `${defect.ticket_key || 'defect'} ${before} → ${defect.status}`,
      moduleId: defect.module_id,
    });
  });
}

/**
 * Assigns a defect to one of the project's configured owners. `null` unassigns. The
 * owner list is project configuration, so this stays generic — another project assigns
 * to its own people without a code change.
 */
export async function assignDefect(
  actor: Actor,
  projectId: string,
  defectId: string,
  assignee: string | null,
): Promise<void> {
  await mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'defect.assign', 'assign a defect');

    const defect = store.defects.find(
      (candidate) => candidate.id === defectId && candidate.project_id === projectId,
    );
    if (!defect) throw notFound('That defect does not exist.');

    const before = defect.assignee ?? 'unassigned';

    if (assignee === null) {
      defect.assignee = null;
    } else {
      const owner = assignee.trim();
      const owners = configFor(store, projectId).owners;
      if (!owners.includes(owner)) {
        throw validationFailed(
          `${owner} is not an owner on this project. Add them on the Configure screen first.`,
        );
      }
      defect.assignee = owner;
    }

    record(store, projectId, actor, {
      scope: 'module',
      label: 'DEFECT',
      what: `${defect.ticket_key || 'defect'} assigned ${before} → ${defect.assignee ?? 'unassigned'}`,
      moduleId: defect.module_id,
    });
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
// Projects
// ---------------------------------------------------------------------------

/**
 * Stands up a second project in the same organisation. It starts with no columns, no
 * node types and no stages — deliberately: the whole claim of the app is that a team
 * defines its own process on the Configure screen rather than inheriting this one's.
 *
 * No membership row is created. `project.create` is an organisation-level permission, so
 * whoever holds it holds it org-wide (`project_id: null`), which already covers every
 * project including this one.
 */
export async function createProject(
  actor: Actor,
  currentProjectId: string,
  input: { key: string; name: string; description: string },
): Promise<{ projectId: string }> {
  return mutate((store) => {
    const access = resolveAccess(store, actor, currentProjectId);
    require_(access, 'project.create', 'create a project');

    const key = input.key.trim().toUpperCase();
    const parsed = projectKeySchema.safeParse(key);
    if (!parsed.success) {
      throw validationFailed(
        'A project key is uppercase letters, digits and underscores, starting with a letter — for example INVENTORY_SYNC.',
      );
    }

    if (store.projects.some((project) => project.tenant_id === actor.tenantId && project.key === key)) {
      throw conflict(`${key} already exists in this organisation.`);
    }

    const projectId = randomUUID();
    store.projects.push({
      id: projectId,
      tenant_id: actor.tenantId,
      key,
      name: input.name.trim() || key,
      description: input.description.trim(),
      configured: false,
      archived: false,
      created_at: nowIso(),
    });
    store.project_config.push({
      project_id: projectId,
      node_types: [],
      stages: [],
      owners: [],
      link_types: [],
    });

    // Recorded against the new project, which is where someone would look for it.
    record(store, projectId, actor, {
      scope: 'project',
      label: 'PROJECT',
      what: `created the project ${key}`,
    });

    return { projectId };
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

    // A project with columns has been stood up; that is what `configured` means, and it
    // is what stops the screens showing the set-up prompt.
    const project = store.projects.find((candidate) => candidate.id === projectId);
    if (project && !project.configured) project.configured = true;

    record(store, projectId, actor, {
      scope: 'project',
      label: 'CONFIG',
      what: `added the deliverable column ${full}`,
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

    const going = store.columns[index] as DeliverableColumn;
    record(store, projectId, actor, {
      scope: 'project',
      label: 'CONFIG',
      what: `removed the deliverable column ${going.full}, and every cell in it`,
    });
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
    const column = findColumn(store, projectId, columnKey);
    column.counts = counts;
    record(store, projectId, actor, {
      scope: 'project',
      label: 'CONFIG',
      what: `${column.label} now ${counts ? 'counts toward prod' : 'is informational only'}`,
    });
  });
}

/**
 * Sets the subset of the shared vocabulary a column may take.
 *
 * Cells already holding a status that is no longer in the subset are **left exactly as
 * they are**. Rewriting them would be a lie: the record says a deliverable was loaded in
 * prod, and a configuration change is not evidence that it was not. They keep their own
 * tone, still count toward readiness if that tone is done, and are counted by
 * `offVocabularyCount` so Configure can report them. The next person to click such a
 * cell moves it into the new subset, because `nextStatus` starts the cycle over when the
 * current status is not in the list.
 */
export async function setColumnStatuses(
  actor: Actor,
  projectId: string,
  columnKey: string,
  allowed: readonly string[],
): Promise<void> {
  await mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'project.config', 'change the statuses a column can take');

    const unknown = allowed.filter((key) => !isStatusKey(key));
    if (unknown.length > 0) {
      throw validationFailed(
        `Not a status in the shared vocabulary: ${unknown.join(', ')}. A column picks from the vocabulary rather than defining its own.`,
      );
    }

    // Order is meaningful — it is the order clicking a cell advances through.
    const deduped = [...new Set(allowed)];
    if (deduped.length === 0) {
      throw validationFailed('A column needs at least one status it can take.');
    }

    const column = findColumn(store, projectId, columnKey);
    const before = column.allowed.map((key) => statusEntry(key).label).join(', ');
    column.allowed = deduped;

    const stranded = offVocabularyCount(store, projectId, column);
    record(store, projectId, actor, {
      scope: 'project',
      label: 'CONFIG',
      what:
        `${column.label} statuses ${before} → ${deduped.map((key) => statusEntry(key).label).join(', ')}` +
        (stranded > 0
          ? ` — ${stranded} ${stranded === 1 ? 'cell keeps a status' : 'cells keep a status'} no longer in the list`
          : ''),
    });
  });
}

/**
 * Moves a column one place left or right on the matrix. `order_index` is rewritten for
 * the whole project so the sequence stays dense however the columns arrived.
 */
export async function moveColumn(
  actor: Actor,
  projectId: string,
  columnKey: string,
  direction: 'up' | 'down',
): Promise<void> {
  await mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'project.config', 'reorder the deliverable columns');

    const ordered = columnsFor(store, projectId);
    const index = ordered.findIndex((column) => column.key === columnKey);
    if (index < 0) throw notFound('That column is not configured on this project.');

    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= ordered.length) {
      throw badRequest(
        direction === 'up'
          ? 'That column is already first.'
          : 'That column is already last.',
      );
    }

    const moving = ordered[index] as DeliverableColumn;
    ordered[index] = ordered[target] as DeliverableColumn;
    ordered[target] = moving;
    ordered.forEach((column, position) => {
      column.order_index = position;
    });

    record(store, projectId, actor, {
      scope: 'project',
      label: 'CONFIG',
      what: `moved ${moving.label} ${direction === 'up' ? 'earlier' : 'later'} on the matrix`,
    });
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

    record(store, projectId, actor, {
      scope: 'module',
      label: 'MODULE',
      what: `cloned ${entry.node_type} · ${entry.name} ${entry.version} from the library`,
      moduleId,
    });

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

// ---------------------------------------------------------------------------
// Project members
// ---------------------------------------------------------------------------

/**
 * Nobody may hand out a role that holds more than they do themselves. The same rule
 * guards invitations; it lives here so adding a member cannot be used to route around it.
 */
function requireGrantableRole(store: StoreData, access: Access, roleId: string): Role {
  const role = store.roles.find(
    (candidate) => candidate.id === roleId && candidate.tenant_id === access.actor.tenantId,
  );
  if (!role) throw notFound('That role does not exist.');

  const excess = role.permissions.filter((key) => !access.permissions.has(key));
  if (excess.length > 0) {
    throw forbidden(
      `You cannot give someone ${role.name} — that role holds ${excess.join(', ')}, which you do not.`,
    );
  }
  return role;
}

export async function addProjectMember(
  actor: Actor,
  projectId: string,
  input: { userId: string; roleId: string },
): Promise<void> {
  await mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'project.members.manage', 'add someone to this project');

    const user = store.users.find(
      (candidate) => candidate.id === input.userId && candidate.tenant_id === actor.tenantId,
    );
    if (!user) throw notFound('That user is not in this organisation.');

    const role = requireGrantableRole(store, access, input.roleId);

    const already = store.memberships.some(
      (membership) =>
        membership.user_id === user.id &&
        (membership.project_id === projectId || membership.project_id === null),
    );
    if (already) {
      throw conflict(`${user.display_name} already has access to this project.`);
    }

    store.memberships.push({
      id: randomUUID(),
      tenant_id: actor.tenantId,
      user_id: user.id,
      project_id: projectId,
      role_id: role.id,
      created_at: nowIso(),
    });

    record(store, projectId, actor, {
      scope: 'project',
      label: 'ACCESS',
      what: `added ${user.display_name} as ${role.name}`,
    });
  });
}

export async function setMemberRole(
  actor: Actor,
  projectId: string,
  membershipId: string,
  roleId: string,
): Promise<void> {
  await mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'project.members.manage', 'change what someone may do on this project');

    const membership = store.memberships.find(
      (candidate) => candidate.id === membershipId && candidate.tenant_id === actor.tenantId,
    );
    if (!membership) throw notFound('That membership does not exist.');
    if (membership.project_id !== projectId) {
      throw badRequest(
        'That access is organisation-wide, so it cannot be changed from a project screen. Edit it on the Access screen.',
      );
    }

    // Checked before the role is validated: changing your own access is refused whatever
    // you are changing it to, and saying so is more use than a message about the role.
    if (membership.user_id === actor.userId) {
      throw badRequest('You cannot change your own access. Ask another admin to do it.');
    }
    const role = requireGrantableRole(store, access, roleId);

    const before = store.roles.find((candidate) => candidate.id === membership.role_id)?.name ?? '—';
    membership.role_id = role.id;

    const user = store.users.find((candidate) => candidate.id === membership.user_id);
    record(store, projectId, actor, {
      scope: 'project',
      label: 'ACCESS',
      what: `${user?.display_name ?? 'a user'} ${before} → ${role.name}`,
    });
  });
}

export async function removeProjectMember(
  actor: Actor,
  projectId: string,
  membershipId: string,
): Promise<void> {
  await mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'project.members.manage', 'remove someone from this project');

    const membership = store.memberships.find(
      (candidate) => candidate.id === membershipId && candidate.tenant_id === actor.tenantId,
    );
    if (!membership) throw notFound('That membership does not exist.');
    if (membership.project_id !== projectId) {
      throw badRequest(
        'That access is organisation-wide, so it cannot be removed from a project screen. Edit it on the Access screen.',
      );
    }
    if (membership.user_id === actor.userId) {
      throw badRequest('You cannot remove your own access. Ask another admin to do it.');
    }

    const user = store.users.find((candidate) => candidate.id === membership.user_id);
    const role = store.roles.find((candidate) => candidate.id === membership.role_id);
    store.memberships = store.memberships.filter((candidate) => candidate.id !== membershipId);

    record(store, projectId, actor, {
      scope: 'project',
      label: 'ACCESS',
      what: `removed ${user?.display_name ?? 'a user'} (${role?.name ?? '—'}) from this project`,
    });
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

    emit(store, {
      name: 'user.invited',
      tenantId: actor.tenantId,
      projectId: input.scopeProjectId,
      partitionKey: email,
      actor: actor.displayName,
      payload: { email, role: role.name, scope_project_id: input.scopeProjectId },
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

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

export interface DriftEntryInput {
  column_key: string;
  layer: DriftLayer;
  path: string;
  content_hash: string;
  size_bytes?: number;
  built_at?: string | null;
  source_modified_at?: string | null;
  in_packinglist?: boolean;
}

/**
 * Accepts one agent's report for one environment.
 *
 * The environment's observations are **replaced**, not merged: a file deleted from a
 * server matters as much as one that changed, and a merge cannot see a deletion.
 *
 * Entries naming a column the project does not track are dropped rather than rejected —
 * an agent walking `.packinglist` will legitimately find more than the project chose to
 * track, and failing its whole report over that would train people to stop running it.
 */
export async function ingestDriftReport(
  projectId: string,
  input: { environment: DriftEnvironment; agent: string; entries: DriftEntryInput[] },
): Promise<{ accepted: number; ignored: string[]; confirmed_promotions: number }> {
  return mutate((store) => {
    const project = store.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw notFound('That project does not exist.');

    const tracked = new Set(
      store.drift_deliverables
        .filter((entry) => entry.project_id === projectId)
        .map((entry) => entry.column_key),
    );

    const at = nowIso();
    const accepted: DriftEntryInput[] = [];
    const ignored: string[] = [];
    for (const entry of input.entries) {
      if (tracked.has(entry.column_key)) accepted.push(entry);
      else ignored.push(entry.column_key);
    }

    store.drift_observations = store.drift_observations.filter(
      (observation) =>
        !(observation.project_id === projectId && observation.environment === input.environment),
    );

    for (const entry of accepted) {
      store.drift_observations.push({
        id: randomUUID(),
        project_id: projectId,
        environment: input.environment,
        column_key: entry.column_key,
        layer: entry.layer,
        path: entry.path,
        content_hash: entry.content_hash.toLowerCase(),
        size_bytes: entry.size_bytes ?? 0,
        built_at: entry.built_at ?? null,
        source_modified_at: entry.source_modified_at ?? null,
        in_packinglist: entry.in_packinglist ?? true,
        observed_at: at,
        reported_by: input.agent,
      });
    }

    store.drift_reports.push({
      id: randomUUID(),
      project_id: projectId,
      environment: input.environment,
      agent: input.agent,
      at,
      observation_count: accepted.length,
    });

    // A promotion is confirmed by an observation, never by the act of promoting.
    const confirmed = confirmPromotions(store, projectId, at);

    const agentActor: Actor = {
      userId: 'agent',
      tenantId: project.tenant_id,
      email: '',
      displayName: input.agent,
    };
    record(store, projectId, agentActor, {
      scope: 'project',
      label: 'DRIFT',
      what: `reported ${accepted.length} ${accepted.length === 1 ? 'hash' : 'hashes'} from ${input.environment}${
        confirmed ? `, confirming ${confirmed} promotion${confirmed === 1 ? '' : 's'}` : ''
      }`,
    });

    return { accepted: accepted.length, ignored: [...new Set(ignored)], confirmed_promotions: confirmed };
  });
}

/**
 * Records a promotion of one environment's hashes onto another.
 *
 * It writes no observations for the target. Promotion is an intent — "these exact bytes
 * should now be on prod" — and only an agent report from prod turns that into a fact.
 * Writing the hashes forward would make this screen agree with itself and with nothing
 * else, which is the habit it exists to break.
 */
export async function promoteDrift(
  actor: Actor,
  projectId: string,
  from: DriftEnvironment,
  to: DriftEnvironment,
): Promise<{ promotionId: string; columns: number }> {
  return mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'prod.confirm', 'promote a build');

    if (from === to) throw validationFailed('A promotion needs two different environments.');

    const { modules } = buildSnapshot(store, actor, projectId);
    const rows = driftRows(store, projectId);
    const gate = promotionGate(store, projectId, modules, rows);
    if (!gate.can_promote) {
      const blocking = gate.checks.filter((check) => !check.passed).map((check) => check.text);
      throw badRequest(`Blocked — ${blocking.join('; ')}`);
    }

    const { id, hashes } = buildPromotion(store, projectId, from, to, actor.displayName);
    const columns = Object.keys(hashes).length;
    if (columns === 0) {
      throw badRequest(`Nothing to promote — no hashes have been reported from ${from}.`);
    }

    store.drift_promotions.push({
      id,
      project_id: projectId,
      from_environment: from,
      to_environment: to,
      hashes,
      promoted_by: actor.displayName,
      at: nowIso(),
      confirmed_at: null,
    });

    record(store, projectId, actor, {
      scope: 'project',
      label: 'DRIFT',
      what: `promoted ${columns} ${columns === 1 ? 'deliverable' : 'deliverables'} ${from} → ${to}, awaiting confirmation from ${to}`,
    });

    return { promotionId: id, columns };
  });
}
