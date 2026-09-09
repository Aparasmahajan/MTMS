/**
 * Permission keys are the single vocabulary of authorisation.
 *
 * Shape and helpers follow TMS `packages/shared/src/permissions.ts` deliberately: the
 * Access screen renders PERMISSION_GROUPS directly, and `resolveEffectiveAccess` has the
 * same org-wide-or-per-project semantics, so a membership row means the same thing in
 * both apps. Server enforcement is non-negotiable; the client imports these only to
 * disable and explain controls.
 */

export const PERMISSION_KEYS = [
  'project.view',
  'project.create',
  'project.members.manage',
  'project.config',
  'module.create',
  'module.edit',
  'module.clone',
  'deliverable.update',
  'prod.confirm',
  'fni.date',
  'fni.signoff',
  'defect.create',
  'defect.transition',
  'defect.assign',
  'admin.users.manage',
  'admin.roles.manage',
  'admin.audit.view',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSION_KEYS);

export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_SET.has(value);
}

export const PERMISSION_LABELS: Record<PermissionKey, string> = {
  'project.view': 'View project',
  'project.create': 'Create projects',
  'project.members.manage': 'Manage members',
  'project.config': 'Configure columns & stages',
  'module.create': 'Create modules',
  'module.edit': 'Edit module & subactivities',
  'module.clone': 'Clone from library',
  'deliverable.update': 'Update deliverable status',
  'prod.confirm': 'Confirm loaded in prod',
  'fni.date': 'Set FNI target date',
  'fni.signoff': 'Mark FNI done — close module',
  'defect.create': 'Log a defect',
  'defect.transition': 'Change defect status',
  'defect.assign': 'Assign defects',
  'admin.users.manage': 'Manage users',
  'admin.roles.manage': 'Manage roles',
  'admin.audit.view': 'View audit log',
};

/** Grouping drives the layout of the Access screen's permission grid. */
export const PERMISSION_GROUPS: { label: string; keys: PermissionKey[] }[] = [
  {
    label: 'Project',
    keys: ['project.view', 'project.create', 'project.members.manage', 'project.config'],
  },
  {
    label: 'Module',
    keys: ['module.create', 'module.edit', 'module.clone', 'deliverable.update'],
  },
  { label: 'Sign-off', keys: ['prod.confirm', 'fni.date', 'fni.signoff'] },
  { label: 'Defects', keys: ['defect.create', 'defect.transition', 'defect.assign'] },
  { label: 'Administration', keys: ['admin.users.manage', 'admin.roles.manage', 'admin.audit.view'] },
];

// ---------------------------------------------------------------------------
// Seeded roles
// ---------------------------------------------------------------------------

/**
 * Roles are per organisation and editable — these are only the seeds. The Access
 * screen writes grants back, so nothing below is authoritative at runtime.
 */
export const SEEDED_ROLES: {
  key: string;
  name: string;
  note: string;
  description: string;
  permissions: PermissionKey[];
}[] = [
  {
    key: 'admin',
    name: 'Admin',
    note: 'owns projects',
    description: 'Everything in the organisation: projects, roles, users, configuration, audit.',
    permissions: [...PERMISSION_KEYS],
  },
  {
    key: 'subadmin',
    name: 'Sub-admin',
    note: 'delegated',
    description: 'Everything the admin can do except creating projects and editing roles.',
    permissions: PERMISSION_KEYS.filter(
      (key) => key !== 'project.create' && key !== 'admin.roles.manage',
    ),
  },
  {
    key: 'release',
    name: 'Release mgr',
    note: '',
    description: 'Runs the release: modules, deliverables, prod confirmation and FNI sign-off.',
    permissions: [
      'project.view',
      'module.create',
      'module.edit',
      'module.clone',
      'deliverable.update',
      'prod.confirm',
      'fni.date',
      'fni.signoff',
      'defect.create',
      'defect.transition',
      'defect.assign',
      'admin.audit.view',
    ],
  },
  {
    key: 'devops',
    name: 'DevOps',
    note: '',
    description: 'Updates deliverables and confirms what is actually loaded in prod.',
    permissions: [
      'project.view',
      'deliverable.update',
      'prod.confirm',
      'defect.create',
      'defect.transition',
    ],
  },
  {
    key: 'dev',
    name: 'Developer',
    note: '',
    description: 'Updates deliverables and logs defects.',
    permissions: ['project.view', 'deliverable.update', 'defect.create', 'defect.transition'],
  },
  {
    key: 'qa',
    name: 'QA',
    note: '',
    description: 'As Developer, plus assigning defects.',
    permissions: [
      'project.view',
      'deliverable.update',
      'defect.create',
      'defect.transition',
      'defect.assign',
    ],
  },
  {
    key: 'viewer',
    name: 'Viewer',
    note: 'read only',
    description: 'Read-only. Every mutating control is rendered but disabled and explains itself.',
    permissions: ['project.view'],
  },
];

// ---------------------------------------------------------------------------
// Effective access
// ---------------------------------------------------------------------------

export interface ResolvedGrant {
  /** null = org-wide membership */
  projectId: string | null;
  permissions: readonly string[];
  roleKey: string;
}

export interface EffectiveAccess {
  permissions: Set<PermissionKey>;
  roleKeys: Set<string>;
}

/**
 * A user's effective permissions in a project are the union of their org-wide role and
 * their project-specific role. `projectId: null` asks for org-wide permissions only.
 */
export function resolveEffectiveAccess(
  grants: readonly ResolvedGrant[],
  projectId: string | null,
): EffectiveAccess {
  const permissions = new Set<PermissionKey>();
  const roleKeys = new Set<string>();
  for (const grant of grants) {
    const applies = grant.projectId === null || (projectId !== null && grant.projectId === projectId);
    if (!applies) continue;
    roleKeys.add(grant.roleKey);
    for (const key of grant.permissions) {
      if (isPermissionKey(key)) permissions.add(key);
    }
  }
  return { permissions, roleKeys };
}

export function hasPermission(
  permissions: ReadonlySet<string> | readonly string[],
  key: PermissionKey,
): boolean {
  return Array.isArray(permissions) ? permissions.includes(key) : (permissions as ReadonlySet<string>).has(key);
}

/**
 * The message a disabled control shows. Gating rather than hiding is the rule here —
 * never let a control fail silently.
 */
export function permissionDeniedReason(key: PermissionKey): string {
  return `You do not have ${PERMISSION_LABELS[key].toLowerCase()} (${key}) in this project`;
}

/** Nobody can grant a permission they do not themselves hold. */
export function unGrantablePermissions(
  granterPermissions: ReadonlySet<PermissionKey>,
  requested: readonly string[],
): PermissionKey[] {
  const out: PermissionKey[] = [];
  for (const key of requested) {
    if (isPermissionKey(key) && !granterPermissions.has(key)) out.push(key);
  }
  return out;
}
