/**
 * The platform console's wire shapes.
 *
 * These lived in `lib/server/platform.ts` when the API was in this repository. They are
 * *views* — what the service sends — so they belong in `shared` now that the service is a
 * separate program: this half of the contract has to be readable without the Java.
 */

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
  sub_module_count: number;
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
  sub_module_count: number;
  /** Who can administer it, so an organisation is never left without an owner. */
  admins: { display_name: string; email: string; status: string }[];
  /**
   * The subset whose access covers every project, carrying the membership id so it can be
   * revoked. This is the only place an organisation-wide grant is offered for removal — on a
   * project row it would take away far more than the row suggests.
   *
   * Optional because the static demo's runtime does not send it yet; read it with `?? []`.
   */
  org_wide_admins?: ProjectAdminView[];
  projects: PlatformProjectView[];
}

export interface PlatformView {
  me: { display_name: string; email: string };
  organisations: OrganisationView[];
  audit: { id: string; action: string; what: string; who: string; at: string }[];
}
