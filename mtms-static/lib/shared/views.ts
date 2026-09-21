import type {
  Artifact,
  AuditScope,
  DefectPhase,
  DefectSeverity,
  DefectStatus,
  DeliverableColumn,
  Environment,
  DriftVerdict,
  DriftWarningKind,
  RunPhase,
} from './domain';
import type { PermissionKey } from './permissions';
import { statusEntry, TONE_STYLE, type ToneStyle } from './vocabulary';
import { z } from 'zod';

/**
 * Denormalised views as the UI consumes them. The wire carries facts (status, who,
 * when, whether a cell is a roll-up); every glyph, tone and tooltip below is derived
 * from those facts by `cellPresentation`, so the matrix and the module detail cannot
 * disagree about what a cell looks like.
 */

export interface CellView {
  column_key: string;
  status: string;
  /** True when the value is derived from sub-activities and must not be edited directly. */
  rolled_up: boolean;
  sub_activity_count: number;
  changed_by: string | null;
  changed_at: string | null;
}

export interface SubActivityView {
  id: string;
  name: string;
  readiness: number;
  cells: CellView[];
  /**
   * Checklists attached to this sub-activity specifically. A list normally sits on the
   * activity above; these are the ones an admin pushed down because this piece differs.
   */
  step_lists: StepListView[];
  owners: OwnerGroupView[];
  threads: ThreadView[];
}

export interface LinkView {
  id: string;
  type: string;
  label: string;
  url: string;
}

export interface RunView {
  child_req_id: string;
  phases: z.infer<typeof RunPhase>[];
  artifacts: z.infer<typeof Artifact>[];
}

export interface SubModuleView {
  id: string;
  module_name: string;
  name: string;
  owner: string | null;
  fni_target_date: string | null;
  closed: boolean;
  closed_by: string | null;
  readiness: number;
  stage_index: number;
  /** Counted columns not yet done, by label — the "missing X, Y, Z" line. */
  missing: string[];
  blank_count: number;
  cells: CellView[];
  sub_activities: SubActivityView[];
  links: LinkView[];
  /**
   * The checklists attached to this sub-module. Deliberately not folded into the matrix: the
   * matrix is the common set of deliverables every sub-module shares, a checklist is the
   * specific process one use case follows, and neither replaces the other.
   */
  step_lists: StepListView[];
  /**
   * One overall owner plus one per team. Separate from `owner` above, which is the single
   * typed-in name the matrix still shows: that one is a string and can never be sent anything,
   * these are real accounts.
   */
  owners: OwnerGroupView[];
  threads: ThreadView[];
  last_run: RunView | null;
}

export interface AuditView {
  id: string;
  scope: AuditScope;
  /** null for a project-level change, such as a column being added. */
  sub_module_id: string | null;
  /** "CFX · 128_TGRP…", or "—" when the change was not about one module. */
  sub_module_label: string;
  /** Column label for a cell change; otherwise MODULE, CONFIG or ACCESS. */
  label: string;
  what: string;
  who: string;
  at: string;
}

export interface DefectView {
  id: string;
  sub_module_id: string;
  sub_module_label: string;
  phase: DefectPhase;
  ticket_key: string;
  ticket_url: string;
  child_req_id: string;
  severity: DefectSeverity;
  description: string;
  raised_by: string;
  assignee: string | null;
  status: DefectStatus;
  created_at: string;
}

export interface LibraryView {
  id: string;
  module_name: string;
  name: string;
  version: string;
  sub_activity_count: number;
  used_in_projects: number;
  in_this_project: boolean;
}

export interface RoleView {
  id: string;
  key: string;
  name: string;
  note: string;
  permissions: PermissionKey[];
  /** Shipped with the organisation. Marks where it came from; its permissions are still editable. */
  is_system: boolean;
  /**
   * Not offered in any picker — owner teams, "who may tick this step", the member role selector.
   * Still sent, because rows already pointing at it have to render with a name, and an admin
   * needs something to click to bring it back. **Every picker must filter on this.**
   */
  hidden: boolean;
  /** How many people hold it. Hiding a role somebody holds is refused; the screen says so first. */
  member_count: number;
}

export interface OrgUserView {
  id: string;
  display_name: string;
  email: string;
  role_name: string;
  scope: string;
  status: string;
}

/** One person's access to the project currently open. */
export interface MemberView {
  /** The membership row, which is what gets changed or removed. */
  membership_id: string;
  user_id: string;
  display_name: string;
  email: string;
  role_id: string;
  role_name: string;
  /** True when the access comes from an organisation-wide membership. */
  org_wide: boolean;
  status: string;
  /**
   * Org-wide access cannot be edited from a project screen, and nobody may remove their
   * own access. The reason is carried so the disabled control can state it.
   */
  editable: boolean;
  locked_reason: string;
}

