import { createHash } from 'node:crypto';
import type {
  AuditEntry,
  Cell,
  Defect,
  DeliverableColumn,
  DriftDeliverable,
  DriftEnvironment,
  DriftLayer,
  DriftObservation,
  DriftReport,
  Invitation,
  Link,
  Membership,
  SubModule,
  LibraryEntry,
  Project,
  ProjectConfig,
  Role,
  Run,
  SubActivity,
  UserWithSecret,
  Module,
  Notification,
  Owner,
  StepComment,
  StepDefinition,
  StepEntry,
  StepEvent,
  StepList,
  StepProgress,
  Thread,
  ThreadComment,
} from '../shared/domain';
import { DRIFT_ENVIRONMENTS, PROD_ENVIRONMENT } from '../shared/domain';
import { SEEDED_ROLES } from '../shared/permissions';
import { STATUS_SETS, toneOf } from '../shared/vocabulary';
import { columnDisplayLabel } from '../shared/views';
import { hashPassword } from './auth';
import { STORE_VERSION, type StoreData } from './store';

/**
 * The seed.
 *
 * Statuses, activity names, node types and deliverable columns are the user's real
 * DevOps sheet. Owners, dates, hashes, run phases and defect text are illustrative —
 * they were not in the sheet, and the matrix note on screen says so.
 *
 * Ids are derived from a stable string so a reseed produces the same document and the
 * seeded audit entries keep pointing at the right modules.
 */

