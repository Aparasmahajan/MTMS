import { createHash } from 'node:crypto';
import type {
  Cell,
  CellAudit,
  Defect,
  DeliverableColumn,
  DriftRow,
  DriftWarning,
  Invitation,
  Link,
  Membership,
  Module,
  ModuleLibraryEntry,
  Project,
  ProjectConfig,
  Role,
  Run,
  Subactivity,
  UserWithSecret,
} from '../shared/domain';
import { SEEDED_ROLES } from '../shared/permissions';
import { STATUS_SETS } from '../shared/vocabulary';
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

const COLUMN_SEED: Omit<DeliverableColumn, 'id' | 'project_id' | 'order_index'>[] = [
  { key: 'oh', label: 'OH', full: 'Order Hub entry created', allowed: [...STATUS_SETS.create], counts: true },
  { key: 'filecr', label: 'FILECR', full: 'NEI code for File CR', allowed: [...STATUS_SETS.load], counts: true },
  { key: 'clicr', label: 'CLICR', full: 'NEI code for CLICR', allowed: [...STATUS_SETS.load], counts: true },
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
    allowed: [...STATUS_SETS.load],
    counts: true,
  },
  {
    key: 'json',
    label: 'JSON.Y',
    full: 'json.yaml template — shared by File CR and CLICR',
    allowed: [...STATUS_SETS.load],
    counts: true,
  },
  { key: 'valid', label: 'VALID.Y', full: 'validation.yaml — File CR', allowed: [...STATUS_SETS.load], counts: true },
  { key: 'exec', label: 'EXEC.Y', full: 'execution.yaml — CLICR', allowed: [...STATUS_SETS.load], counts: true },
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
  subactivities?: string[];
}

const MODULE_SEED: ModuleSeed[] = [
  {
    ref: 'a1', nodeType: 'MRF', name: 'Announcement Loading', values: FULL,
    subactivities: ['Load announcement set', 'Verify playback on node'],
  },
  { ref: 'a2', nodeType: 'DLU', name: 'DLU update', values: FULL },
  {
    ref: 'a3', nodeType: 'SBC', name: '5_ADDITION_DELETION_MODIFICATION_OF_SIP_FILTER_MM_IN_SBC',
    values: FULL, subactivities: ['Addition', 'Deletion', 'Modification'],
  },
  {
    ref: 'a4', nodeType: 'SBC', name: '2_ADDITION/DELETION_IN_EMERGENCY_URI_IN_ASBC',
    values: FULL_NO_NEMO, subactivities: ['Addition', 'Deletion'],
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
    subactivities: ['Create TGRP', 'Modify TGRP', 'Delete TGRP'],
  },
  {
    ref: 'a17', nodeType: 'DSR',
    name: '10006_HOST_NAME_REALM_ROUTING_CREATION_MODIFICATION_DELETION_DSR',
    values: { ...NOT_STARTED, oh: NC, nemo: NC },
    subactivities: ['Creation', 'Modification', 'Deletion'],
  },
  {
    ref: 'a18', nodeType: 'DSR', name: '10005_SAPC_CCPC_PREFERENCE_CHANGE_IN_DSR',
    values: { ...NOT_STARTED, oh: B },
  },
];