export interface InvitationView {
  id: string;
  email: string;
  display_name: string;
  role_name: string;
  scope: string;
  state: string;
}


// ---------------------------------------------------------------------------
// Steps — the reusable checklist
// ---------------------------------------------------------------------------

/**
 * One step in the project's library, written once and used on any number of checklists.
 *
 * `role_names` empty means the step names no role that still exists — nobody can tick it,
 * and an admin has to pick one. That is the safe direction: a step whose last allowed role
 * was deleted quietly becoming one anybody may tick is the opposite of what gating meant.
 */
export interface StepDefinitionView {
  id: string;
  name: string;
  description: string;
  role_ids: string[];
  role_names: string[];
  /** How many checklists currently contain it, so retiring one is an informed decision. */
  used_in: number;
}

export interface StepEventView {
  id: string;
  from: string;
  to: string;
  /** "not done → done", already worded by the server. */
  what: string;
  is_override: boolean;
  reason: string | null;
  by: string;
  at: string;
}

export interface StepCommentView {
  id: string;
  author: string;
  body: string;
  created_at: string;
  /** Whether the reader wrote it. Removal is still checked server-side. */
  mine: boolean;
}

/**
 * One step on one checklist.
 *
 * `can_tick` and `locked_reason` are answers, not raw facts — the server has already applied
 * the order rule and the role rule and says whether this reader may act. Nothing here
 * recomputes them. A client that guessed would eventually guess differently from the server,
 * and produce the worst failure a permission system has: a control that looks available and
 * then refuses.
 */
export interface StepEntryView {
  id: string;
  definition_id: string;
  name: string;
  description: string;
  state: 'todo' | 'done' | 'blocked';
  blocked_reason: string | null;
  changed_by: string | null;
  changed_at: string | null;
  allowed_roles: string[];
  can_tick: boolean;
  /** True when this reader can only act by overriding the role gate — warn before they do. */
  is_override_for_me: boolean;
  locked_reason: string;
  history: StepEventView[];
  comments: StepCommentView[];
}

export interface StepListView {
  id: string;
  name: string;
  /** Whether the order is a real sequence. The server refuses an out-of-turn tick. */
  enforce_order: boolean;
  readiness: number;
  done_count: number;
  blocked_count: number;
  entries: StepEntryView[];
}


// ---------------------------------------------------------------------------
// Owners and discussions
// ---------------------------------------------------------------------------

/** One person owning one thing, in one capacity. */
/**
 * One message in the reader's inbox.
 *
 * `link` is a path, not a URL: the service does not know its own public address, and the client
 * reading this is already at the right origin.
 */
export interface NotificationView {
  id: string;
  kind: 'mention' | 'step.blocked' | 'step.ready';
  title: string;
  body: string;
  link: string;
  at: string;
  unread: boolean;
}

export interface OwnerView {
  /** The row, which is what gets removed — not the user id: one person can own for two teams. */
  owner_id: string;
  user_id: string;
  display_name: string;
  email: string;
}

/**
 * The owners of one thing, grouped by team.
 *
 * Only groups with somebody in them are sent, which is what makes "a project with no SME team
 * simply does not show an SME row" true without anything deciding it. `role_id` is null for the
 * overall owner — the one name to ask when you do not know whose problem it is.
 */
export interface OwnerGroupView {
  role_id: string | null;
  label: string;
  people: OwnerView[];
}

export interface ThreadCommentView {
  id: string;
  author: string;
  body: string;
  created_at: string;
  mine: boolean;
  /** The reader was named in it. Until there is a mail transport, showing it is all we can do. */
  mentions_me: boolean;
}

export interface ThreadView {
  id: string;
  topic: string;
  opened_by: string;
  opened_at: string;
  mine: boolean;
  mentions_me: boolean;
  comments: ThreadCommentView[];
}

/**
 * A module, with the counts the landing page and the module screen read.
 *
 * It has an id now, which is what lets a checklist, a set of owners and a discussion attach to
 * it — none of which could attach to the name it used to be.
 */
export interface ModuleView {
  id: string;
  name: string;
  description: string;
  order_index: number;
  sub_module_count: number;
  /** Sub-modules with every counted deliverable done — the matrix's own definition of finished. */
  in_prod: number;
  readiness: number;
  owners: OwnerGroupView[];
  threads: ThreadView[];
}

