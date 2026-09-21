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
  SubModule,
  ProjectConfig,
  Role,
  SubActivity,
  Scope,
  StepDefinition,
  StepEntry,
  StepList,
  StepProgress,
  StepState,
} from '../shared/domain';
import {
  DEFECT_STATUS_ORDER,
  DRIFT_ENVIRONMENTS,
  PROD_ENVIRONMENT,
  projectKeySchema,
} from '../shared/domain';
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
  SubModuleView,
  Snapshot,
  SubActivityView,
  OwnerGroupView,
  OwnerView,
  StepEntryView,
  StepListView,
  ThreadView,
  StepDefinitionView,
  ModuleView,
  NotificationView,
  ColumnTimingView,
  StepTimingView,
  RoleView,
} from '../shared/views';
import { columnDisplayLabel } from '../shared/views';
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
  /**
   * The role ids this person holds here, which is what a step gate compares against.
   *
   * Ids rather than the names beside them: a role can be renamed, and a checklist that
   * stopped gating correctly because somebody fixed a typo in "QA" would be a very quiet
   * way to lose a control.
   */
  roleIds: string[];
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

  // Resolved from the same keys, so the ids and the names can never describe different roles.
  const roleIds = [...effective.roleKeys]
    .map((key) => store.roles.find((role) => role.key === key)?.id)
    .filter((id): id is string => Boolean(id));

  return { actor, projectId, permissions: effective.permissions, roleNames, roleIds };
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
    sub_module_id: entry.moduleId ?? null,
    sub_activity_id: entry.subactivityId ?? null,
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
  return (
    config ?? {
      project_id: projectId,
      module_names: [],
      stages: [],
      owners: [],
      link_types: [],
      environments: [],
    }
  );
}

function columnsFor(store: StoreData, projectId: string): DeliverableColumn[] {
  return store.columns
    .filter((column) => column.project_id === projectId)
    .sort((a, b) => a.order_index - b.order_index);
}

/**
 * Whether a column is on the grid and in the maths.
 *
 * Only an environment can switch one off, and it switches off every column that records
 * it at once. A column naming an environment the project does not configure at all is
 * active — an unknown environment is a column nobody has disabled, and treating it as
 * hidden would make deliverables disappear because of a typo in a config list.
 */
function isActiveColumn(config: ProjectConfig, column: DeliverableColumn): boolean {
  if (!column.environment) return true;
  const environment = config.environments.find((entry) => entry.key === column.environment);
  return environment ? environment.enabled : true;
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
    store.sub_modules.filter((module) => module.project_id === projectId).map((module) => module.id),
  );
  const allowed = new Set(column.allowed);
  return store.cells.filter(
    (cell) =>
      cell.column_key === column.key &&
      modules.has(cell.sub_module_id) &&
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
    index.set(cellKey(cell.sub_module_id, cell.sub_activity_id, cell.column_key), cell);
  }
  return index;
}


/**
 * Assembles everything the ten screens read, in one pass. The whole project is a few
 * hundred cells, so a single projection is both simpler and faster than per-screen
 * queries; the Redis cache the README calls for slots in exactly here.
 */

// ---------------------------------------------------------------------------
// Checklists, owners and discussions
// ---------------------------------------------------------------------------
//
// These project the tables added in store version 8 onto the three levels of the hierarchy.
// They are read-only: every rule about who may tick what lives in `stepGate` and is applied
// here once, so the client never recomputes it. A client that guessed would eventually guess
// differently from the server and produce the worst failure a permission system has — a
// control that looks available and then refuses.

/** Whose names these role ids are, for a step that says "QA may tick this". */
function roleNamesOf(store: StoreData, roleIds: readonly string[]): string[] {
  return roleIds
    .map((id) => store.roles.find((role) => role.id === id)?.name)
    .filter((name): name is string => Boolean(name));
}

function wordForState(state: StepState): string {
  return state === 'todo' ? 'not done' : state;
}

/**
 * Whether this reader may tick one entry, and why not when they may not.
 *
 * The order of the checks is the message: the list's own order first, then who is allowed.
 * Each refusal names the thing standing in the way, because "not allowed" sends somebody to
 * ask an administrator about a permission when the real answer is that step 1 is not done.
 */
