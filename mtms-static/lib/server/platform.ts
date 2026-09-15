import { randomUUID } from 'node:crypto';
import { projectKeySchema, type Tenant } from '../shared/domain';
import { SEEDED_ROLES } from '../shared/permissions';
import { newInviteToken, type Actor } from './auth';
import { conflict, forbidden, notFound, validationFailed } from './errors';
import { mutate, nowIso, type StoreData } from './store';

/**
 * The super admin — the level above an organisation.
 *
 * The hierarchy the design describes is Platform → Organisation → Delegated → Project. This
 * file is the first level: it creates organisations (Flow One), onboards each one's first
 * admin, and creates the projects inside them (CR_AUTOMATION).
 *
 * Two boundaries make it safe, and both are deliberate:
 *
 * 1. **Super admin is a flag on the user, not a permission key.** Every key in
 *    `PERMISSION_KEYS` is granted by a role *inside* one organisation, and an organisation's
 *    own admin may edit those roles. If "create organisations" were among them, any admin
 *    could grant it to themselves and mint organisations. The flag is set in the seed and
 *    nothing in the app can turn it on.
 *
 * 2. **It never touches project data.** Nothing here reads or writes a cell, a module, a
 *    defect or an audit entry. It creates the shell — organisation, roles, first admin,
 *    empty project — and stops. What goes in the shell belongs to that organisation's own
 *    admin, and a platform operator has no business seeing it.
 */

function requireSuperAdmin(store: StoreData, actor: Actor): void {
  const user = store.users.find((candidate) => candidate.id === actor.userId);
  if (!user?.is_super_admin) {
    // Deliberately the same wording as any other refusal: whether super admin exists at
    // all is not something an ordinary user needs to learn from an error message.
    throw forbidden('That is not available to your account.');
  }
}

export function isSuperAdmin(store: StoreData, actor: Actor): boolean {
  return store.users.some((user) => user.id === actor.userId && user.is_super_admin);
}

