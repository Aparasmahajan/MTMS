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
    List<Views.ModuleView> modules,
    List<Views.AuditView> audit,
    List<Views.DefectView> defects,
    List<Views.LibraryView> library,
    List<Views.RoleView> roles,
    List<Views.OrgUserView> users,
    List<Views.MemberView> members,
    List<Views.InvitationView> invitations,
    DriftViews.DriftView drift) {

  /**
   * @param permissions this user's effective permissions in <em>this</em> project. The client
   *     uses them only to disable and explain controls; every one is re-checked server-side.
   * @param isSuperAdmin platform level, above every organisation, and deliberately not one of
   *     {@code permissions}. See {@code PermissionKey}.
   */
  public record Me(
      String userId,
      String displayName,
      String email,
      List<String> roleNames,
      List<String> permissions,
      boolean isSuperAdmin) {}

  public record Org(String id, String name) {}

  public record ProjectRef(String id, String key, String name) {}

  public record ProjectSummary(
      String id, String key, String name, boolean configured, int moduleCount) {}
}