function stepGate(
  store: StoreData,
  list: StepList,
  entries: readonly StepEntry[],
  entry: StepEntry,
  progressOf: (entryId: string) => StepProgress | undefined,
  definition: StepDefinition,
  access: Access,
): { canTick: boolean; isOverrideForMe: boolean; lockedReason: string } {
  if (list.enforce_order) {
    const earlier = entries
      .filter((candidate) => candidate.order_index < entry.order_index)
      .sort((a, b) => a.order_index - b.order_index);
    const blocking = earlier.find((candidate) => progressOf(candidate.id)?.state !== 'done');
    if (blocking) {
      const name = store.step_definitions.find((d) => d.id === blocking.definition_id)?.name;
      return {
        canTick: false,
        isOverrideForMe: false,
        lockedReason: `This checklist runs in order, and "${name ?? 'an earlier step'}" is not done yet.`,
      };
    }
  }

  const allowed = roleNamesOf(store, definition.role_ids);
  const mine = access.roleIds.some((roleId) => definition.role_ids.includes(roleId));

  // A `project.config` holder may tick anything, and it is recorded as an override —
  // "Anand ticked this on behalf of QA". That flag is the difference between an audit trail
  // and a decoration, so the screen warns before it happens.
  const canConfigure = access.permissions.has('project.config');

  if (definition.role_ids.length === 0) {
    // A step whose last allowed role was deleted must not quietly become one anybody may
    // tick. That is the opposite of what gating meant, so it closes rather than opens.
    return {
      canTick: canConfigure,
      isOverrideForMe: canConfigure,
      lockedReason: canConfigure
        ? 'This step names no role that still exists. Ticking it will be recorded as an override.'
        : 'This step names no role that still exists, so nobody can tick it until an admin picks one.',
    };
  }

  if (mine) return { canTick: true, isOverrideForMe: false, lockedReason: '' };

  return {
    canTick: canConfigure,
    isOverrideForMe: canConfigure,
    lockedReason: canConfigure
      ? `Only ${allowed.join(' or ')} may tick this. You can, as an override, and it is recorded as one.`
      : `Only ${allowed.join(' or ')} may tick this.`,
  };
}

/** The checklists attached to one thing, with each step's state and whether the reader may act. */
function stepListsFor(
  store: StoreData,
  scopeType: Scope,
  scopeId: string,
  access: Access,
  readerId: string,
): StepListView[] {
  return store.step_lists
    .filter((list) => list.scope_type === scopeType && list.scope_id === scopeId && !list.archived_at)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((list) => {
      const entries = store.step_entries
        .filter((entry) => entry.step_list_id === list.id)
        .sort((a, b) => a.order_index - b.order_index);

      const progressOf = (entryId: string) =>
        store.step_progress.find((row) => row.entry_id === entryId);

      const entryViews: StepEntryView[] = entries.map((entry) => {
        const definition = store.step_definitions.find((d) => d.id === entry.definition_id);
        const progress = progressOf(entry.id);
        const gate = definition
          ? stepGate(store, list, entries, entry, progressOf, definition, access)
          : { canTick: false, isOverrideForMe: false, lockedReason: 'That step no longer exists.' };

        return {
          id: entry.id,
          definition_id: entry.definition_id,
          name: definition?.name ?? 'Removed step',
          description: definition?.description ?? '',
          state: progress?.state ?? 'todo',
          blocked_reason: progress?.blocked_reason ?? null,
          changed_by: progress?.changed_by ?? null,
          changed_at: progress?.changed_at ?? null,
          allowed_roles: definition ? roleNamesOf(store, definition.role_ids) : [],
          can_tick: gate.canTick,
          is_override_for_me: gate.isOverrideForMe,
          locked_reason: gate.lockedReason,
          history: store.step_events
            .filter((event) => event.entry_id === entry.id)
            .sort((a, b) => b.at.localeCompare(a.at))
            .map((event) => ({
              id: event.id,
              from: event.from_state,
              to: event.to_state,
              what: `${wordForState(event.from_state)} → ${wordForState(event.to_state)}`,
              is_override: event.is_override,
              reason: event.reason,
              by: event.by,
              at: event.at,
            })),
          comments: store.step_comments
            .filter((comment) => comment.entry_id === entry.id)
            .sort((a, b) => a.created_at.localeCompare(b.created_at))
            .map((comment) => ({
              id: comment.id,
              author: comment.author,
              body: comment.body,
              created_at: comment.created_at,
              mine: comment.author_user_id === readerId,
            })),
        };
      });

      const done = entryViews.filter((entry) => entry.state === 'done').length;

      return {
        id: list.id,
        name: list.name,
        scope_type: list.scope_type,
        scope_id: list.scope_id,
        enforce_order: list.enforce_order,
        entries: entryViews,
        done_count: done,
        blocked_count: entryViews.filter((entry) => entry.state === 'blocked').length,
        readiness: entryViews.length === 0 ? 0 : Math.round((done / entryViews.length) * 100),
      };
    });
}

/**
 * Owners, grouped: the overall owner first, then one group per team.
 *
 * Grouped rather than flat because that is the question people ask — "who is the QA owner" —
 * and a flat list of five names with a role beside each makes the reader do the grouping
 * themselves, every time.
 */
