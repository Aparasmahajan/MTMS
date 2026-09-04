import type {
  Artifact,
  DefectPhase,
  DefectSeverity,
  DefectStatus,
  DeliverableColumn,
  DriftVerdict,
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
  module_id: string;
  column_label: string;
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
  layer: string;
  scope: string;
  cadence: string;
  repo: string;
  lab: string;
  preprod: string;
  prod: string;
  verdict: DriftVerdict;
}

export interface ConfigView {
  columns: DeliverableColumn[];
  node_types: string[];
  stages: { id: string; label: string }[];
  owners: string[];
  link_types: string[];
  phases: DefectPhase[];
}

export interface Snapshot {
  me: {
    user_id: string;
    display_name: string;
    email: string;
    role_names: string[];
    permissions: PermissionKey[];
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
  invitations: InvitationView[];
  drift: {
    rows: DriftRowView[];
    warnings: { id: string; severity: DefectSeverity; text: string; where: string }[];
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
