package io.mtms.domain.view;

import java.util.List;

/**
 * The whole project, in one object.
 *
 * <p>Every mutation returns a fresh Snapshot, so a click is one round trip rather than a write
 * followed by three refetches. That is the reason the UI has no client-side cache to keep
 * coherent and no loading spinners between related panels: there is only ever one version of
 * the truth on screen, and it arrived all at once.
 *
 * <p>It is assembled by {@code SnapshotProjection} in a single pass over the store and cached
 * per (tenant, project, user, revision) — see {@code SnapshotCache} for why the revision is in
 * the key and why the user has to be.
 */
public record Snapshot(
    Me me,
    Org org,
    ProjectRef project,
    List<ProjectSummary> projects,
    Views.ConfigView config,
    List<Views.SubModuleView> subModules,
    List<Views.AuditView> audit,
    List<Views.DefectView> defects,
    List<Views.LibraryView> library,
    List<Views.RoleView> roles,
    List<Views.OrgUserView> users,
    List<Views.MemberView> members,
    List<Views.InvitationView> invitations,
    /**
     * The step library, for the Configure screen and for the "add a step" pickers. The
     * checklists themselves hang off the sub-modules and sub-activities they are attached to,
     * because that is where they are read.
     */
    List<StepViews.StepDefinitionView> stepLibrary,
    /**
     * The reader's own inbox, newest unread first.
     *
     * <p>Carried on the snapshot rather than fetched separately so that a tick which unblocks
     * somebody updates their badge in the same round trip that updates the checklist — and so
     * there is no second request firing on every page.
     */
    List<Views.NotificationView> notifications,
    int unreadNotifications,
    DriftViews.DriftView drift,
    /**
     * How long work actually takes, per column, computed from the ticks themselves.
     *
     * <p>On the snapshot rather than its own endpoint because it is derived entirely from rows
     * already assembled here: a separate call would re-read the same cells to answer a question
     * this pass has the data for.
     */
    List<Views.ColumnTimingView> timing,
    /**
     * How long each step takes, from the append-only event history.
     *
     * <p>Separate from {@link #timing} because it is measured differently and is the more
     * trustworthy of the two: steps keep every transition, cells keep only the last one.
     */
    List<Views.StepTimingView> stepTiming) {

  /**
   * @param permissions this user's effective permissions in <em>this</em> project. The client
   *     uses them only to disable and explain controls; every one is re-checked server-side.
   * @param isSuperAdmin platform level, above every organisation, and deliberately not one of
   *     {@code permissions}. See {@code PermissionKey}.
   * @param canCreateProjects whether this person may create a project, which is <em>not</em>
   *     {@code permissions.contains("project.create")} and is the reason this field exists.
   *     Permissions resolve as the union of an organisation-wide role and a role on the open
   *     project, so that list says "may create a project <em>somewhere</em>" — and creating a
   *     project is an organisation-wide act, so the server requires the grant to be held
   *     organisation-wide. A screen reading the permission list alone would offer a control the
   *     service then refuses, which is the one thing gating is supposed to prevent.
   */
  public record Me(
      String userId,
      String displayName,
      String email,
      List<String> roleNames,
      List<String> permissions,
      boolean isSuperAdmin,
      boolean canCreateProjects) {}

  public record Org(String id, String name) {}

  /**
   * @param moduleLabel what this project calls a module — "Node" for CR_AUTOMATION. The three
   *     labels travel with the project rather than in the config view because every screen
   *     reads them, including the ones that never look at a column.
   */
  public record ProjectRef(
      String id,
      String key,
      String name,
      String moduleLabel,
      String subModuleLabel,
      String subActivityLabel) {}

  public record ProjectSummary(
      String id, String key, String name, boolean configured, int subModuleCount) {}
}