export interface DriftRowView {
  id: string;
  /** The matrix column this deliverable is tracked as. */
  column_key: string;
  /** The column's label — what the row is called on screen. */
  layer: string;
  scope: string;
  cadence: string;
  /** java | python | yaml | config — the four layers change and fail differently. */
  code_layer: string;
  /** Six characters, for the column. The full hashes ride alongside for the tooltip. */
  repo: string;
  lab: string;
  preprod: string;
  prod: string;
  full_hashes: Record<string, string | null>;
  /** Where the agent found the files. Metadata — identity is the hash. */
  paths: string[];
  verdict: DriftVerdict;
}

export interface DriftWarningView {
  id: string;
  kind: DriftWarningKind;
  severity: DefectSeverity;
  text: string;
  where: string;
}

export interface PromotionGateView {
  checks: { text: string; detail: string; passed: boolean }[];
  blocked: number;
  can_promote: boolean;
  label: string;
}

export interface DriftReportView {
  environment: string;
  agent: string;
  at: string;
  observation_count: number;
}

export interface DriftPromotionView {
  id: string;
  from_environment: string;
  to_environment: string;
  promoted_by: string;
  at: string;
  confirmed_at: string | null;
  column_count: number;
}

/**
 * A column plus what the Configure screen needs to warn about it. Editing a column's
 * allowed statuses never rewrites cells already filled in — doing so would destroy the
 * record of what was actually loaded — so a cell can outlive its column's vocabulary.
 * Those cells keep their own tone and are counted here so Configure can say so.
 */
export interface ColumnView extends DeliverableColumn {
  /** Stored cells holding a status this column no longer allows. Blanks never count. */
  off_vocabulary: number;
  /**
   * Whether the column is on the grid and in the maths. False only for a column whose
   * environment is switched off. Derived, never stored — the flag lives on the
   * environment, so turning preprod back on brings all six of its columns back at once.
   *
   * Every column is still projected onto every module, including the inactive ones, so
   * the cells behind a hidden environment stay addressable and come back untouched.
   */
  active: boolean;
}

export interface ConfigView {
  columns: ColumnView[];
  /** The modules as records, with ids. `module_names` stays for everything that only wants names. */
  modules: ModuleView[];
  module_names: string[];
  stages: { id: string; label: string }[];
  owners: string[];
  link_types: string[];
  environments: Environment[];
  phases: DefectPhase[];
}

/** Environment columns in matrix order, grouped under the deliverable they belong to. */
export interface ColumnGroup {
  /** The group key, or the column's own key when it stands alone. */
  key: string;
  /** The spanning header — `FILECR`, or the column's own label when it stands alone. */
  label: string;
  /** One member for a plain column; one per enabled environment for a grouped one. */
  members: ColumnView[];
}

/**
 * Folds the flat column list into what the header actually draws. Shared so the matrix,
 * the module detail and the static demo cannot disagree about which columns are on
 * screen or which deliverable a tick belongs to.
 */
export function groupColumns(columns: readonly ColumnView[]): ColumnGroup[] {
  const groups: ColumnGroup[] = [];
  for (const column of columns) {
    if (!column.active) continue;
    const key = column.group_key ?? column.key;
    const last = groups[groups.length - 1];
    // Only a *contiguous* run is one group: reordering a column out of its run splits it,
    // which is honest — the header can only span columns that sit next to each other.
    if (last && last.key === key && column.group_key) last.members.push(column);
    else groups.push({ key, label: column.group_label ?? column.label, members: [column] });
  }
  return groups;
}

export interface Snapshot {
  me: {
    user_id: string;
    display_name: string;
    email: string;
    role_names: string[];
    permissions: PermissionKey[];
    /**
     * Platform level, above every organisation — not one of `permissions`, because those
     * are granted by a role an organisation's own admin can edit. See `User.is_super_admin`.
     */
    is_super_admin: boolean;
  };
  org: { id: string; name: string };
  /**
   * `module_label`, `sub_module_label` and `sub_activity_label` are what *this* project calls
   * its three levels — "Node" and "Activity" for CR_AUTOMATION. Read them through
   * `useVocabulary()` rather than reaching in here, so every screen words it the same way.
   */
  project: {
    id: string;
    key: string;
    name: string;
    module_label: string;
    sub_module_label: string;
    sub_activity_label: string;
  };
  projects: { id: string; key: string; name: string; configured: boolean; sub_module_count: number }[];
  config: ConfigView;
  sub_modules: SubModuleView[];
  audit: AuditView[];
  defects: DefectView[];
  library: LibraryView[];
  roles: RoleView[];
  users: OrgUserView[];
  members: MemberView[];
  invitations: InvitationView[];
  /** The step library, for the Configure screen and the "add a step" pickers. */
  step_library: StepDefinitionView[];
  /**
   * The reader's own inbox, unread first. It rides on the snapshot so a tick that unblocks
   * somebody updates their badge in the same round trip — and so no second request fires on
   * every page.
   */
  notifications: NotificationView[];
  unread_notifications: number;
  drift: {
    rows: DriftRowView[];
    warnings: DriftWarningView[];
    gate: PromotionGateView;
    /** The latest report per environment, so "when did anyone last look" is answerable. */
    reports: DriftReportView[];
    promotions: DriftPromotionView[];
  };
  /**
   * How long each column actually takes, computed from the ticks themselves — nobody fills
   * anything in for this.
   *
   * Nulls are meaningful and must not be rendered as 0: a column nobody has finished yet has no
   * median, and "no answer yet" is a different statement from "takes no time".
   */
  timing: ColumnTimingView[];
  /**
   * How long each step takes, from the append-only event history — the more trustworthy of the
   * two, because steps keep every transition and cells keep only the last one. Only steps that
   * have been finished at least once appear.
   */
  step_timing: StepTimingView[];
}