function ownerGroupsFor(store: StoreData, scopeType: Scope, scopeId: string): OwnerGroupView[] {
  const rows = store.owners.filter(
    (owner) => owner.scope_type === scopeType && owner.scope_id === scopeId,
  );
  if (rows.length === 0) return [];

  const groups = new Map<string, OwnerView[]>();
  for (const row of rows) {
    const user = store.users.find((candidate) => candidate.id === row.user_id);
    if (!user) continue;
    const key = row.role_id ?? '';
    const list = groups.get(key) ?? [];
    list.push({
      owner_id: row.id,
      user_id: row.user_id,
      display_name: user.display_name,
      email: user.email,
    });
    groups.set(key, list);
  }

  return [...groups.entries()]
    .map(([roleId, owners]) => ({
      role_id: roleId === "" ? null : roleId,
      label:
        roleId === ""
          ? "Overall"
          : (store.roles.find((role) => role.id === roleId)?.name ??
            "A role that no longer exists"),
      people: owners,
    }))
    // Overall first, then the teams alphabetically, so the order cannot shuffle between two
    // readers or two renders.
    .sort((a, b) => {
      if (a.role_id === null) return -1;
      if (b.role_id === null) return 1;
      return a.label.localeCompare(b.label);
    });
}

/** Topics raised on one thing, newest first, each with its comments oldest first. */
function threadsFor(
  store: StoreData,
  scopeType: Scope,
  scopeId: string,
  readerId: string,
): ThreadView[] {
  return store.threads
    .filter((thread) => thread.scope_type === scopeType && thread.scope_id === scopeId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((thread) => ({
      id: thread.id,
      topic: thread.title,
      opened_by: thread.created_by,
      opened_at: thread.created_at,
      mine: thread.created_by_user_id === readerId,
      mentions_me: store.thread_comments.some(
        (comment) => comment.thread_id === thread.id && comment.mentions.includes(readerId),
      ),
      comments: store.thread_comments
        .filter((comment) => comment.thread_id === thread.id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((comment) => ({
          id: comment.id,
          author: comment.author,
          body: comment.body,
          created_at: comment.created_at,
          mentions_me: comment.mentions.includes(readerId),
          mine: comment.author_user_id === readerId,
        })),
    }));
}
export function buildSnapshot(store: StoreData, actor: Actor, projectId: string): Snapshot {
  const tenant = store.tenants.find((candidate) => candidate.id === actor.tenantId);
  const project = store.projects.find(
    (candidate) => candidate.id === projectId && candidate.tenant_id === actor.tenantId,
  );
  if (!tenant || !project) throw notFound('That project does not exist.');

  const access = resolveAccess(store, actor, projectId);
  require_(access, 'project.view', 'open this project');

  const config = configFor(store, projectId);
  // Every column is projected onto every module, including those behind a switched-off
  // environment: the cells stay addressable and come back untouched when it is switched
  // on again. `active` is what decides the grid and the maths.
  const columns = columnsFor(store, projectId);
  const activeColumns = columns.filter((column) => isActiveColumn(config, column));
  const countedColumns = activeColumns.filter((column) => column.counts);
  const cellIndex = indexCells(store.cells);

  const statusOf = (moduleId: string, subactivityId: string | null, columnKey: string): Cell =>
    cellIndex.get(cellKey(moduleId, subactivityId, columnKey)) ?? {
      sub_module_id: moduleId,
      sub_activity_id: subactivityId,
      column_key: columnKey,
      status: BLANK,
      changed_by: null,
      changed_at: null,
    };

  const projectModules = store.sub_modules.filter((module) => module.project_id === projectId);

  const modules: SubModuleView[] = projectModules.map((module) => {
    const subs = store.sub_activities
      .filter((subactivity) => subactivity.sub_module_id === module.id)
      .sort((a, b) => a.order_index - b.order_index);

    const subactivityViews: SubActivityView[] = subs.map((subactivity) => {
      const cells = columns.map<CellView>((column) => {
        const cell = statusOf(module.id, subactivity.id, column.key);
        return {
          column_key: column.key,
          status: cell.status,
          rolled_up: false,
          sub_activity_count: 0,
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
        // Checklists, owners and discussions attach at all three levels in the Java service.
        // This implementation carries the shape so every screen renders, and fills the
        // sub-module level only — see `stepListsFor` and the note on `buildSnapshot`.
        step_lists: stepListsFor(store, 'sub_activity', subactivity.id, access, actor.userId),
        owners: ownerGroupsFor(store, 'sub_activity', subactivity.id),
        threads: threadsFor(store, 'sub_activity', subactivity.id, actor.userId),
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
          sub_activity_count: subs.length,
          changed_by: null,
          changed_at: null,
        };
      }
      const cell = statusOf(module.id, null, column.key);
      return {
        column_key: column.key,
        status: cell.status,
        rolled_up: false,
        sub_activity_count: 0,
        changed_by: cell.changed_by,
        changed_at: cell.changed_at,
      };
    });

    const statusFor = (columnKey: string): string =>
      cells.find((cell) => cell.column_key === columnKey)?.status ?? BLANK;

    const percent = readiness(countedColumns.map((column) => statusFor(column.key)));
    const run = store.runs.find((candidate) => candidate.sub_module_id === module.id) ?? null;

    return {
      id: module.id,
      module_name: module.module_name,
      name: module.name,
      owner: module.owner,
      fni_target_date: module.fni_target_date,
      closed: module.fni_closed_at !== null,
      closed_by: module.fni_closed_by,
      readiness: percent,
      stage_index: stageIndex(percent, config.stages.length),
      missing: countedColumns
        .filter((column) => toneOf(statusFor(column.key)) !== 'done')
        .map(columnDisplayLabel),
      blank_count: activeColumns.filter((column) => statusFor(column.key) === BLANK).length,
      cells,
      sub_activities: subactivityViews,
      links: store.links
        .filter((link) => link.sub_module_id === module.id)
        .map((link) => ({ id: link.id, type: link.type, label: link.label, url: link.url })),
      last_run: run
        ? { child_req_id: run.child_req_id, phases: run.phases, artifacts: run.artifacts }
        : null,
      step_lists: stepListsFor(store, 'sub_module', module.id, access, actor.userId),
      owners: ownerGroupsFor(store, 'sub_module', module.id),
      threads: threadsFor(store, 'sub_module', module.id, actor.userId),
    };
  });

  const moduleLabel = (moduleId: string): string => {
    const module = projectModules.find((candidate) => candidate.id === moduleId);
    return module ? `${module.module_name} · ${module.name}` : '—';
  };

  /**
   * The modules as records, reconciled against the editable list of names.
   *
   * A name with no record yet is still shown, with a derived id, so the Configure screen and
   * the matrix cannot disagree about which modules exist while a record is being created. The
   * counts are computed from the live sub-modules rather than stored, for the same reason the
   * platform console derives its own: a stored count is a second copy that drifts.
   */
  const moduleViews: ModuleView[] = config.module_names.map((name, index) => {
    const record = store.modules.find(
      (candidate) => candidate.project_id === projectId && candidate.name === name,
    );
    const mine = modules.filter((subModule) => subModule.module_name === name);
    const inProd = mine.filter((subModule) => subModule.readiness === 100).length;

    return {
      id: record?.id ?? `pending:${name}`,
      name,
      description: record?.description ?? '',
      order_index: record?.order_index ?? index,
      sub_module_count: mine.length,
      in_prod: inProd,
      readiness:
        mine.length === 0 ? 0 : Math.round(mine.reduce((total, m) => total + m.readiness, 0) / mine.length),
      owners: record ? ownerGroupsFor(store, 'module', record.id) : [],
      threads: record ? threadsFor(store, 'module', record.id, actor.userId) : [],
    };
  });

  const audit: AuditView[] = store.audit
    .filter((entry) => entry.project_id === projectId)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .map((entry) => ({
      id: entry.id,
      scope: entry.scope,
      sub_module_id: entry.sub_module_id,
      sub_module_label: entry.sub_module_id ? moduleLabel(entry.sub_module_id) : '—',
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
      sub_module_id: defect.sub_module_id,
      sub_module_label: moduleLabel(defect.sub_module_id),
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
      module_name: entry.module_name,
      name: entry.name,
      version: entry.version,
      sub_activity_count: entry.sub_activity_names.length,
      used_in_projects: entry.used_in_projects,
      in_this_project: projectModules.some(
        (module) => module.module_name === entry.module_name && module.name === entry.name,
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
      is_super_admin: store.users.some(
        (user) => user.id === actor.userId && user.is_super_admin,
      ),
    },
    org: { id: tenant.id, name: tenant.name },
    project: {
      id: project.id,
      key: project.key,
      name: project.name,
      // Read through `useVocabulary()` on the client rather than reached into directly, so
      // every screen words the three levels the same way.
      module_label: project.module_label,
      sub_module_label: project.sub_module_label,
      sub_activity_label: project.sub_activity_label,
    },
    projects: store.projects
      .filter((candidate) => candidate.tenant_id === actor.tenantId && !candidate.archived)
      .map((candidate) => ({
        id: candidate.id,
        key: candidate.key,
        name: candidate.name,
        configured: candidate.configured,
        sub_module_count: store.sub_modules.filter((module) => module.project_id === candidate.id).length,
      })),
    config: {
      columns: columns.map((column) => ({
        ...column,
        off_vocabulary: offVocabularyCount(store, projectId, column),
        active: isActiveColumn(config, column),
      })),
      // The records, with ids — what a checklist, an owner or a discussion hangs off. The
      // names stay beside them for everything that only wants a name, and the two are
      // reconciled on write so they cannot describe different sets.
      modules: moduleViews,
      module_names: config.module_names,
      stages: config.stages,
      owners: config.owners,
      link_types: config.link_types,
      environments: config.environments,
      phases: ['Staging test', 'Preprod test', 'Prod deployment'],
    },
    sub_modules: modules,
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
        is_system: role.is_system ?? false,
        hidden: role.hidden ?? false,
        // Hiding a role somebody still holds is refused, and the screen says so before
        // anybody tries — which needs the count here rather than a second request.
        member_count: store.memberships.filter(
          (membership) =>
            membership.tenant_id === actor.tenantId && membership.role_id === role.id,
        ).length,
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

    // The project's step library, for the Configure screen and the "add a step" pickers. The
    // checklists themselves hang off the things they are attached to, because that is where
    // they are read.
    step_library: store.step_definitions
      .filter((definition) => definition.project_id === projectId && !definition.archived_at)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((definition) => ({
        id: definition.id,
        name: definition.name,
        description: definition.description,
        role_ids: definition.role_ids,
        role_names: roleNamesOf(store, definition.role_ids),
        // So retiring a step is an informed decision rather than a surprise on forty
        // checklists.
        used_in: store.step_entries.filter((entry) => entry.definition_id === definition.id)
          .length,
      })),

    notifications: inboxFor(store, actor),
    unread_notifications: inboxFor(store, actor).filter((row) => row.unread).length,

    timing: columnTimings(activeColumns, projectModules, store.cells),
    step_timing: stepTimings(store, projectId),
  };
}

/** One page of inbox. Older than this is history, and would need its own screen. */
function inboxFor(store: StoreData, actor: Actor): NotificationView[] {
  return store.notifications
    .filter((row) => row.tenant_id === actor.tenantId && row.user_id === actor.userId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 50)
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      link: row.link ?? '',
      at: row.created_at,
      unread: row.read_at === null,
    }));
}


// ---------------------------------------------------------------------------
// How long work actually takes
// ---------------------------------------------------------------------------
//
// A port of `io.mtms.domain.Timing`. The point of it is that **nobody fills anything in**:
// every cell carries the moment it last changed, every sub-module the moment it was created,
// and every step transition is kept forever. So these are facts the application has been
// recording since the first tick, and there are answers for work that finished months ago.
//
// Two panels, and they are not the same measurement:
//
//  - Per column, from the **cells**. A lead time — from the work appearing to that deliverable
//    being finished — and the difference between one column and the previous one is roughly
//    the time spent at that stage. A cell keeps only its *last* change, so a column that was
//    corrected reads as having taken longer. That limitation is real and is stated on screen.
//  - Per step, from the **append-only events**, which do not have that problem: a step ticked,
//    un-ticked and ticked again contributes two durations rather than one long span. That is
//    the reading that goes most wrong exactly on the work that went badly — which is the work
//    anybody is asking about.

/** One decimal. Hours of precision on a figure measured in weeks is false confidence. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function daysBetween(from: string, to: string): number {
  return round1((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/** Null for no data, so the caller renders "not enough yet" rather than a confident zero. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  // Indexed reads are non-null here because the array is non-empty and `middle` is derived
  // from its length, but `noUncheckedIndexedAccess` cannot see that.
  const upper = sorted[middle] as number;
  return sorted.length % 2 === 1
    ? round1(upper)
    : round1(((sorted[middle - 1] as number) + upper) / 2);
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return round1(values.reduce((total, value) => total + value, 0) / values.length);
}

/**
 * Days from a sub-module being created to each column being done.
 *
 * "Done" is read from the project's own vocabulary rather than assumed: a project defines
 * which statuses mean finished, and hard-coding one word here would silently report nothing
 * for a team whose column says "Loaded in prod".
 */
function columnTimings(
  activeColumns: readonly DeliverableColumn[],
  subModules: readonly SubModule[],
  cells: readonly Cell[],
): ColumnTimingView[] {
  const createdAt = new Map(subModules.map((subModule) => [subModule.id, subModule.created_at]));
  const mine = new Set(subModules.map((subModule) => subModule.id));

  const timings: ColumnTimingView[] = [];
  let previousMedian: number | null = null;

  for (const column of activeColumns) {
    const days: number[] = [];

    for (const cell of cells) {
      // The sub-module's own row only. A sub-activity's cells are a finer grain, and mixing
      // the two would count one piece of work several times with a different answer each.
      if (cell.sub_activity_id !== null) continue;
      if (cell.column_key !== column.key) continue;
      if (!mine.has(cell.sub_module_id)) continue;
      if (!cell.changed_at) continue;
      if (toneOf(cell.status) !== 'done') continue;

      const created = createdAt.get(cell.sub_module_id);
      if (!created) continue;

      // Negative means a cell changed before its sub-module existed — a clock problem
      // rather than a measurement, so it is dropped rather than reported as a negative age.
      const elapsed = daysBetween(created, cell.changed_at);
      if (elapsed >= 0) days.push(elapsed);
    }

    const middle = median(days);
    // Can legitimately be negative: a column finished before the one to its left, which
    // happens when the order on screen is a reading order rather than a sequence. Shown as
    // it is rather than clamped, because clamping would hide exactly that.
    const added = middle !== null && previousMedian !== null ? round1(middle - previousMedian) : null;

    timings.push({
      column_key: column.key,
      label: column.label,
      median_days: middle,
      mean_days: mean(days),
      added_days: added,
      measured: days.length,
      // Anything unfinished is excluded rather than counted as instant, and the count says
      // so: "4 days, from 2 of 60" is a very different statement from "4 days".
      outstanding: subModules.length - days.length,
    });

    if (middle !== null) previousMedian = middle;
  }

  return timings;
}

/**
 * How long each step takes, from the append-only history.
 *
 * Measured from the moment a step became outstanding — the checklist being attached, or the
 * last un-tick — to the tick that followed. A step ticked twice is two durations, which is
 * the whole reason this reads events rather than the current state.
 */
function stepTimings(store: StoreData, projectId: string): StepTimingView[] {
  const lists = new Map(
    store.step_lists.filter((list) => list.project_id === projectId).map((list) => [list.id, list]),
  );

  const perDefinition = new Map<string, { days: number[]; outstanding: number }>();

  for (const entry of store.step_entries) {
    const list = lists.get(entry.step_list_id);
    if (!list) continue;

    const bucket = perDefinition.get(entry.definition_id) ?? { days: [], outstanding: 0 };

    const events = store.step_events
      .filter((event) => event.entry_id === entry.id)
      .sort((a, b) => a.at.localeCompare(b.at));

    // Outstanding from the moment the checklist was attached, not from the first event —
    // otherwise a step nobody has touched contributes nothing and the wait is invisible.
    let since: string | null = list.created_at;

    for (const event of events) {
      if (event.to_state === 'done' && since !== null) {
        const elapsed = daysBetween(since, event.at);
        if (elapsed >= 0) bucket.days.push(elapsed);
        since = null;
      } else if (event.from_state === 'done' && event.to_state !== 'done') {
        // Un-ticked: it is waiting again, and the clock restarts from here.
        since = event.at;
      }
    }

    if (since !== null) bucket.outstanding += 1;
    perDefinition.set(entry.definition_id, bucket);
  }

  return [...perDefinition.entries()]
    .map(([definitionId, bucket]) => {
      const definition = store.step_definitions.find((candidate) => candidate.id === definitionId);
      return {
        definition_id: definitionId,
        name: definition?.name ?? 'Removed step',
        median_days: median(bucket.days),
        mean_days: mean(bucket.days),
        completions: bucket.days.length,
        outstanding: bucket.outstanding,
      };
    })
    // Slowest first: the point of the panel is which step is the bottleneck, and making
    // somebody sort a list to find that out is making them do the work themselves.
    .sort((a, b) => (b.median_days ?? -1) - (a.median_days ?? -1));
}
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function findModule(store: StoreData, projectId: string, moduleId: string): SubModule {
  const module = store.sub_modules.find(
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

    const subs = store.sub_activities.filter((sub) => sub.sub_module_id === module.id);
    if (input.subactivityId === null && subs.length > 0) {
      throw badRequest(
        'This module has sub_activities, so its row is a roll-up. Change the subactivity instead.',
      );
    }
    if (input.subactivityId !== null && !subs.some((sub) => sub.id === input.subactivityId)) {
      throw notFound('That subactivity is not on this module.');
    }

    const existing = store.cells.find(
      (cell) =>
        cell.sub_module_id === module.id &&
        cell.sub_activity_id === input.subactivityId &&
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
        `${columnDisplayLabel(column)} cannot take that status. It allows: ${column.allowed
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
        sub_module_id: module.id,
        sub_activity_id: input.subactivityId,
        column_key: column.key,
        status: next,
        changed_by: actor.displayName,
        changed_at: at,
      });
    }

    record(store, projectId, actor, {
      scope: 'cell',
      label: columnDisplayLabel(column),
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
        sub_module_id: module.id,
        sub_activity_id: input.subactivityId,
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
function moduleReadiness(store: StoreData, module: SubModule): { percent: number; fniDone: boolean } {
  const config = configFor(store, module.project_id);
  const columns = columnsFor(store, module.project_id);
  // Same filter as the projection, or the gate would demand a tick in an environment the
  // grid does not even show.
  const counted = columns.filter((column) => column.counts && isActiveColumn(config, column));
  const subs = store.sub_activities.filter((sub) => sub.sub_module_id === module.id);
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
export function fniBlockers(store: StoreData, module: SubModule): string[] {
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
        name: 'subModule.closed',
        tenantId: actor.tenantId,
        projectId,
        partitionKey: module.id,
        actor: actor.displayName,
        payload: { sub_module_id: module.id, module_name: module.module_name, name: module.name },
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

    const config = configFor(store, projectId);
    const columns = columnsFor(store, projectId).filter(
      (column) => column.counts && isActiveColumn(config, column),
    );
    const subs = store.sub_activities.filter((sub) => sub.sub_module_id === module.id);
    const targets: (string | null)[] = subs.length ? subs.map((sub) => sub.id) : [null];
    const at = nowIso();
    let changed = 0;

    for (const column of columns) {
      // "Loaded in prod" is a claim about prod. Ticking lab and preprod as well would
      // assert two loads nobody performed — and asserting a lab load that never happened
      // is precisely the record this split was built to keep straight.
      if (column.environment && column.environment !== PROD_ENVIRONMENT) continue;

      const done = column.allowed.find((status) => toneOf(status) === 'done');
      if (!done) continue;

      for (const target of targets) {
        const existing = store.cells.find(
          (cell) =>
            cell.sub_module_id === module.id &&
            cell.sub_activity_id === target &&
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
            sub_module_id: module.id,
            sub_activity_id: target,
            column_key: column.key,
            status: done,
            changed_by: actor.displayName,
            changed_at: at,
          });
        }

        record(store, projectId, actor, {
          scope: 'cell',
          label: columnDisplayLabel(column),
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
        payload: { sub_module_id: module.id, cells_changed: changed },
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
      sub_module_id: moduleId,
      sub_activity_id: target,
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
    if (!config.module_names.includes(nodeType)) {
      throw validationFailed(
        `${nodeType} is not a node type on this project. Add it on the Configure screen first.`,
      );
    }

    // The node type and the activity name together are the module's identity: the same
    // activity on two node types is two modules, tracked separately.
    const duplicate = store.sub_modules.some(
      (module) =>
        module.project_id === projectId && module.module_name === nodeType && module.name === name,
    );
    if (duplicate) {
      throw conflict(`${nodeType} · ${name} is already tracked on this project.`);
    }

    const moduleId = randomUUID();
    store.sub_modules.push({
      id: moduleId,
      project_id: projectId,
      module_name: nodeType,
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
          entry.module_name === nodeType &&
          entry.name === name,
      );
      if (existing) {
        existing.used_in_projects += 1;
        store.sub_modules.find((module) => module.id === moduleId)!.library_entry_id = existing.id;
      } else {
        const entryId = randomUUID();
        store.library.push({
          id: entryId,
          tenant_id: actor.tenantId,
          module_name: nodeType,
          name,
          version: 'v1',
          sub_activity_names: [],
          used_in_projects: 1,
        });
        store.sub_modules.find((module) => module.id === moduleId)!.library_entry_id = entryId;
      }
    }

    return { moduleId };
  });
}

// ---------------------------------------------------------------------------
// Subactivities
// ---------------------------------------------------------------------------

function subactivitiesOf(store: StoreData, moduleId: string): SubActivity[] {
  return store.sub_activities
    .filter((subactivity) => subactivity.sub_module_id === moduleId)
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
      throw badRequest('This module is closed. Reopen it before changing its sub_activities.');
    }

    const label = name.trim();
    if (!label) throw validationFailed('A subactivity needs a name.');

    const existing = subactivitiesOf(store, moduleId);
    if (existing.some((subactivity) => subactivity.name === label)) {
      throw conflict(`This module already has a subactivity called ${label}.`);
    }

    const subactivityId = randomUUID();
    store.sub_activities.push({
      id: subactivityId,
      sub_module_id: moduleId,
      name: label,
      order_index: existing.length,
    });

    if (existing.length === 0) {
      // Carry the module's own row down onto the first subactivity, then drop it — the
      // module's cells are derived from here on.
      const ownCells = store.cells.filter(
        (cell) => cell.sub_module_id === moduleId && cell.sub_activity_id === null,
      );
      for (const cell of ownCells) cell.sub_activity_id = subactivityId;
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

    const subactivity = store.sub_activities.find(
      (candidate) => candidate.id === subactivityId && candidate.sub_module_id === moduleId,
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
      throw badRequest('This module is closed. Reopen it before changing its sub_activities.');
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

    store.sub_activities = store.sub_activities.filter(
      (candidate) => candidate.id !== subactivityId,
    );
    store.cells = store.cells.filter(
      (cell) => !(cell.sub_module_id === moduleId && cell.sub_activity_id === subactivityId),
    );

    if (lastOne) {
      const at = nowIso();
      for (const column of columns) {
        store.cells.push({
          sub_module_id: moduleId,
          sub_activity_id: null,
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
        sub_module_id: input.moduleId,
        severity: input.severity,
        phase: input.phase,
        ticket_key: input.ticketKey.trim(),
      },
    });
    store.defects.push({
      id: defectId,
      project_id: projectId,
      sub_module_id: input.moduleId,
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
      partitionKey: defect.sub_module_id,
      actor: actor.displayName,
      payload: { defect_id: defect.id, from: before, to: defect.status },
    });

    record(store, projectId, actor, {
      scope: 'module',
      label: 'DEFECT',
      what: `${defect.ticket_key || 'defect'} ${before} → ${defect.status}`,
      moduleId: defect.sub_module_id,
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
      moduleId: defect.sub_module_id,
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
      sub_module_id: moduleId,
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
    findModule(store, projectId, store.links[index]!.sub_module_id);
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
      // The generic words until its admin picks its own on the Configure screen. A new
      // project should not inherit another team's vocabulary.
      module_label: 'Module',
      sub_module_label: 'Sub-module',
      sub_activity_label: 'Sub-activity',
    });
    store.project_config.push({
      project_id: projectId,
      module_names: [],
      stages: [],
      owners: [],
      link_types: [],
      environments: [],
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
      // A column added here is a plain one. Splitting a deliverable across environments
      // is a decision about the deliverable, not about the name someone typed in a box.
      environment: null,
      group_key: null,
      group_label: null,
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
      const module = store.sub_modules.find((candidate) => candidate.id === cell.sub_module_id);
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
      what: `${columnDisplayLabel(column)} now ${counts ? 'counts toward prod' : 'is informational only'}`,
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
        `${columnDisplayLabel(column)} statuses ${before} → ${deduped.map((key) => statusEntry(key).label).join(', ')}` +
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
      what: `moved ${columnDisplayLabel(moving)} ${direction === 'up' ? 'earlier' : 'later'} on the matrix`,
    });
  });
}

/**
 * Switches an environment on or off for a project.
 *
 * Off is not a delete. Every cell recorded against it stays in the store; the columns
 * simply leave the grid and leave the readiness maths, and switching the environment
 * back on brings them and their contents back exactly as they were. That is what makes
 * this safe to use for "preprod is down this release" as well as for "we have no
 * preprod" — the two are the same operation, and neither destroys a record.
 *
 * Prod cannot be switched off. Readiness is measured against it, so a project with no
 * prod would have a percentage that means nothing and an FNI gate with nothing to check.
 */
export async function setEnvironmentEnabled(
  actor: Actor,
  projectId: string,
  environmentKey: string,
  enabled: boolean,
): Promise<void> {
  await mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'project.config', 'switch an environment on or off');

    const config = store.project_config.find((entry) => entry.project_id === projectId);
    const environment = config?.environments.find((entry) => entry.key === environmentKey);
    if (!config || !environment) {
      throw notFound('That environment is not configured on this project.');
    }
    if (!enabled && environmentKey === PROD_ENVIRONMENT) {
      throw badRequest(
        'Prod cannot be switched off — readiness is measured against it, and the FNI gate reads that percentage.',
      );
    }
    if (environment.enabled === enabled) return;

    environment.enabled = enabled;

    const affected = columnsFor(store, projectId).filter(
      (column) => column.environment === environmentKey,
    ).length;

    record(store, projectId, actor, {
      scope: 'project',
      label: 'CONFIG',
      what: enabled
        ? `switched ${environment.label} back on — its ${affected} ${affected === 1 ? 'column is' : 'columns are'} back on the matrix, holding what was recorded before`
        : `switched ${environment.label} off — its ${affected} ${affected === 1 ? 'column leaves' : 'columns leave'} the matrix and the readiness maths, keeping every cell`,
    });
  });
}

export async function updateConfigList(
  actor: Actor,
  projectId: string,
  list: 'modules' | 'stages' | 'owners' | 'link_types',
  action: 'add' | 'remove',
  value: string,
): Promise<void> {
  await mutate((store) => {
    const access = resolveAccess(store, actor, projectId);
    require_(access, 'project.config', 'change project configuration');

    let config = store.project_config.find((entry) => entry.project_id === projectId);
    if (!config) {
      config = {
        project_id: projectId,
        module_names: [],
        stages: [],
        owners: [],
        link_types: [],
        environments: [],
      };
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

    // `modules` on the wire, `module_names` in the store. The list was renamed when a module
    // became a record with an id of its own: the *names* are still what this editable list
    // holds, and the records are derived from them. One mapping here rather than a second
    // name on the wire that the Java service does not use.
    const field = list === 'modules' ? 'module_names' : list;
    const current = config[field];

    if (action === 'add') {
      const entry = value.trim();
      if (!entry) throw validationFailed('That cannot be empty.');
      if (!current.includes(entry)) current.push(entry);
    } else {
      config[field] = current.filter((item) => item !== value);
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
    store.sub_modules.push({
      id: moduleId,
      project_id: projectId,
      module_name: entry.module_name,
      name: entry.name,
      library_entry_id: entry.id,
      owner: null,
      fni_target_date: null,
      fni_closed_at: null,
      fni_closed_by: null,
      created_at: nowIso(),
    });

    entry.sub_activity_names.forEach((name, index) => {
      store.sub_activities.push({
        id: randomUUID(),
        sub_module_id: moduleId,
        name,
        order_index: index,
      });
    });
    entry.used_in_projects += 1;

    // A clone starts with an empty deliverable row: every cell blank, so the gaps show.
    const columns = columnsFor(store, projectId);
    const targets: (string | null)[] = entry.sub_activity_names.length
      ? store.sub_activities.filter((sub) => sub.sub_module_id === moduleId).map((sub) => sub.id)
      : [null];
    for (const target of targets) {
      for (const column of columns) {
        store.cells.push({
          sub_module_id: moduleId,
          sub_activity_id: target,
          column_key: column.key,
          status: BLANK,
          changed_by: null,
          changed_at: null,
        });
      }
    }

    const config = store.project_config.find((candidate) => candidate.project_id === projectId);
    if (config && !config.module_names.includes(entry.module_name)) {
      config.module_names.push(entry.module_name);
    }

    record(store, projectId, actor, {
      scope: 'module',
      label: 'MODULE',
      what: `cloned ${entry.module_name} · ${entry.name} ${entry.version} from the library`,
      moduleId,
    });

    return { moduleId, nodeType: entry.module_name };
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
      // Never, and stated rather than defaulted: an organisation's admin invites people
      // into their own organisation, and must not be able to mint a platform operator.
      is_super_admin: false,
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

    const { sub_modules: modules } = buildSnapshot(store, actor, projectId);
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
