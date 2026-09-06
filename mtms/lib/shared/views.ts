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
  /** True when the value is derived from subactivities and must not be edited directly. */
  rolled_up: boolean;
  subactivity_count: number;
  changed_by: string | null;
  changed_at: string | null;
}

export interface SubactivityView {
  id: string;
  name: string;
  readiness: number;
  cells: CellView[];
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

export interface ModuleView {
  id: string;
  node_type: string;
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
  subactivities: SubactivityView[];
  links: LinkView[];
  last_run: RunView | null;
}

export interface AuditView {
  id: string;
  scope: AuditScope;
  /** null for a project-level change, such as a column being added. */
  module_id: string | null;
  /** "CFX · 128_TGRP…", or "—" when the change was not about one module. */
  module_label: string;
  /** Column label for a cell change; otherwise MODULE, CONFIG or ACCESS. */
  label: string;
  what: string;
  who: string;
  at: string;
}

export interface DefectView {
  id: string;
  module_id: string;
  module_label: string;
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
  node_type: string;
  name: string;
  version: string;
  subactivity_count: number;
  used_in_projects: number;
  in_this_project: boolean;
}

export interface RoleView {
  id: string;
  key: string;
  name: string;
  note: string;
  permissions: PermissionKey[];
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
  node_types: string[];
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
  project: { id: string; key: string; name: string };
  projects: { id: string; key: string; name: string; configured: boolean; module_count: number }[];
  config: ConfigView;
  modules: ModuleView[];
  audit: AuditView[];
  defects: DefectView[];
  library: LibraryView[];
  roles: RoleView[];
  users: OrgUserView[];
  members: MemberView[];
  invitations: InvitationView[];
  drift: {
    rows: DriftRowView[];
    warnings: DriftWarningView[];
    gate: PromotionGateView;
    /** The latest report per environment, so "when did anyone last look" is answerable. */
    reports: DriftReportView[];
    promotions: DriftPromotionView[];
  };
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
  /** A roll-up cell opens the subactivities instead of advancing. */
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
    ? ` · rolled up from ${cell.subactivity_count} subactivities, click to open them`
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