/**
 * Every optional number here is `| null | undefined`, and both halves are load-bearing.
 *
 * The service runs Jackson with `default-property-inclusion: non_null`, so a null field is not
 * sent as `null` — it is **absent from the JSON entirely** and arrives as `undefined`. Typing
 * these as `number | null` alone compiles and then renders the string "undefined" on screen,
 * because `undefined !== null` is true. Test any of them with `== null`, which catches both.
 */
export interface ColumnTimingView {
  column_key: string;
  label: string;
  /** Days from a sub-module being created to this column being done. Absent when nothing is. */
  median_days: number | null | undefined;
  mean_days: number | null | undefined;
  /**
   * How much longer this takes than the column to its left — the closest thing to time spent at
   * this stage. Absent on the first column, which has nothing to compare against. May be negative
   * when the column order is a reading order rather than a sequence.
   */
  added_days: number | null | undefined;
  measured: number;
  /** Not finished here, so not in the figures. "4 days, from 2 of 60" means something else. */
  outstanding: number;
}

/**
 * How long one step takes, from the append-only event history.
 *
 * The accurate counterpart to `ColumnTimingView`. A cell keeps only its last change, so a
 * deliverable corrected a month later reads as having taken a month; step events are never
 * rewritten, so a step ticked, un-ticked and ticked again reports two durations rather than one
 * long span. Same `== null` rule as above — absent fields arrive as `undefined`.
 */
export interface StepTimingView {
  definition_id: string;
  name: string;
  median_days: number | null | undefined;
  mean_days: number | null | undefined;
  /** How many times it was finished, not how many exist. Two goes count twice. */
  completions: number;
  outstanding: number;
}

// ---------------------------------------------------------------------------
// Presentation, derived once so every screen renders a cell the same way
// ---------------------------------------------------------------------------

export interface CellPresentation extends ToneStyle {
  mark: string;
  status_label: string;
  /** "<full column name> — <status>[ · rolled up …][ · who, when]" */
  title: string;
  /** "who · when", or "no change recorded". */
  stamp: string;
  /** A roll-up cell opens the sub-activities instead of advancing. */
  editable: boolean;
}

/**
 * What a column is called away from the grid — in the change feed, in a blocker, in a
 * notice. On the matrix an environment column can be headed `PROD`, because the group
 * header above it says which deliverable it belongs to; anywhere else that header is not
 * there, so the deliverable has to be part of the name.
 */
export function columnDisplayLabel(column: DeliverableColumn): string {
  return column.group_label ? `${column.group_label}·${column.label}` : column.label;
}

export function cellPresentation(cell: CellView, column: DeliverableColumn): CellPresentation {
  const entry = statusEntry(cell.status);
  const tone = TONE_STYLE[entry.tone];

  const rollNote = cell.rolled_up
    ? ` · rolled up from ${cell.sub_activity_count} sub-activities, click to open them`
    : '';
  const stampNote =
    cell.changed_by && cell.changed_at ? ` · ${cell.changed_by}, ${formatStamp(cell.changed_at)}` : '';

  return {
    ...tone,
    mark: entry.mark,
    status_label: entry.label,
    title: `${column.full} — ${entry.label}${rollNote}${stampNote}`,
    stamp:
      cell.changed_by && cell.changed_at
        ? `${cell.changed_by} · ${formatStamp(cell.changed_at)}`
        : 'no change recorded',
    editable: !cell.rolled_up,
  };
}

/** Short, human stamps — the audit feeds read as prose, not as timestamps. */
export function formatStamp(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;
  const seconds = (Date.now() - then.getTime()) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** "missing X, Y, Z +2" — capped so a row never wraps to three lines. */
export function missingLine(missing: readonly string[]): string {
  if (missing.length === 0) return '';
  const head = missing.slice(0, 4).join(', ');
  return `missing ${head}${missing.length > 4 ? ` +${missing.length - 4}` : ''}`;
}