function recordPlatform(
  store: StoreData,
  actor: Actor,
  entry: { action: string; tenantId: string | null; what: string },
): void {
  store.platform_audit.unshift({
    id: randomUUID(),
    action: entry.action,
    tenant_id: entry.tenantId,
    what: entry.what,
    who: actor.displayName,
    at: nowIso(),
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * One person's administrator access to one project.
 *
 * Many administrators to a project and many projects to an administrator, both — the
 * membership row is `(user, project, role)`, so both directions are just rows.
 */
export interface ProjectAdminView {
  user_id: string;
  membership_id: string;
  display_name: string;
  email: string;
  status: string;
  /** True when the access is organisation-wide, covering every project including this one. */
  org_wide: boolean;
}

export interface PlatformProjectView {
  id: string;
  key: string;
  name: string;
  configured: boolean;
  module_count: number;
  /**
   * Everyone who can administer this project. A project with none is a project nobody can
   * configure, so the console shows the count rather than leaving it to be discovered.
   */
  admins: ProjectAdminView[];
}

export interface OrganisationView {
  id: string;
  name: string;
  slug: string;
  status: string;
  created_at: string;
  project_count: number;
  /** Projects that have at least one deliverable column — the rest are shells. */
  configured_project_count: number;
  user_count: number;
  module_count: number;
  /** Who can administer it, so an organisation is never left without an owner. */
  admins: { display_name: string; email: string; status: string }[];
  projects: PlatformProjectView[];
}

export interface PlatformView {
  me: { display_name: string; email: string };
  organisations: OrganisationView[];
  audit: { id: string; action: string; what: string; who: string; at: string }[];
}

export function buildPlatformView(store: StoreData, actor: Actor): PlatformView {
  requireSuperAdmin(store, actor);

  const organisations = store.tenants
    .slice()
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
    .map<OrganisationView>((tenant) => {
      const projects = store.projects.filter((project) => project.tenant_id === tenant.id);
      const users = store.users.filter((user) => user.tenant_id === tenant.id);
      const adminRoleIds = new Set(
        store.roles
          .filter((role) => role.tenant_id === tenant.id && role.permissions.includes('admin.users.manage'))
          .map((role) => role.id),
      );

      return {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        status: tenant.status,
        created_at: tenant.created_at,
        project_count: projects.length,
        configured_project_count: projects.filter((project) => project.configured).length,
        user_count: users.length,
        module_count: store.modules.filter((module) =>
          projects.some((project) => project.id === module.project_id),
        ).length,
        admins: users
          .filter((user) =>
            store.memberships.some(
              (membership) => membership.user_id === user.id && adminRoleIds.has(membership.role_id),
            ),
          )
          .map((user) => ({
            display_name: user.display_name,
            email: user.email,
            status: user.status,
          })),
        projects: projects.map((project) => ({
          id: project.id,
          key: project.key,
          name: project.name,
          configured: project.configured,
          module_count: store.modules.filter((module) => module.project_id === project.id).length,
          admins: store.memberships
            .filter(
              (membership) =>
                membership.tenant_id === tenant.id &&
                adminRoleIds.has(membership.role_id) &&
                // An organisation-wide membership administers every project, this one
                // included — leaving it out would report projects as unowned when they
                // are not.
                (membership.project_id === null || membership.project_id === project.id),
            )
            .flatMap<ProjectAdminView>((membership) => {
              const user = users.find((candidate) => candidate.id === membership.user_id);
              if (!user) return [];
              return [
                {
                  user_id: user.id,
                  membership_id: membership.id,
                  display_name: user.display_name,
                  email: user.email,
                  status: user.status,
                  org_wide: membership.project_id === null,
                },
              ];
            }),
        })),
      };
    });

  return {
    me: { display_name: actor.displayName, email: actor.email },
    organisations,
    audit: store.platform_audit.slice(0, 20).map((entry) => ({
      id: entry.id,
      action: entry.action,
      what: entry.what,
      who: entry.who,
      at: entry.at,
    })),
  };
}

// ---------------------------------------------------------------------------
// Creating an organisation
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Creates an organisation, its role set, and an invitation for its first admin.
 *
 * All three in one mutation on purpose. An organisation with no roles cannot have members,
 * and one with no admin cannot be administered by anybody — it would need a second
 * platform action to become usable, and any failure between the two would leave an
 * orphan nobody owns.
 *
 * Returns the invitation link. There is no mail transport yet, so the caller surfaces it.
 */
export async function createOrganisation(
  actor: Actor,
  input: { name: string; slug?: string; adminEmail: string; adminName?: string },
): Promise<{ tenant: Tenant; inviteToken: string; adminEmail: string }> {
  return mutate((store) => {
    requireSuperAdmin(store, actor);

    const name = input.name.trim();
    if (!name) throw validationFailed('An organisation needs a name.');

    const slug = (input.slug?.trim() || slugify(name)).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      throw validationFailed('The slug may hold lowercase letters, digits and hyphens only.');
    }
    if (store.tenants.some((tenant) => tenant.slug === slug)) {
      throw conflict(`An organisation with the slug "${slug}" already exists.`);
    }

    const adminEmail = input.adminEmail.trim().toLowerCase();
    if (!adminEmail.includes('@')) {
      throw validationFailed('That does not look like an email address.');
    }

    const at = nowIso();
    const tenant: Tenant = { id: randomUUID(), name, slug, created_at: at, status: 'active' };
    store.tenants.push(tenant);

    // Every organisation starts with the same seven roles. They are editable from its own
    // Access screen from that point on; the platform does not manage them.
    const roles = SEEDED_ROLES.map((role) => ({
      id: randomUUID(),
      tenant_id: tenant.id,
      key: role.key,
      name: role.name,
      note: role.note,
      description: role.description,
      is_system: true,
      permissions: [...role.permissions],
    }));
    store.roles.push(...roles);

    const adminRole = roles.find((role) => role.key === 'admin');
    if (!adminRole) throw new Error('The seeded role set has no admin role.');

    // The first admin arrives the same way every other user does — by invitation, setting
    // their own password. The platform never sets a password for anyone.
    const invite = newInviteToken();
    const userId = randomUUID();
    store.users.push({
      id: userId,
      tenant_id: tenant.id,
      email: adminEmail,
      display_name: input.adminName?.trim() || adminEmail,
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
      tenant_id: tenant.id,
      user_id: userId,
      // Organisation-wide: this admin owns every project in it, including ones not yet made.
      project_id: null,
      role_id: adminRole.id,
      created_at: at,
    });

    store.invitations.push({
      id: randomUUID(),
      tenant_id: tenant.id,
      email: adminEmail,
      display_name: input.adminName?.trim() || adminEmail,
      role_id: adminRole.id,
      project_id: null,
      invited_by: actor.displayName,
      invited_at: at,
      accepted_at: null,
    });

    recordPlatform(store, actor, {
      action: 'organisation.created',
      tenantId: tenant.id,
      what: `created ${name} and invited ${adminEmail} as its admin`,
    });

    return { tenant, inviteToken: invite.token, adminEmail };
  });
}

// ---------------------------------------------------------------------------
// Creating a project inside an organisation
// ---------------------------------------------------------------------------

/**
 * Creates an empty project in an organisation.
 *
 * Empty is the point: no columns, no node types, no stages. The team that owns it defines
 * its own process on the Configure screen, which is what makes the app generic. A platform
 * operator seeding a project with the CR_AUTOMATION columns would be deciding another
 * team's process for them.
 */
export async function createOrganisationProject(
  actor: Actor,
  tenantId: string,
  input: { key: string; name?: string; description?: string },
): Promise<{ projectId: string; key: string }> {
  return mutate((store) => {
    requireSuperAdmin(store, actor);

    const tenant = store.tenants.find((candidate) => candidate.id === tenantId);
    if (!tenant) throw notFound('That organisation does not exist.');

    const key = input.key.trim().toUpperCase();
    const parsed = projectKeySchema.safeParse(key);
    if (!parsed.success) {
      throw validationFailed(
        'A project key is uppercase letters, digits and underscores, starting with a letter — like CR_AUTOMATION.',
      );
    }
    if (store.projects.some((project) => project.tenant_id === tenantId && project.key === key)) {
      throw conflict(`${tenant.name} already has a project called ${key}.`);
    }

    const projectId = randomUUID();
    store.projects.push({
      id: projectId,
      tenant_id: tenantId,
      key,
      name: input.name?.trim() || key,
      description: input.description?.trim() ?? '',
      // False until its first deliverable column exists; the app shows a set-up prompt.
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
      // No columns yet, so nothing is tracked per environment yet either.
      environments: [],
    });

    recordPlatform(store, actor, {
      action: 'project.created',
      tenantId,
      what: `created the project ${key} in ${tenant.name}`,
    });

    return { projectId, key };
  });
}

// ---------------------------------------------------------------------------
// Assigning administrators to a project
// ---------------------------------------------------------------------------

/**
 * Gives someone administrator access to one project, inviting them if they are new.
 *
 * This is the step that was missing between "super admin creates a project" and "an
 * admin runs it". Until now only an organisation's *existing* admin could grant access,
 * which is no help to a brand-new organisation's second project — there is nobody in it
 * yet to do the granting.
 *
 * Both directions fall out of the membership row: a project may have as many
 * administrators as it needs, and one administrator may hold as many projects as they
 * need. Nothing here is a special case.
 *
 * A new person arrives by invitation and sets their own password, exactly as every other
 * user does. The platform never sets a password for anyone.
 */
export async function addProjectAdmin(
  actor: Actor,
  projectId: string,
  input: { email: string; displayName?: string },
): Promise<{ email: string; inviteToken: string | null; invited: boolean; projectKey: string }> {
  return mutate((store) => {
    requireSuperAdmin(store, actor);

    const project = store.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw notFound('That project does not exist.');

    const email = input.email.trim().toLowerCase();
    if (!email.includes('@')) throw validationFailed('That does not look like an email address.');

    const adminRole = store.roles.find(
      (role) => role.tenant_id === project.tenant_id && role.key === 'admin',
    );
    if (!adminRole) throw notFound('That organisation has no admin role.');

    const at = nowIso();
    let user = store.users.find(
      (candidate) => candidate.tenant_id === project.tenant_id && candidate.email === email,
    );
    let inviteToken: string | null = null;
    const invited = user === undefined;

    if (!user) {
      const invite = newInviteToken();
      inviteToken = invite.token;
      user = {
        id: randomUUID(),
        tenant_id: project.tenant_id,
        email,
        display_name: input.displayName?.trim() || email,
        is_super_admin: false,
        status: 'invited',
        last_login_at: null,
        created_at: at,
        password_hash: '',
        invite_token_hash: invite.hash,
        invite_expires_at: invite.expiresAt,
      };
      store.users.push(user);
      store.invitations.push({
        id: randomUUID(),
        tenant_id: project.tenant_id,
        email,
        display_name: user.display_name,
        role_id: adminRole.id,
        project_id: projectId,
        invited_by: actor.displayName,
        invited_at: at,
        accepted_at: null,
      });
    }

    // An organisation-wide membership already covers this project, so a second row scoped
    // to it would grant nothing and show as a duplicate administrator.
    const already = store.memberships.some(
      (membership) =>
        membership.user_id === user!.id &&
        membership.role_id === adminRole.id &&
        (membership.project_id === projectId || membership.project_id === null),
    );
    if (already) throw conflict(`${email} already administers ${project.key}.`);

    store.memberships.push({
      id: randomUUID(),
      tenant_id: project.tenant_id,
      user_id: user.id,
      project_id: projectId,
      role_id: adminRole.id,
      created_at: at,
    });

    recordPlatform(store, actor, {
      action: 'project.admin.added',
      tenantId: project.tenant_id,
      what: `made ${email} an administrator of ${project.key}`,
    });

    return { email, inviteToken, invited, projectKey: project.key };
  });
}

/**
 * Takes one administrator's access to one project away.
 *
 * An organisation-wide membership is refused here on purpose. It grants every project at
 * once, so revoking it from a single project's row would quietly take away far more than
 * the row it was clicked on — that belongs on the organisation's own Access screen, where
 * the scope is visible.
 */
export async function removeProjectAdmin(
  actor: Actor,
  projectId: string,
  membershipId: string,
): Promise<void> {
  await mutate((store) => {
    requireSuperAdmin(store, actor);

    const project = store.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw notFound('That project does not exist.');

    const index = store.memberships.findIndex((candidate) => candidate.id === membershipId);
    if (index < 0) throw notFound('That access does not exist.');
    const membership = store.memberships[index] as (typeof store.memberships)[number];

    if (membership.project_id === null) {
      throw validationFailed(
        'That access is organisation-wide, so it covers every project. Change it on the organisation’s own Access screen.',
      );
    }
    if (membership.project_id !== projectId) {
      throw validationFailed('That access is not on this project.');
    }

    const user = store.users.find((candidate) => candidate.id === membership.user_id);
    store.memberships.splice(index, 1);

    recordPlatform(store, actor, {
      action: 'project.admin.removed',
      tenantId: project.tenant_id,
      what: `removed ${user?.email ?? 'an administrator'} from ${project.key}`,
    });
  });
}

/**
 * Suspends or restores an organisation.
 *
 * Suspending does not delete anything and does not touch project data — it is a gate on
 * signing in, so an organisation can be stopped without losing its record of what happened.
 */
export async function setOrganisationStatus(
  actor: Actor,
  tenantId: string,
  status: 'active' | 'suspended',
): Promise<void> {
  await mutate((store) => {
    requireSuperAdmin(store, actor);

    const tenant = store.tenants.find((candidate) => candidate.id === tenantId);
    if (!tenant) throw notFound('That organisation does not exist.');

    // A platform operator locking themselves out of their own organisation is a support
    // call, not a feature.
    const self = store.users.find((user) => user.id === actor.userId);
    if (status === 'suspended' && self?.tenant_id === tenantId) {
      throw validationFailed('You cannot suspend the organisation your own account belongs to.');
    }

    tenant.status = status;
    recordPlatform(store, actor, {
      action: status === 'suspended' ? 'organisation.suspended' : 'organisation.restored',
      tenantId,
      what: `${status === 'suspended' ? 'suspended' : 'restored'} ${tenant.name}`,
    });
  });
}