const LIBRARY_SEED: Omit<ModuleLibraryEntry, 'id' | 'tenant_id'>[] = [
  { node_type: 'MRF', name: 'Announcement Loading', version: 'v3', used_in_projects: 2, subactivity_names: ['Load announcement set', 'Verify playback on node'] },
  { node_type: 'SBC', name: '5_ADDITION_DELETION_MODIFICATION_OF_SIP_FILTER_MM_IN_SBC', version: 'v2', used_in_projects: 1, subactivity_names: ['Addition', 'Deletion', 'Modification'] },
  { node_type: 'CFX', name: '128_TGRP_CONFIGURATION_IN_CFX', version: 'v4', used_in_projects: 3, subactivity_names: ['Create TGRP', 'Modify TGRP', 'Delete TGRP'] },
  { node_type: 'DSR', name: '10006_HOST_NAME_REALM_ROUTING_CREATION_MODIFICATION_DELETION_DSR', version: 'v1', used_in_projects: 1, subactivity_names: ['Creation', 'Modification', 'Deletion'] },
  { node_type: 'CFX', name: '131_CODEC_PROFILE_MODIFICATION_IN_CFX', version: 'v2', used_in_projects: 1, subactivity_names: ['Create', 'Modify'] },
  { node_type: 'SBC', name: '88_TLS_CERT_RENEWAL_IN_SBC', version: 'v1', used_in_projects: 2, subactivity_names: [] },
  { node_type: 'DLU', name: 'DLU bulk subscriber move', version: 'v1', used_in_projects: 1, subactivity_names: [] },
  { node_type: 'EIR', name: '1030_IMEI_BLACKLIST_LOADING_EIR', version: 'v1', used_in_projects: 1, subactivity_names: [] },
];

