import { promotionGate } from '@/lib/shared/promotion';
import type { PlatformView } from '@/lib/server/platform';
import type { Snapshot } from '@/lib/shared/views';

/**
 * The demo's workspace — everything above one project.
 *
 * `lib/demo/runtime.ts` is a reducer over a single `Snapshot`, which is all a project
 * screen ever reads. The super admin console is above that line: it creates
 * organisations and projects and assigns their administrators, none of which fits in a
 * snapshot of one project.
 *
 * So the workspace holds the rest — a snapshot per project, and the organisation and
 * administrator records the console reads. Two rules keep it honest:
 *
 * 1. **Anything derivable is derived.** A project's module count and whether it is
 *    configured come from its live snapshot, never from a copy kept here, so the console
 *    cannot drift from the matrix.
 * 2. **A created project is a real, empty project.** It gets its own blank snapshot and
 *    can be switched into, configured and filled in. A console that created rows leading
 *    nowhere would demonstrate the opposite of what it is for.
 */

export interface DemoOrganisation {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended';
  created_at: string;
  /** Project ids, in creation order. The snapshots themselves live in `snapshots`. */
  project_ids: string[];
  /** Organisation-wide administrators — they own every project in it, present and future. */
  admins: { display_name: string; email: string; status: string }[];
}

export interface DemoProjectAdmin {
  user_id: string;
  membership_id: string;
  display_name: string;
  email: string;
  status: string;
  org_wide: boolean;
}

export interface DemoWorkspace {
  /** Which project the app is currently showing. */
  current_project_id: string;
  /** One snapshot per project this demo knows about, keyed by project id. */
  snapshots: Record<string, Snapshot>;
  organisations: DemoOrganisation[];
  /** Project id → the administrators scoped to that project. */
  project_admins: Record<string, DemoProjectAdmin[]>;
  audit: { id: string; action: string; what: string; who: string; at: string }[];
}

function clone<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * Builds the starting workspace from the one baked snapshot.
 *
 * The seed carries several projects in its switcher but data for only one. The others
 * become blank snapshots here, which is what they actually are — a project nobody has
 * configured yet — rather than an error message when someone selects them.
 */
export function seedWorkspace(seed: Snapshot): DemoWorkspace {
  const snapshots: Record<string, Snapshot> = { [seed.project.id]: clone(seed) };

  for (const summary of seed.projects) {
    if (summary.id === seed.project.id) continue;
    snapshots[summary.id] = blankProjectSnapshot(seed, summary);
  }

  return {
    current_project_id: seed.project.id,
    snapshots,
    organisations: [
      {
        id: seed.org.id,
        name: seed.org.name,
        slug: seed.org.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
        status: 'active',
        created_at: new Date().toISOString(),
        project_ids: seed.projects.map((project) => project.id),
        // The seeded organisation's admins, read off the user list the snapshot carries.
        admins: seed.users
          .filter((user) => user.role_name.toLowerCase().includes('admin'))
          .map((user) => ({
            display_name: user.display_name,
            email: user.email,
            status: user.status,
          })),
      },
    ],
    project_admins: {},
    audit: [],
  };
}

/**
 * A project with nothing in it: no columns, no node types, no stages, no modules.
 *
 * Empty is the point. What goes in belongs to the project's own administrator, defined on
 * the Configure screen — a platform operator pre-filling it would be deciding another
 * team's process for them. The people and roles carry over because they belong to the
 * organisation, not to any one project.
 */
export function blankProjectSnapshot(
  from: Snapshot,
  project: { id: string; key: string; name: string },
  org?: { id: string; name: string },
): Snapshot {
  return {
    ...clone(from),
    org: org ?? from.org,
    project: { id: project.id, key: project.key, name: project.name },
    config: {
      columns: [],
      node_types: [],
      stages: [],
      owners: [],
      link_types: [],
      environments: [],
      phases: from.config.phases,
    },
    modules: [],
    audit: [],
    defects: [],
    members: [],
    drift: {
      rows: [],
      warnings: [],
      gate: promotionGate([], [], []),
      reports: [],
      promotions: [],
    },
  };
}

/**
 * The project switcher's contents, derived from the live snapshots.
 *
 * Scoped to one organisation. A super admin creating a project in another organisation
 * must not make it appear in this one's switcher — that is the boundary the whole
 * tenancy model exists to hold.
 */
export function projectSummaries(
  workspace: DemoWorkspace,
  organisationId: string,
): Snapshot['projects'] {
  const mine = new Set(
    workspace.organisations.find((organisation) => organisation.id === organisationId)
      ?.project_ids ?? [],
  );

  return Object.values(workspace.snapshots)
    .filter((snapshot) => mine.has(snapshot.project.id))
    .map((snapshot) => ({
      id: snapshot.project.id,
      key: snapshot.project.key,
      name: snapshot.project.name,
      configured: snapshot.config.columns.length > 0,
      module_count: snapshot.modules.length,
    }));
}

/**
 * The super admin console's view, derived rather than stored.
 *
 * Counts and the configured flag come from each project's own snapshot every time this is
 * called, so the console and the matrix cannot disagree about what a project holds.
 */
export function demoPlatformView(workspace: DemoWorkspace, me: Snapshot['me']): PlatformView {
  return {
    me: { display_name: me.display_name, email: me.email },
    organisations: workspace.organisations.map((organisation) => {
      const projects = organisation.project_ids
        .map((id) => workspace.snapshots[id])
        .filter((snapshot): snapshot is Snapshot => snapshot !== undefined);

      return {
        id: organisation.id,
        name: organisation.name,
        slug: organisation.slug,
        status: organisation.status,
        created_at: organisation.created_at,
        project_count: projects.length,
        configured_project_count: projects.filter(
          (snapshot) => snapshot.config.columns.length > 0,
        ).length,
        user_count: projects[0]?.users.length ?? 0,
        module_count: projects.reduce((total, snapshot) => total + snapshot.modules.length, 0),
        admins: organisation.admins,
        projects: projects.map((snapshot) => ({
          id: snapshot.project.id,
          key: snapshot.project.key,
          name: snapshot.project.name,
          configured: snapshot.config.columns.length > 0,
          module_count: snapshot.modules.length,
          admins: [
            // Organisation-wide access covers every project, this one included. Leaving it
            // out would report a project as unowned when it is not.
            ...organisation.admins.map((admin) => ({
              user_id: admin.email,
              membership_id: `org:${organisation.id}:${admin.email}`,
              display_name: admin.display_name,
              email: admin.email,
              status: admin.status,
              org_wide: true,
            })),
            ...(workspace.project_admins[snapshot.project.id] ?? []),
          ],
        })),
      };
    }),
    audit: workspace.audit.slice(0, 20),
  };
}
