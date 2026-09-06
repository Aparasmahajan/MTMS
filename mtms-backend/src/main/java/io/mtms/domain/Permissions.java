package io.mtms.domain;

import java.util.Collection;
import java.util.EnumSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * How a user's memberships become a set of permissions.
 *
 * <p>A port of the resolution half of {@code lib/shared/permissions.ts}. Pure: it is given
 * grants and asked what they add up to. Reading those grants out of the database is the
 * application layer's job, and enforcing the answer is the use case's.
 */
public final class Permissions {

  private Permissions() {}

  /**
   * One membership, flattened to what resolution needs.
   *
   * @param projectId {@code null} means an organisation-wide membership, which applies to
   *     every project. A value means it applies to that project alone.
   */
  public record ResolvedGrant(UUID projectId, List<String> permissions, String roleKey) {}

  /** What a user may do, and the roles that said so. */
  public record EffectiveAccess(Set<PermissionKey> permissions, Set<String> roleKeys) {

    public boolean has(PermissionKey key) {
      return permissions.contains(key);
    }

    public static EffectiveAccess none() {
      return new EffectiveAccess(EnumSet.noneOf(PermissionKey.class), Set.of());
    }
  }

  /**
   * A user's effective permissions in a project are the <em>union</em> of their org-wide role
   * and their project-specific role — never the intersection, and never one overriding the
   * other. Someone who is a Viewer org-wide and a Release manager on one project has release
   * manager rights there and read-only rights everywhere else.
   *
   * @param projectId {@code null} asks for organisation-wide permissions only, which is what
   *     the platform and project-list screens need.
   */
  public static EffectiveAccess resolveEffectiveAccess(
      Collection<ResolvedGrant> grants, UUID projectId) {

    Set<PermissionKey> permissions = EnumSet.noneOf(PermissionKey.class);
    Set<String> roleKeys = new LinkedHashSet<>();

    for (ResolvedGrant grant : grants) {
      boolean applies =
          grant.projectId() == null
              || (projectId != null && grant.projectId().equals(projectId));
      if (!applies) {
        continue;
      }
      roleKeys.add(grant.roleKey());
      for (String wire : grant.permissions()) {
        // Unrecognised keys are dropped, not rejected. See PermissionKey.fromWire.
        PermissionKey.fromWire(wire).ifPresent(permissions::add);
      }
    }
    return new EffectiveAccess(permissions, roleKeys);
  }

  /**
   * Nobody can grant a permission they do not themselves hold.
   *
   * <p>Without this an admin of one organisation could write themselves a role containing
   * every key and quietly escalate. Returns the offending keys so the caller can name them
   * rather than failing with a bare "forbidden".
   */
  public static List<PermissionKey> unGrantablePermissions(
      Set<PermissionKey> granterPermissions, Collection<String> requested) {

    return requested.stream()
        .map(PermissionKey::fromWire)
        .flatMap(java.util.Optional::stream)
        .filter(key -> !granterPermissions.contains(key))
        .distinct()
        .toList();
  }

  // ---------------------------------------------------------------------------
  // Seeded roles
  // ---------------------------------------------------------------------------

  /**
   * The roles a new organisation starts with.
   *
   * <p>Seeds only. Roles are per organisation and editable, the Access screen writes grants
   * back, and nothing here is authoritative at runtime — which is why enforcement always reads
   * the stored role rather than consulting this list.
   */
  public record SeededRole(
      String key, String name, String note, String description, Set<PermissionKey> permissions) {}

  public static final List<SeededRole> SEEDED_ROLES = List.of(
      new SeededRole(
          "admin",
          "Admin",
          "owns projects",
          "Everything in the organisation: projects, roles, users, configuration, audit.",
          EnumSet.allOf(PermissionKey.class)),
      new SeededRole(
          "subadmin",
          "Sub-admin",
          "delegated",
          "Everything the admin can do except creating projects and editing roles.",
          EnumSet.complementOf(
              EnumSet.of(PermissionKey.PROJECT_CREATE, PermissionKey.ADMIN_ROLES_MANAGE))),
      new SeededRole(
          "release",
          "Release mgr",
          "",
          "Runs the release: modules, deliverables, prod confirmation and FNI sign-off.",
          EnumSet.of(
              PermissionKey.PROJECT_VIEW,
              PermissionKey.MODULE_CREATE,
              PermissionKey.MODULE_EDIT,
              PermissionKey.MODULE_CLONE,
              PermissionKey.DELIVERABLE_UPDATE,
              PermissionKey.PROD_CONFIRM,
              PermissionKey.FNI_DATE,
              PermissionKey.FNI_SIGNOFF,
              PermissionKey.DEFECT_CREATE,
              PermissionKey.DEFECT_TRANSITION,
              PermissionKey.DEFECT_ASSIGN,
              PermissionKey.ADMIN_AUDIT_VIEW)),
      new SeededRole(
          "devops",
          "DevOps",
          "",
          "Updates deliverables and confirms what is actually loaded in prod.",
          EnumSet.of(
              PermissionKey.PROJECT_VIEW,
              PermissionKey.DELIVERABLE_UPDATE,
              PermissionKey.PROD_CONFIRM,
              PermissionKey.DEFECT_CREATE,
              PermissionKey.DEFECT_TRANSITION)),
      new SeededRole(
          "dev",
          "Developer",
          "",
          "Updates deliverables and logs defects.",
          EnumSet.of(
              PermissionKey.PROJECT_VIEW,
              PermissionKey.DELIVERABLE_UPDATE,
              PermissionKey.DEFECT_CREATE,
              PermissionKey.DEFECT_TRANSITION)),
      new SeededRole(
          "qa",
          "QA",
          "",
          "As Developer, plus assigning defects.",
          EnumSet.of(
              PermissionKey.PROJECT_VIEW,
              PermissionKey.DELIVERABLE_UPDATE,
              PermissionKey.DEFECT_CREATE,
              PermissionKey.DEFECT_TRANSITION,
              PermissionKey.DEFECT_ASSIGN)),
      new SeededRole(
          "viewer",
          "Viewer",
          "read only",
          "Read-only. Every mutating control is rendered but disabled and explains itself.",
          EnumSet.of(PermissionKey.PROJECT_VIEW)));
}