const USER_SEED = [
  { name: 'P. Mahajan', email: 'parmahaj@nokia.com', role: 'admin', project: null },
  { name: 'A. Iyer', email: 'a.iyer@nokia.com', role: 'subadmin', project: null },
  { name: 'R. Kaur', email: 'r.kaur@nokia.com', role: 'dev', project: PROJECT_ID },
  { name: 'S. Nair', email: 's.nair@nokia.com', role: 'qa', project: PROJECT_ID },
  { name: 'V. Rao', email: 'v.rao@nokia.com', role: 'devops', project: PROJECT_ID },
  { name: 'K. Menon', email: 'k.menon@nokia.com', role: 'viewer', project: PROJECT_ID },
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
    },
  ];

  const project_config: ProjectConfig[] = [
    {
      project_id: PROJECT_ID,
      node_types: ['MRF', 'DLU', 'SBC', 'EIR', 'CFX', 'DSR'],
      stages: [
        { id: id('stage:s1'), label: 'Not started' },
        { id: id('stage:s2'), label: 'Code created' },
        { id: id('stage:s3'), label: 'In UT' },
        { id: id('stage:s4'), label: 'Lab / Preprod' },
        { id: id('stage:s5'), label: 'Moving to prod' },
        { id: id('stage:s6'), label: 'Loaded in prod' },
      ],
      owners: ['P. Mahajan', 'A. Iyer', 'R. Kaur', 'S. Nair'],
      link_types: ['RITM', 'Jira', 'Repo', 'Run log', 'Report', 'Confluence'],
    },
    { project_id: id('project:CMDB'), node_types: [], stages: [], owners: [], link_types: [] },
    { project_id: id('project:INVENTORY_SYNC'), node_types: [], stages: [], owners: [], link_types: [] },
  ];

  const columns: DeliverableColumn[] = COLUMN_SEED.map((column, index) => ({
    ...column,
    id: id(`column:${column.key}`),
    project_id: PROJECT_ID,
    order_index: index,
  }));

  const modules: Module[] = [];
  const subactivities: Subactivity[] = [];
  const cells: Cell[] = [];

  const fniDates: Record<string, string> = { a12: '2026-09-10', a16: '2026-09-08' };
  const owners: Record<string, string> = { a16: 'P. Mahajan', a12: 'A. Iyer' };

  for (const seed of MODULE_SEED) {
    const moduleId = id(`module:${seed.ref}`);
    modules.push({
      id: moduleId,
      project_id: PROJECT_ID,
      node_type: seed.nodeType,
      name: seed.name,
      library_entry_id: null,
      owner: owners[seed.ref] ?? null,
      fni_target_date: fniDates[seed.ref] ?? null,
      fni_closed_at: null,
      fni_closed_by: null,
      created_at: createdAt,
    });

    const subs = seed.subactivities ?? [];
    subs.forEach((name, index) => {
      subactivities.push({
        id: id(`sub:${seed.ref}:${index}`),
        module_id: moduleId,
        name,
        order_index: index,
      });
    });

    // A module with subactivities has no row of its own — its cells are a roll-up, so
    // the sheet's row is what each subactivity starts from.
    const targets: (string | null)[] = subs.length
      ? subs.map((_, index) => id(`sub:${seed.ref}:${index}`))
      : [null];

    for (const target of targets) {
      for (const column of columns) {
        cells.push({
          module_id: moduleId,
          subactivity_id: target,
          column_key: column.key,
          status: seed.values[column.key] ?? '',
          changed_by: null,
          changed_at: null,
        });
      }
    }
  }

  const columnLabel = (key: string): string =>
    columns.find((column) => column.key === key)?.label ?? key.toUpperCase();

  const auditSeed: { ref: string; column: string; what: string; who: string; days: number }[] = [
    { ref: 'a12', column: 'fni', what: 'Completed → Pending, waiting on access', who: 'A. Iyer', days: 1 },
    { ref: 'a16', column: 'nemo', what: 'set Not Created', who: 'S. Nair', days: 2 },
    { ref: 'a10', column: 'exec', what: 'Not Loaded → Loaded in prod', who: 'P. Mahajan', days: 2 },
    { ref: 'a3', column: 'nemo', what: 'Created', who: 'R. Kaur', days: 3 },
    { ref: 'a14', column: 'oh', what: 'set Not Created', who: 'A. Iyer', days: 6 },
  ];

  const cell_audit: CellAudit[] = auditSeed.map((entry, index) => ({
    id: id(`audit:${index}`),
    project_id: PROJECT_ID,
    module_id: id(`module:${entry.ref}`),
    subactivity_id: null,
    column_key: entry.column,
    column_label: columnLabel(entry.column),
    what: entry.what,
    who: entry.who,
    at: daysAgo(entry.days),
  }));

  const library: ModuleLibraryEntry[] = LIBRARY_SEED.map((entry) => ({
    ...entry,
    id: id(`library:${entry.node_type}:${entry.name}`),
    tenant_id: TENANT_ID,
  }));

  const defectSeed = [
    {
      ref: 'a16', run: '751', phase: 'Prod deployment' as const, ticket: 'CRAUT-2291', severity: 'High' as const,
      text: 'Comparison report showed 5 false errors — the python script on prod was an older build than the repo copy',
      by: 'P. Mahajan', days: 2, status: 'Open' as const,
    },
    {
      ref: 'a1', run: '744', phase: 'Preprod test' as const, ticket: 'CRAUT-2287', severity: 'High' as const,
      text: 'py2 str() on a non-ASCII announcement name aborted the postcheck',
      by: 'S. Nair', days: 1, status: 'Investigating' as const,
    },
    {
      ref: 'a12', run: '748', phase: 'Prod deployment' as const, ticket: 'CRAUT-2301', severity: 'Med' as const,
      text: 'Node access expired mid-run, activity had to be re-scheduled',
      by: 'A. Iyer', days: 1, status: 'Open' as const,
    },
    {
      ref: 'a2', run: '739', phase: 'Staging test' as const, ticket: 'CRAUT-2244', severity: 'Low' as const,
      text: 'MOP link in the summary report pointed at the previous attempt',
      by: 'R. Kaur', days: 7, status: 'Fixed' as const,
    },
    {
      ref: 'a3', run: '', phase: 'Staging test' as const, ticket: 'CRAUT-2312', severity: 'Med' as const,
      text: 'Deletion subactivity left an orphan SIP filter entry after rollback',
      by: 'S. Nair', days: 0, status: 'Open' as const,
    },
  ];

  const defects: Defect[] = defectSeed.map((defect, index) => ({
    id: id(`defect:${index}`),
    project_id: PROJECT_ID,
    module_id: id(`module:${defect.ref}`),
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
  ].map((link, index) => ({ ...link, id: id(`link:${index}`), module_id: id('module:a16') }));

  const runs: Run[] = [
    {
      id: id('run:751'),
      module_id: id('module:a16'),
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

  // Hashes are reported by an environment agent; the tracker only compares them.
  const drift_rows: DriftRow[] = [
    { column_key: 'filecr', layer: 'FILECR', scope: 'per flavour', cadence: 'changes often', repo: 'b71e04', lab: 'b71e04', preprod: 'b71e04', prod: 'b71e04' },
    { column_key: 'clicr', layer: 'CLICR', scope: 'per flavour', cadence: 'changes often', repo: 'c0d883', lab: 'c0d883', preprod: 'c0d883', prod: '8e7b03' },
    { column_key: 'valid', layer: 'VALID.Y', scope: 'File CR', cadence: 'changes very often', repo: '5ac118', lab: '5ac118', preprod: '5ac118', prod: '5ac118' },
    { column_key: 'exec', layer: 'EXEC.Y', scope: 'CLICR', cadence: 'changes very often', repo: '9e2f77', lab: '9e2f77', preprod: '9e2f77', prod: '9e2f77' },
    { column_key: 'json', layer: 'JSON.Y', scope: 'shared', cadence: 'changes rarely', repo: '40bb6a', lab: '40bb6a', preprod: '40bb6a', prod: 'unknown' },
    { column_key: 'html', layer: 'HTML', scope: 'shared', cadence: 'changes rarely', repo: 'd3f902', lab: 'd3f902', preprod: 'd3f902', prod: 'd3f902' },
    { column_key: 'bst', layer: 'BST', scope: 'workflow', cadence: 'changes often', repo: '1c8ad5', lab: '1c8ad5', preprod: '77b3e1', prod: '77b3e1' },
  ].map((row) => ({ ...row, id: id(`drift:${row.column_key}`), project_id: PROJECT_ID }));

  const drift_warnings: DriftWarning[] = [
    { severity: 'High' as const, text: 'json.yaml is shared by File CR and CLICR, and prod has no recorded hash for it — a change there lands on both flavours unverified.', where: 'prod · jsonTemplate.yaml' },
    { severity: 'High' as const, text: 'BST workflow logic on preprod and prod does not match the repo. It was edited in place.', where: 'preprod, prod · BST · 77b3e1' },
    { severity: 'Med' as const, text: 'CLICR code on prod is an older build than the one preprod verified.', where: 'prod · macro_CLICR_ANY_V1 · 8e7b03' },
    { severity: 'Med' as const, text: 'Ten activities show a deliverable as loaded while the cell for its dependency is blank.', where: 'matrix · NEMO, EMAIL, RITM columns' },
  ].map((warning, index) => ({ ...warning, id: id(`warning:${index}`), project_id: PROJECT_ID }));

  const invitations: Invitation[] = [
    {
      id: id('invite:n.desai'),
      tenant_id: TENANT_ID,
      email: 'n.desai@nokia.com',
      display_name: 'N. Desai',
      role_id: id('role:qa'),
      project_id: PROJECT_ID,
      invited_by: 'P. Mahajan',
      invited_at: daysAgo(2),
      accepted_at: null,
    },
    {
      id: id('invite:t.bose'),
      tenant_id: TENANT_ID,
      email: 't.bose@nokia.com',
      display_name: 'T. Bose',
      role_id: id('role:subadmin'),
      project_id: null,
      invited_by: 'P. Mahajan',
      invited_at: daysAgo(4),
      accepted_at: daysAgo(3),
    },
  ];

  return {
    version: STORE_VERSION,
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
    modules,
    subactivities,
    cells,
    cell_audit,
    library,
    defects,
    links,
    runs,
    drift_rows,
    drift_warnings,
  };
}