function id(seed: string): string {
  const hex = createHash('md5').update(seed).digest('hex');
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

const TENANT_ID = id('tenant:flow-one');
const PROJECT_ID = id('project:CR_AUTOMATION');

/** Days back from now, so the seeded audit reads as recent whenever it is first run. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

// ---------------------------------------------------------------------------
// Deliverable columns — the seeded set for CR_AUTOMATION, in sheet order
// ---------------------------------------------------------------------------

/**
 * The environments a deliverable is loaded onto, in promotion order.
 *
 * All three ship enabled. A project without a preprod, or one whose lab is down for a
 * release, switches it off on Configure and the six preprod columns leave the grid and
 * the readiness maths together — see `ProjectConfig.environments`.
 */
const ENVIRONMENT_SEED = [
  { key: 'lab', label: 'Lab', short: 'LAB', enabled: true },
  { key: 'preprod', label: 'Preprod', short: 'PRE', enabled: true },
  { key: 'prod', label: 'Prod', short: 'PROD', enabled: true },
];

/**
 * `perEnvironment` marks a deliverable that is loaded onto each environment separately.
 * One such entry becomes one column per environment, each taking a plain Not Loaded /
 * Loaded tick, because the three loads are independent facts rather than one journey:
 * prod can be ticked with lab blank, which is what a single status could never say.
 */
type ColumnSeed = Omit<
  DeliverableColumn,
  'id' | 'project_id' | 'order_index' | 'environment' | 'group_key' | 'group_label'
> & { perEnvironment?: true };

const COLUMN_SEED: ColumnSeed[] = [
  { key: 'oh', label: 'OH', full: 'Order Hub entry created', allowed: [...STATUS_SETS.create], counts: true },
  {
    key: 'filecr',
    label: 'FILECR',
    full: 'NEI code for File CR',
    allowed: [...STATUS_SETS.simple],
    counts: true,
    perEnvironment: true,
  },
  {
    key: 'clicr',
    label: 'CLICR',
    full: 'NEI code for CLICR',
    allowed: [...STATUS_SETS.simple],
    counts: true,
    perEnvironment: true,
  },
  {
    key: 'nemo',
    label: 'NEMO',
    full: 'OM configuration so the BST workflow can call the NEI',
    allowed: [...STATUS_SETS.create],
    counts: true,
  },
  {
    key: 'html',
    label: 'HTML',
    full: 'HTML report files for File CR and CLICR',
    allowed: [...STATUS_SETS.simple],
    counts: true,
    perEnvironment: true,
  },
  {
    key: 'json',
    label: 'JSON.Y',
    full: 'json.yaml template — shared by File CR and CLICR',
    allowed: [...STATUS_SETS.simple],
    counts: true,
    perEnvironment: true,
  },
  {
    key: 'valid',
    label: 'VALID.Y',
    full: 'validation.yaml — File CR',
    allowed: [...STATUS_SETS.simple],
    counts: true,
    perEnvironment: true,
  },
  {
    key: 'exec',
    label: 'EXEC.Y',
    full: 'execution.yaml — CLICR',
    allowed: [...STATUS_SETS.simple],
    counts: true,
    perEnvironment: true,
  },
  { key: 'bst', label: 'BST', full: 'BST workflow logic', allowed: [...STATUS_SETS.simple], counts: true },
  {
    key: 'lookup',
    label: 'LOOKUP',
    full: 'Business service logic / application properties for BST',
    allowed: [...STATUS_SETS.simple],
    counts: true,
  },
  { key: 'email', label: 'EMAIL', full: 'Email template', allowed: [...STATUS_SETS.simple], counts: false },
  { key: 'fni', label: 'FNI', full: 'FNI — final submission', allowed: [...STATUS_SETS.sign], counts: true },
  { key: 'access', label: 'ACCESS', full: 'Node access granted', allowed: [...STATUS_SETS.sign], counts: true },
  { key: 'ritm', label: 'RITM', full: 'RITM raised', allowed: [...STATUS_SETS.ritm], counts: false },
];

/**
 * How far the sheet's single load status had got, as a tick per environment.
 *
 * The sheet recorded one value per deliverable, so "loaded in prod" is evidence that lab
 * and preprod were passed on the way. Read forward, not invented: a value of `lab` ticks
 * lab and leaves the two ahead of it Not Loaded, and a blank stays blank everywhere,
 * because a blank means nobody said.
 */
const LOAD_REACH: Record<string, number> = { notloaded: 0, lab: 1, preprod: 2, prod: 3 };

function perEnvironmentStatus(sheetValue: string, environmentIndex: number): string {
  if (sheetValue === '') return '';
  const reach = LOAD_REACH[sheetValue];
  if (reach === undefined) return sheetValue;
  return environmentIndex < reach ? 'loaded' : 'notloaded';
}

// ---------------------------------------------------------------------------
// Modules — faithful to the DevOps sheet. '' = the cell was left blank.
// ---------------------------------------------------------------------------

type Row = Record<string, string>;

const L = 'prod';
const NL = 'notloaded';
const C = 'created';
const NC = 'notcreated';
const LD = 'loaded';
const CP = 'completed';
const PD = 'pending';
const B = '';

const FULL: Row = {
  oh: C, filecr: L, clicr: L, nemo: C, html: L, json: L, valid: L, exec: L,
  bst: LD, lookup: LD, email: B, fni: CP, access: CP, ritm: B,
};
const FULL_NO_NEMO: Row = { ...FULL, nemo: B };
const NOT_STARTED: Row = {
  oh: C, filecr: B, clicr: B, nemo: B, html: NL, json: NL, valid: NL, exec: NL,
  bst: NL, lookup: B, email: B, fni: B, access: B, ritm: B,
};

interface ModuleSeed {
  ref: string;
  nodeType: string;
  name: string;
  values: Row;
  sub_activities?: string[];
}

const MODULE_SEED: ModuleSeed[] = [
  {
    ref: 'a1', nodeType: 'MRF', name: 'Announcement Loading', values: FULL,
    sub_activities: ['Load announcement set', 'Verify playback on node'],
  },
  { ref: 'a2', nodeType: 'DLU', name: 'DLU update', values: FULL },
  {
    ref: 'a3', nodeType: 'SBC', name: '5_ADDITION_DELETION_MODIFICATION_OF_SIP_FILTER_MM_IN_SBC',
    values: FULL, sub_activities: ['Addition', 'Deletion', 'Modification'],
  },
  {
    ref: 'a4', nodeType: 'SBC', name: '2_ADDITION/DELETION_IN_EMERGENCY_URI_IN_ASBC',
    values: FULL_NO_NEMO, sub_activities: ['Addition', 'Deletion'],
  },
  { ref: 'a5', nodeType: 'SBC', name: '37_DRA_LINK_SHIFTING_GUI', values: FULL_NO_NEMO },
  {
    ref: 'a6', nodeType: 'SBC', name: '19_FEPHFLOWPOLICY_AND_SG_PROFILE_PARAMETER_MODIFICATION',
    values: FULL_NO_NEMO,
  },
  {
    ref: 'a7', nodeType: 'SBC', name: '146_SDP_PROFILE_MODIFICATION_&_TG_MODIFICATION_IN_ISBC',
    values: FULL_NO_NEMO,
  },
  { ref: 'a8', nodeType: 'SBC', name: '127_NEW_SUBNET_CREATION_MEDIA_SBC', values: NOT_STARTED },
  { ref: 'a9', nodeType: 'SBC', name: '106_REMOVE_EVS_CODEC_FROM_MEDIA_CAPACITY_IN_SBC', values: NOT_STARTED },
  { ref: 'a10', nodeType: 'SBC', name: '156_ENUM_PROFILE_AND_TRUNKGROUP_CREATION_IN_PSBC', values: FULL_NO_NEMO },
  { ref: 'a11', nodeType: 'SBC', name: '107_NEW_SUBNET_CREATION_IN_SBC', values: NOT_STARTED },
  {
    ref: 'a12', nodeType: 'SBC', name: '33_LIC_LOADING_IN_SBC',
    values: { ...FULL_NO_NEMO, fni: PD, access: PD },
  },
  { ref: 'a13', nodeType: 'SBC', name: '96_FIXED_LINE_CONFIGURATION_IN_SBC', values: FULL_NO_NEMO },
  { ref: 'a14', nodeType: 'SBC', name: '147_IP_POI_CONFIG_ISBC', values: { ...NOT_STARTED, oh: NC } },
  { ref: 'a15', nodeType: 'EIR', name: '1029_TAC_LOADING_EIR', values: { ...NOT_STARTED, nemo: NC } },
  {
    ref: 'a16', nodeType: 'CFX', name: '128_TGRP_CONFIGURATION_IN_CFX',
    values: {
      oh: C, filecr: B, clicr: B, nemo: NC, html: L, json: L, valid: L, exec: L,
      bst: LD, lookup: LD, email: B, fni: PD, access: PD, ritm: B,
    },
    sub_activities: ['Create TGRP', 'Modify TGRP', 'Delete TGRP'],
  },
  {
    ref: 'a17', nodeType: 'DSR',
    name: '10006_HOST_NAME_REALM_ROUTING_CREATION_MODIFICATION_DELETION_DSR',
    values: { ...NOT_STARTED, oh: NC, nemo: NC },
    sub_activities: ['Creation', 'Modification', 'Deletion'],
  },
  {
    ref: 'a18', nodeType: 'DSR', name: '10005_SAPC_CCPC_PREFERENCE_CHANGE_IN_DSR',
    values: { ...NOT_STARTED, oh: B },
  },
];

const LIBRARY_SEED: Omit<LibraryEntry, 'id' | 'tenant_id'>[] = [
  { module_name: 'MRF', name: 'Announcement Loading', version: 'v3', used_in_projects: 2, sub_activity_names: ['Load announcement set', 'Verify playback on node'] },
  { module_name: 'SBC', name: '5_ADDITION_DELETION_MODIFICATION_OF_SIP_FILTER_MM_IN_SBC', version: 'v2', used_in_projects: 1, sub_activity_names: ['Addition', 'Deletion', 'Modification'] },
  { module_name: 'CFX', name: '128_TGRP_CONFIGURATION_IN_CFX', version: 'v4', used_in_projects: 3, sub_activity_names: ['Create TGRP', 'Modify TGRP', 'Delete TGRP'] },
  { module_name: 'DSR', name: '10006_HOST_NAME_REALM_ROUTING_CREATION_MODIFICATION_DELETION_DSR', version: 'v1', used_in_projects: 1, sub_activity_names: ['Creation', 'Modification', 'Deletion'] },
  { module_name: 'CFX', name: '131_CODEC_PROFILE_MODIFICATION_IN_CFX', version: 'v2', used_in_projects: 1, sub_activity_names: ['Create', 'Modify'] },
  { module_name: 'SBC', name: '88_TLS_CERT_RENEWAL_IN_SBC', version: 'v1', used_in_projects: 2, sub_activity_names: [] },
  { module_name: 'DLU', name: 'DLU bulk subscriber move', version: 'v1', used_in_projects: 1, sub_activity_names: [] },
  { module_name: 'EIR', name: '1030_IMEI_BLACKLIST_LOADING_EIR', version: 'v1', used_in_projects: 1, sub_activity_names: [] },
];

/**
 * The team, and the role each one holds.
 *
 * A job title and a role are not the same thing, and the mapping is where they meet: a
 * test manager needs QA's permissions, a PM needs the release manager's, an SME reviews
 * what QA reviews. Two are worth stating because they are judgement rather than
 * translation — Dhruv is read-only, which is what an intern joining a live release
 * should be, and Nitin holds the platform above the organisation as well as an admin
 * role inside it.
 *
 * `project: null` means organisation-wide: that person owns every project in Flow One,
 * including ones not created yet.
 */
const USER_SEED = [
  // Platform operator. Super admin is a flag on the account, not a role — see below.
  { name: 'Nitin', email: 'nitin@azalio.io', role: 'admin', project: null },
  // Technical manager.
  { name: 'Anand', email: 'anand@azalio.io', role: 'admin', project: null },
  // Project managers — the release manager role runs modules, prod confirmation and FNI.
  { name: 'Sanjay', email: 'sanjay@azalio.io', role: 'release', project: PROJECT_ID },
  { name: 'Ritu', email: 'ritu@azalio.io', role: 'release', project: PROJECT_ID },
  // Test manager, and the SME who reviews alongside them.
  { name: 'Vinayak', email: 'vinayak@azalio.io', role: 'qa', project: PROJECT_ID },
  { name: 'Muskan', email: 'muskan@azalio.io', role: 'qa', project: PROJECT_ID },
  // Developers.
  { name: 'Paras', email: 'paras@azalio.io', role: 'dev', project: PROJECT_ID },
  { name: 'Bhavnish', email: 'bhavnish@azalio.io', role: 'dev', project: PROJECT_ID },
  // Intern: sees everything, changes nothing. Every mutating control renders and explains
  // why it is disabled, which is the clearest demonstration of the permission model there is.
  { name: 'Dhruv', email: 'dhruv@azalio.io', role: 'viewer', project: PROJECT_ID },
  // DevOps — the only role besides release that may confirm a prod load.
  { name: 'Narayana', email: 'narayana@azalio.io', role: 'devops', project: PROJECT_ID },
] as const;

/** Pilot only. Every seeded account shares this; real accounts arrive by invitation. */
export const SEED_PASSWORD = 'tracker';

export async function buildSeed(): Promise<StoreData> {
  const createdAt = daysAgo(40);
  const passwordHash = await hashPassword(SEED_PASSWORD);

  const roles: Role[] = SEEDED_ROLES.map((role) => ({
    id: id(`role:${role.key}`),
    tenant_id: TENANT_ID,
    key: role.key,
    name: role.name,
    note: role.note,
    description: role.description,
    is_system: true,
    hidden: false,
    permissions: [...role.permissions],
  }));

  const users: UserWithSecret[] = USER_SEED.map((user) => ({
    id: id(`user:${user.email}`),
    tenant_id: TENANT_ID,
    email: user.email,
    display_name: user.name,
    status: 'active',
    last_login_at: null,
    created_at: createdAt,
    password_hash: passwordHash,
    invite_token_hash: null,
    invite_expires_at: null,
    // The platform owner. Set here because nothing in the UI can grant it — see the
    // comment on `User.is_super_admin`.
    is_super_admin: user.email === 'nitin@azalio.io',
  }));

  const memberships: Membership[] = USER_SEED.map((user) => ({
    id: id(`membership:${user.email}`),
    tenant_id: TENANT_ID,
    user_id: id(`user:${user.email}`),
    project_id: user.project,
    role_id: id(`role:${user.role}`),
    created_at: createdAt,
  }));

  const projects: Project[] = [
    {
      id: PROJECT_ID,
      tenant_id: TENANT_ID,
      key: 'CR_AUTOMATION',
      name: 'CR_AUTOMATION',
      description: 'Change activities into production for the NEI/CLICR automation.',
      configured: true,
      archived: false,
      created_at: createdAt,
      // What CR_AUTOMATION actually calls its three levels. The generic words are the
      // default; this project overrides them, which is the feature.
      module_label: 'Node',
      sub_module_label: 'Activity',
      sub_activity_label: 'Sub-activity',
    },
    {
      id: id('project:CMDB'),
      tenant_id: TENANT_ID,
      key: 'CMDB',
      name: 'CMDB',
      description: '',
      configured: false,
      archived: false,
      created_at: createdAt,
      module_label: 'Module',
      sub_module_label: 'Sub-module',
      sub_activity_label: 'Sub-activity',
    },
    {
      id: id('project:INVENTORY_SYNC'),
      tenant_id: TENANT_ID,
      key: 'INVENTORY_SYNC',
      name: 'INVENTORY_SYNC',
      description: '',
      configured: false,
      archived: false,
      created_at: createdAt,
      module_label: 'Module',
      sub_module_label: 'Sub-module',
      sub_activity_label: 'Sub-activity',
    },
  ];

  const project_config: ProjectConfig[] = [
    {
      project_id: PROJECT_ID,
      module_names: ['MRF', 'DLU', 'SBC', 'EIR', 'CFX', 'DSR'],
      stages: [
        { id: id('stage:s1'), label: 'Not started' },
        { id: id('stage:s2'), label: 'Code created' },
        { id: id('stage:s3'), label: 'In UT' },
        { id: id('stage:s4'), label: 'Lab / Preprod' },
        { id: id('stage:s5'), label: 'Moving to prod' },
        { id: id('stage:s6'), label: 'Loaded in prod' },
      ],
      owners: ['Paras', 'Bhavnish', 'Sanjay', 'Ritu', 'Vinayak', 'Muskan', 'Narayana'],
      link_types: ['RITM', 'Jira', 'Repo', 'Run log', 'Report', 'Confluence'],
      environments: ENVIRONMENT_SEED.map((environment) => ({ ...environment })),
    },
    {
      project_id: id('project:CMDB'),
      module_names: [],
      stages: [],
      owners: [],
      link_types: [],
      environments: [],
    },
    {
      project_id: id('project:INVENTORY_SYNC'),
      module_names: [],
      stages: [],
      owners: [],
      link_types: [],
      environments: [],
    },
  ];

  /**
   * Expanded, in sheet order, with each per-environment deliverable becoming one column
   * per environment. `sheetKey` is carried alongside so the seeded values below — which
   * are the sheet's, one per deliverable — still find their row.
   */
  const columnPlan: { column: DeliverableColumn; sheetKey: string; environmentIndex: number }[] = [];
  for (const seed of COLUMN_SEED) {
    const { perEnvironment, ...base } = seed;
    if (!perEnvironment) {
      columnPlan.push({
        column: {
          ...base,
          id: id(`column:${base.key}`),
          project_id: PROJECT_ID,
          order_index: columnPlan.length,
          environment: null,
          group_key: null,
          group_label: null,
        },
        sheetKey: base.key,
        environmentIndex: -1,
      });
      continue;
    }

    ENVIRONMENT_SEED.forEach((environment, environmentIndex) => {
      const key = `${base.key}_${environment.key}`;
      columnPlan.push({
        column: {
          ...base,
          key,
          label: environment.short,
          full: `${base.full} — loaded on ${environment.label.toLowerCase()}`,
          // Only prod enters readiness — see PROD_ENVIRONMENT. The toggle is still per
          // column on Configure, so a project that wants its lab load to count can say so.
          counts: base.counts && environment.key === PROD_ENVIRONMENT,
          id: id(`column:${key}`),
          project_id: PROJECT_ID,
          order_index: columnPlan.length,
          environment: environment.key,
          group_key: base.key,
          group_label: base.label,
        },
        sheetKey: base.key,
        environmentIndex,
      });
    });
  }

  const columns: DeliverableColumn[] = columnPlan.map((entry) => entry.column);

  const modules: SubModule[] = [];
  const sub_activities: SubActivity[] = [];
  const cells: Cell[] = [];

  const fniDates: Record<string, string> = { a12: '2026-09-10', a16: '2026-09-08' };
  const ownerNames: Record<string, string> = { a16: 'Paras', a12: 'Sanjay' };

  for (const seed of MODULE_SEED) {
    const moduleId = id(`module:${seed.ref}`);
    modules.push({
      id: moduleId,
      project_id: PROJECT_ID,
      module_name: seed.nodeType,
      name: seed.name,
      library_entry_id: null,
      owner: ownerNames[seed.ref] ?? null,
      fni_target_date: fniDates[seed.ref] ?? null,
      fni_closed_at: null,
      fni_closed_by: null,
      created_at: createdAt,
    });

    const subs = seed.sub_activities ?? [];
    subs.forEach((name, index) => {
      sub_activities.push({
        id: id(`sub:${seed.ref}:${index}`),
        sub_module_id: moduleId,
        name,
        order_index: index,
      });
    });

    // A module with sub_activities has no row of its own — its cells are a roll-up, so
    // the sheet's row is what each subactivity starts from.
    const targets: (string | null)[] = subs.length
      ? subs.map((_, index) => id(`sub:${seed.ref}:${index}`))
      : [null];

    for (const target of targets) {
      for (const [columnIndex, { column, sheetKey, environmentIndex }] of columnPlan.entries()) {
        const sheetValue = seed.values[sheetKey] ?? '';
        const status =
          environmentIndex < 0 ? sheetValue : perEnvironmentStatus(sheetValue, environmentIndex);

        // A finished cell carries when it was finished, and the seed spreads those out along
        // the column order so the timing panel has something true to report: work moves left
        // to right, and each column lands a little after the one before it.
        //
        // Blank and unfinished cells keep a null timestamp, which is the honest value — they
        // were never changed, and the timing figures exclude them rather than counting them
        // as instant.
        const finished = toneOf(status) === 'done';

        cells.push({
          sub_module_id: moduleId,
          sub_activity_id: target,
          column_key: column.key,
          status,
          changed_by: finished ? (ownerNames[seed.ref] ?? 'Sanjay') : null,
          changed_at: finished ? daysAgo(Math.max(1, 30 - columnIndex)) : null,
        });
      }
    }
  }

  const columnLabel = (key: string): string => {
    const column = columns.find((candidate) => candidate.key === key);
    return column ? columnDisplayLabel(column) : key.toUpperCase();
  };

  const auditSeed: { ref: string; column: string; what: string; who: string; days: number }[] = [
    { ref: 'a12', column: 'fni', what: 'Completed → Pending, waiting on access', who: 'Sanjay', days: 1 },
    { ref: 'a16', column: 'nemo', what: 'set Not Created', who: 'Vinayak', days: 2 },
    { ref: 'a10', column: 'exec_prod', what: 'Not Loaded → Loaded', who: 'Paras', days: 2 },
    { ref: 'a3', column: 'nemo', what: 'Created', who: 'Bhavnish', days: 3 },
    { ref: 'a14', column: 'oh', what: 'set Not Created', who: 'Sanjay', days: 6 },
  ];

  const audit: AuditEntry[] = auditSeed.map((entry, index) => ({
    id: id(`audit:${index}`),
    project_id: PROJECT_ID,
    sub_module_id: id(`module:${entry.ref}`),
    sub_activity_id: null,
    scope: 'cell' as const,
    label: columnLabel(entry.column),
    what: entry.what,
    who: entry.who,
    at: daysAgo(entry.days),
  }));

  const library: LibraryEntry[] = LIBRARY_SEED.map((entry) => ({
    ...entry,
    id: id(`library:${entry.module_name}:${entry.name}`),
    tenant_id: TENANT_ID,
  }));

  const defectSeed = [
    {
      ref: 'a16', run: '751', phase: 'Prod deployment' as const, ticket: 'CRAUT-2291', severity: 'High' as const,
      text: 'Comparison report showed 5 false errors — the python script on prod was an older build than the repo copy',
      by: 'Paras', days: 2, status: 'Open' as const,
    },
    {
      ref: 'a1', run: '744', phase: 'Preprod test' as const, ticket: 'CRAUT-2287', severity: 'High' as const,
      text: 'py2 str() on a non-ASCII announcement name aborted the postcheck',
      by: 'Vinayak', days: 1, status: 'Investigating' as const,
    },
    {
      ref: 'a12', run: '748', phase: 'Prod deployment' as const, ticket: 'CRAUT-2301', severity: 'Med' as const,
      text: 'Node access expired mid-run, activity had to be re-scheduled',
      by: 'Sanjay', days: 1, status: 'Open' as const,
    },
    {
      ref: 'a2', run: '739', phase: 'Staging test' as const, ticket: 'CRAUT-2244', severity: 'Low' as const,
      text: 'MOP link in the summary report pointed at the previous attempt',
      by: 'Bhavnish', days: 7, status: 'Fixed' as const,
    },
    {
      ref: 'a3', run: '', phase: 'Staging test' as const, ticket: 'CRAUT-2312', severity: 'Med' as const,
      text: 'Deletion subactivity left an orphan SIP filter entry after rollback',
      by: 'Vinayak', days: 0, status: 'Open' as const,
    },
  ];

  const defects: Defect[] = defectSeed.map((defect, index) => ({
    id: id(`defect:${index}`),
    project_id: PROJECT_ID,
    sub_module_id: id(`module:${defect.ref}`),
    phase: defect.phase,
    ticket_key: defect.ticket,
    child_req_id: defect.run,
    severity: defect.severity,
    description: defect.text,
    raised_by: defect.by,
    assignee: null,
    status: defect.status,
    created_at: daysAgo(defect.days),
  }));

  const links: Link[] = [
    { type: 'RITM', label: 'RITM0184221', url: 'https://snow.internal/RITM0184221' },
    { type: 'Repo', label: 'clicr/templates/yaml', url: 'https://git.internal/nei/clicr/tree/main/templates/yaml' },
    { type: 'Run log', label: '751 execution log', url: '/mnt/shared_data/751/LOGS/execution.log' },
  ].map((link, index) => ({ ...link, id: id(`link:${index}`), sub_module_id: id('module:a16') }));

  const runs: Run[] = [
    {
      id: id('run:751'),
      sub_module_id: id('module:a16'),
      child_req_id: '751',
      at: daysAgo(2),
      phases: [
        { name: 'PRE_NODE_HEALTH_CHECK', steps: '6 / 6 ok', duration: '00:41', ok: true },
        { name: 'BACKUP', steps: '1 / 1 ok', duration: '01:12', ok: true },
        { name: 'ACTIVITY_CONFIGURATION', steps: '12 / 12 ok', duration: '03:58', ok: true },
        { name: 'POST_NODE_HEALTH_CHECK', steps: '6 / 6 ok', duration: '00:44', ok: true },
        { name: 'ROLLBACK_CONFIGURATION', steps: 'not required', duration: '—', ok: false },
      ],
      artifacts: [
        { kind: 'Log', path: '751/LOGS/execution.log', size: '2.1 MB' },
        { kind: 'Precheck', path: '751/Precheck/config.txt', size: '415 KB' },
        { kind: 'Postcheck', path: '751/Postcheck/config.txt', size: '418 KB' },
        { kind: 'Report', path: '751/REPORT/751_CR1_SUMMARY_REPORT.html', size: '6.0 MB' },
        { kind: 'MOP', path: '751/MOP/751-CR1.html', size: '88 KB' },
      ],
    },
  ];

  // -------------------------------------------------------------------------
  // Drift
  //
  // What each deliverable is made of. Layer matters because the four layers in one NEI
  // package change at different rates and fail in different ways.
  // -------------------------------------------------------------------------

  const drift_deliverables: DriftDeliverable[] = (
    [
      { column_key: 'filecr', layer: 'java', scope: 'per flavour', cadence: 'changes often' },
      { column_key: 'clicr', layer: 'python', scope: 'per flavour', cadence: 'changes often' },
      { column_key: 'valid', layer: 'yaml', scope: 'File CR', cadence: 'changes very often' },
      { column_key: 'exec', layer: 'yaml', scope: 'CLICR', cadence: 'changes very often' },
      { column_key: 'json', layer: 'config', scope: 'shared', cadence: 'changes rarely' },
      { column_key: 'html', layer: 'config', scope: 'shared', cadence: 'changes rarely' },
      { column_key: 'bst', layer: 'yaml', scope: 'workflow', cadence: 'changes often' },
    ] as const
  ).map((entry) => ({ ...entry, project_id: PROJECT_ID }));

  /**
   * Observations from the agents. Full sha256, because the identity is the hash — the
   * six characters on screen are a display convenience and nothing keys on them.
   *
   * The set below reproduces the failures the engineer actually hit, so the screen has
   * something true to show before any agent has run:
   *
   * - `json`  — nothing on prod. Never verified, and it is shared by File CR and CLICR.
   * - `clicr` — prod is an older build than the one preprod verified (run 511's 5 false
   *             errors came from exactly this).
   * - `bst`   — preprod and prod agree with each other but not with the repo: edited in
   *             place on the server.
   * - `filecr`— the compiled jar is older than its source, which is how a stale
   *             `NodeDefinition.class` turned into a day of blaming YAML indentation.
   * - `html`  — present in the repo, absent from `.packinglist`, so it does not deploy.
   */
  function hash(seed: string): string {
    return createHash('sha256').update(seed).digest('hex');
  }

  const observationSeed: {
    column: string;
    layer: DriftLayer;
    path: string;
    size: number;
    perEnvironment: Partial<Record<DriftEnvironment, string | null>>;
    builtAt?: string;
    sourceModifiedAt?: string;
    notInPackinglist?: DriftEnvironment[];
  }[] = [
    {
      column: 'filecr',
      layer: 'java',
      path: 'CLICR/ANY/V1/macro_CLICR_ANY_V1.jar',
      size: 4_312_880,
      perEnvironment: { repo: 'filecr-1', lab: 'filecr-1', preprod: 'filecr-1', prod: 'filecr-1' },
      // Built before the source it claims to compile — §7.2.
      builtAt: daysAgo(9),
      sourceModifiedAt: daysAgo(4),
    },
    {
      column: 'clicr',
      layer: 'python',
      path: 'CLICR/ANY/V1/script/python/netconf_compare_xml.py',
      size: 41_204,
      perEnvironment: { repo: 'clicr-2', lab: 'clicr-2', preprod: 'clicr-2', prod: 'clicr-1' },
    },
    {
      column: 'valid',
      layer: 'yaml',
      path: 'CLICR/ANY/V1/templates/yaml/validation.yaml',
      size: 18_662,
      perEnvironment: { repo: 'valid-1', lab: 'valid-1', preprod: 'valid-1', prod: 'valid-1' },
    },
    {
      column: 'exec',
      layer: 'yaml',
      path: 'CLICR/ANY/V1/templates/yaml/execution.yaml',
      size: 26_015,
      perEnvironment: { repo: 'exec-1', lab: 'exec-1', preprod: 'exec-1', prod: 'exec-1' },
    },
    {
      column: 'json',
      layer: 'config',
      path: 'CLICR/ANY/V1/templates/jsonTemplate/jsonTemplate.yaml',
      size: 9_884,
      // Nobody has ever reported this one from prod.
      perEnvironment: { repo: 'json-1', lab: 'json-1', preprod: 'json-1', prod: null },
    },
    {
      column: 'html',
      layer: 'config',
      path: 'CLICR/ANY/V1/templates/html/summary_report.html',
      size: 62_190,
      perEnvironment: { repo: 'html-1', lab: 'html-1', preprod: 'html-1', prod: 'html-1' },
      notInPackinglist: ['repo'],
    },
    {
      column: 'bst',
      layer: 'yaml',
      path: 'CLICR/ANY/V1/templates/yaml/bst_workflow.yaml',
      size: 33_471,
      // Servers agree with each other and not with the repo: patched in place.
      perEnvironment: { repo: 'bst-1', lab: 'bst-1', preprod: 'bst-2', prod: 'bst-2' },
    },
  ];

  const drift_observations: DriftObservation[] = [];
  for (const entry of observationSeed) {
    for (const environment of DRIFT_ENVIRONMENTS) {
      const seedValue = entry.perEnvironment[environment];
      if (!seedValue) continue;
      drift_observations.push({
        id: id(`observation:${entry.column}:${environment}`),
        project_id: PROJECT_ID,
        environment,
        column_key: entry.column,
        layer: entry.layer,
        path: entry.path,
        content_hash: hash(seedValue),
        size_bytes: entry.size,
        built_at: entry.builtAt ?? null,
        source_modified_at: entry.sourceModifiedAt ?? null,
        in_packinglist: !(entry.notInPackinglist ?? []).includes(environment),
        observed_at: daysAgo(environment === 'prod' ? 2 : 1),
        reported_by: `mtms-agent/${environment}`,
      });
    }
  }

  const drift_reports: DriftReport[] = DRIFT_ENVIRONMENTS.map((environment) => ({
    id: id(`drift-report:${environment}`),
    project_id: PROJECT_ID,
    environment,
    agent: `mtms-agent/${environment}`,
    at: daysAgo(environment === 'prod' ? 2 : 1),
    observation_count: drift_observations.filter((row) => row.environment === environment).length,
  }));

  const invitations: Invitation[] = [
    {
      id: id('invite:n.desai'),
      tenant_id: TENANT_ID,
      email: 'aditya@azalio.io',
      display_name: 'Aditya',
      role_id: id('role:qa'),
      project_id: PROJECT_ID,
      invited_by: 'Paras',
      invited_at: daysAgo(2),
      accepted_at: null,
    },
    {
      id: id('invite:t.bose'),
      tenant_id: TENANT_ID,
      email: 'sneha@azalio.io',
      display_name: 'Sneha',
      role_id: id('role:subadmin'),
      project_id: null,
      invited_by: 'Paras',
      invited_at: daysAgo(4),
      accepted_at: daysAgo(3),
    },
  ];


  // -------------------------------------------------------------------------
  // Modules as records, checklists, owners, discussions and the inbox
  // -------------------------------------------------------------------------
  //
  // Seeded with real shape rather than one example of each, because the point of the demo is
  // that somebody can follow a piece of work through: a checklist with a step already ticked
  // and one blocked, an owner per team, a discussion with a mention, and an inbox row that
  // came from that mention. One of everything demonstrates the screens; this demonstrates the
  // product.

  const moduleRecords: Module[] = (project_config[0]?.module_names ?? []).map((name, index) => ({
    id: id(`module:${name}`),
    project_id: PROJECT_ID,
    name,
    description:
      name === 'SBC'
        ? 'Session Border Controller. The busiest node in the programme and the one most CRs touch.'
        : '',
    order_index: index,
    archived_at: null,
  }));

  /**
   * The step library — written once, reused on any checklist.
   *
   * Each names the role allowed to tick it, which is the whole point: "testing done" ticked by
   * the person who wrote the code is not evidence that testing was done.
   */
  const step_definitions: StepDefinition[] = [
    {
      id: id('step:ciq'),
      project_id: PROJECT_ID,
      name: 'CIQ received',
      description: 'The customer implementation questionnaire is in, and complete enough to build from.',
      role_ids: [id('role:subadmin'), id('role:release')],
      archived_at: null,
      created_at: daysAgo(30),
    },
    {
      id: id('step:ut'),
      project_id: PROJECT_ID,
      name: 'Unit tested',
      description: 'The developer has run the change against the unit suite.',
      role_ids: [id('role:dev')],
      archived_at: null,
      created_at: daysAgo(30),
    },
    {
      id: id('step:qa'),
      project_id: PROJECT_ID,
      name: 'Testing done by QA',
      description: 'Independently tested. Not the same person who wrote it.',
      role_ids: [id('role:qa')],
      archived_at: null,
      created_at: daysAgo(30),
    },
    {
      id: id('step:prod'),
      project_id: PROJECT_ID,
      name: 'Loaded in prod',
      description: 'DevOps confirms what is actually running, from the machine rather than the plan.',
      role_ids: [id('role:devops')],
      archived_at: null,
      created_at: daysAgo(30),
    },
  ];

  /**
   * One checklist on the SBC module — its **template** — and two on sub-modules.
   *
   * The module-scoped one is what gets copied onto each sub-module created on SBC from now
   * on, which is the answer to "setting up two hundred of these by hand will not happen".
   */
  const sbcModuleId = id('module:SBC');
  const firstSbc = modules.find((module) => module.module_name === 'SBC');
  const secondSbc = modules.filter((module) => module.module_name === 'SBC')[1];

  const step_lists: StepList[] = [
    {
      id: id('list:sbc-template'),
      project_id: PROJECT_ID,
      name: 'Standard SBC checks',
      scope_type: 'module',
      scope_id: sbcModuleId,
      enforce_order: true,
      archived_at: null,
      created_at: daysAgo(30),
    },
  ];

  const step_entries: StepEntry[] = [];
  const step_progress: StepProgress[] = [];
  const step_events: StepEvent[] = [];
  const step_comments: StepComment[] = [];

  const templateSteps = [id('step:ciq'), id('step:ut'), id('step:qa'), id('step:prod')];
  templateSteps.forEach((definitionId, index) => {
    step_entries.push({
      id: id(`entry:template:${definitionId}`),
      step_list_id: id('list:sbc-template'),
      definition_id: definitionId,
      order_index: index,
    });
  });

  if (firstSbc) {
    step_lists.push({
      id: id('list:sbc-first'),
      project_id: PROJECT_ID,
      name: 'Standard SBC checks',
      scope_type: 'sub_module',
      scope_id: firstSbc.id,
      enforce_order: true,
      archived_at: null,
      created_at: daysAgo(24),
    });

    templateSteps.forEach((definitionId, index) => {
      const entryId = id(`entry:first:${definitionId}`);
      step_entries.push({
        id: entryId,
        step_list_id: id('list:sbc-first'),
        definition_id: definitionId,
        order_index: index,
      });
    });

    // CIQ: ticked, un-ticked when the questionnaire came back short, ticked again. Two
    // durations rather than one long span — which is exactly what the step timing panel is
    // there to report, and what reading the cells alone would get wrong.
    const ciqEntry = id('entry:first:' + id('step:ciq'));
    step_events.push(
      {
        id: id('event:ciq:1'),
        entry_id: ciqEntry,
        from_state: 'todo',
        to_state: 'done',
        is_override: false,
        reason: null,
        by: 'Sanjay',
        at: daysAgo(22),
      },
      {
        id: id('event:ciq:2'),
        entry_id: ciqEntry,
        from_state: 'done',
        to_state: 'todo',
        is_override: false,
        reason: null,
        by: 'Sanjay',
        at: daysAgo(18),
      },
      {
        id: id('event:ciq:3'),
        entry_id: ciqEntry,
        from_state: 'todo',
        to_state: 'done',
        is_override: false,
        reason: null,
        by: 'Sanjay',
        at: daysAgo(16),
      },
    );
    step_progress.push({
      entry_id: ciqEntry,
      state: 'done',
      blocked_reason: null,
      changed_by: 'Sanjay',
      changed_at: daysAgo(16),
    });

    // Unit tested: done, and ticked by an admin on behalf of dev. Recorded as an override,
    // which is the difference between an audit trail and a decoration.
    const utEntry = id('entry:first:' + id('step:ut'));
    step_events.push({
      id: id('event:ut:1'),
      entry_id: utEntry,
      from_state: 'todo',
      to_state: 'done',
      is_override: true,
      reason: 'Bhavnish was on leave and confirmed it over chat.',
      by: 'Anand',
      at: daysAgo(12),
    });
    step_progress.push({
      entry_id: utEntry,
      state: 'done',
      blocked_reason: null,
      changed_by: 'Anand',
      changed_at: daysAgo(12),
    });

    // QA: blocked, with a reason. A blocker is not a defect — it is "waiting on somebody
    // else" — and the checklist is where that becomes visible rather than staying in a chat.
    const qaEntry = id('entry:first:' + id('step:qa'));
    step_events.push({
      id: id('event:qa:1'),
      entry_id: qaEntry,
      from_state: 'todo',
      to_state: 'blocked',
      is_override: false,
      reason: 'Waiting on the vendor to supply a test licence for the SBC lab.',
      by: 'Vinayak',
      at: daysAgo(6),
    });
    step_progress.push({
      entry_id: qaEntry,
      state: 'blocked',
      blocked_reason: 'Waiting on the vendor to supply a test licence for the SBC lab.',
      changed_by: 'Vinayak',
      changed_at: daysAgo(6),
    });

    step_comments.push({
      id: id('comment:qa:1'),
      entry_id: qaEntry,
      author_user_id: id('user:vinayak@azalio.io'),
      author: 'Vinayak',
      body: 'Licence request raised with the vendor on Monday. Chasing daily.',
      created_at: daysAgo(5),
    });
  }

  if (secondSbc) {
    // A second sub-module with the same checklist and nothing ticked, so the demo shows what
    // a checklist looks like before anybody has touched it — and so the timing panel has an
    // outstanding count to report rather than only completions.
    step_lists.push({
      id: id('list:sbc-second'),
      project_id: PROJECT_ID,
      name: 'Standard SBC checks',
      scope_type: 'sub_module',
      scope_id: secondSbc.id,
      enforce_order: false,
      archived_at: null,
      created_at: daysAgo(9),
    });
    templateSteps.forEach((definitionId, index) => {
      step_entries.push({
        id: id(`entry:second:${definitionId}`),
        step_list_id: id('list:sbc-second'),
        definition_id: definitionId,
        order_index: index,
      });
    });
  }

  /**
   * Owners: one overall, then one per team.
   *
   * Rows rather than columns, which is what makes "several owners, per role, at every level"
   * possible without a schema change every time a team is added.
   */
  const owners: Owner[] = [];
  if (firstSbc) {
    owners.push(
      {
        id: id('owner:first:overall'),
        project_id: PROJECT_ID,
        scope_type: 'sub_module',
        scope_id: firstSbc.id,
        user_id: id('user:sanjay@azalio.io'),
        role_id: null,
        created_at: daysAgo(24),
      },
      {
        id: id('owner:first:dev'),
        project_id: PROJECT_ID,
        scope_type: 'sub_module',
        scope_id: firstSbc.id,
        user_id: id('user:bhavnish@azalio.io'),
        role_id: id('role:dev'),
        created_at: daysAgo(24),
      },
      {
        id: id('owner:first:qa'),
        project_id: PROJECT_ID,
        scope_type: 'sub_module',
        scope_id: firstSbc.id,
        user_id: id('user:vinayak@azalio.io'),
        role_id: id('role:qa'),
        created_at: daysAgo(24),
      },
      {
        id: id('owner:first:qa2'),
        project_id: PROJECT_ID,
        scope_type: 'sub_module',
        scope_id: firstSbc.id,
        user_id: id('user:muskan@azalio.io'),
        role_id: id('role:qa'),
        created_at: daysAgo(24),
      },
      {
        id: id('owner:first:devops'),
        project_id: PROJECT_ID,
        scope_type: 'sub_module',
        scope_id: firstSbc.id,
        user_id: id('user:narayana@azalio.io'),
        role_id: id('role:devops'),
        created_at: daysAgo(24),
      },
    );
  }
  owners.push({
    id: id('owner:sbc:overall'),
    project_id: PROJECT_ID,
    scope_type: 'module',
    scope_id: sbcModuleId,
    user_id: id('user:anand@azalio.io'),
    role_id: null,
    created_at: daysAgo(30),
  });

  /** A discussion with a mention in it, and the inbox row that mention produced. */
  const threads: Thread[] = [];
  const thread_comments: ThreadComment[] = [];
  const notifications: Notification[] = [];

  if (firstSbc) {
    threads.push({
      id: id('thread:licence'),
      project_id: PROJECT_ID,
      scope_type: 'sub_module',
      scope_id: firstSbc.id,
      title: 'Vendor licence is holding up QA',
      created_by_user_id: id('user:vinayak@azalio.io'),
      created_by: 'Vinayak',
      created_at: daysAgo(5),
      resolved_at: null,
    });

    thread_comments.push(
      {
        id: id('tc:licence:1'),
        thread_id: id('thread:licence'),
        author_user_id: id('user:vinayak@azalio.io'),
        author: 'Vinayak',
        body: 'The SBC lab licence expired on Friday. Nothing can be tested until it is renewed.',
        mentions: [],
        created_at: daysAgo(5),
      },
      {
        id: id('tc:licence:2'),
        thread_id: id('thread:licence'),
        author_user_id: id('user:vinayak@azalio.io'),
        author: 'Vinayak',
        body: '@Narayana can you confirm whether preprod is on the same licence?',
        mentions: [id('user:narayana@azalio.io')],
        created_at: daysAgo(4),
      },
      {
        id: id('tc:licence:3'),
        thread_id: id('thread:licence'),
        author_user_id: id('user:narayana@azalio.io'),
        author: 'Narayana',
        body: 'Different licence — preprod is fine. Only the lab is affected.',
        mentions: [],
        created_at: daysAgo(4),
      },
    );

    // Written in the same transaction as the comment it is about, which is why an inbox is a
    // complete channel on its own and not a fallback for a webhook nobody configured.
    notifications.push({
      id: id('notif:narayana:mention'),
      tenant_id: TENANT_ID,
      user_id: id('user:narayana@azalio.io'),
      kind: 'mention',
      title: 'Vinayak mentioned you',
      body: '@Narayana can you confirm whether preprod is on the same licence?',
      link: `/sub-modules/${firstSbc.id}`,
      created_at: daysAgo(4),
      read_at: null,
    });

    notifications.push({
      id: id('notif:vinayak:blocked'),
      tenant_id: TENANT_ID,
      user_id: id('user:vinayak@azalio.io'),
      kind: 'step.blocked',
      title: 'Testing done by QA is blocked',
      body: 'Waiting on the vendor to supply a test licence for the SBC lab.',
      link: `/sub-modules/${firstSbc.id}`,
      created_at: daysAgo(6),
      read_at: daysAgo(5),
    });
  }

  return {
    version: STORE_VERSION,
    // The driver owns this from here on; 0 means "never written".
    revision: 0,
    tenants: [
      { id: TENANT_ID, name: 'Flow One', slug: 'flow-one', created_at: createdAt, status: 'active' },
    ],
    users,
    roles,
    memberships,
    invitations,
    projects,
    project_config,
    columns,
    modules: moduleRecords,
    step_definitions,
    step_lists,
    step_entries,
    step_progress,
    step_events,
    step_comments,
    owners,
    threads,
    thread_comments,
    notifications,
    sub_modules: modules,
    sub_activities,
    cells,
    audit,
    library,
    defects,
    links,
    runs,
    drift_deliverables,
    drift_observations,
    drift_reports,
    drift_promotions: [],
    refresh_tokens: [],
    events: [],
    platform_audit: [],
  };
}
