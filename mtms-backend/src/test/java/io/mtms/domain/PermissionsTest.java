package io.mtms.domain;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.mtms.domain.Permissions.EffectiveAccess;
import io.mtms.domain.Permissions.ResolvedGrant;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

/**
 * Authorisation resolution.
 *
 * <p>The cases that matter here are the ones where a wrong answer is a privilege escalation
 * rather than a rendering bug, so each one is written from that direction: what would somebody
 * gain if this were wrong.
 */
class PermissionsTest {

  private static final UUID PROJECT_A = UUID.fromString("11111111-1111-1111-1111-111111111111");
  private static final UUID PROJECT_B = UUID.fromString("22222222-2222-2222-2222-222222222222");

  private static ResolvedGrant grant(UUID projectId, String roleKey, PermissionKey... keys) {
    return new ResolvedGrant(
        projectId, List.of(keys).stream().map(PermissionKey::wire).toList(), roleKey);
  }

  @Nested
  @DisplayName("resolveEffectiveAccess")
  class Resolution {

    @Test
    @DisplayName("an org-wide grant applies to every project")
    void orgWideApplies() {
      EffectiveAccess access =
          Permissions.resolveEffectiveAccess(
              List.of(grant(null, "viewer", PermissionKey.PROJECT_VIEW)), PROJECT_A);

      assertTrue(access.has(PermissionKey.PROJECT_VIEW));
      assertEquals(Set.of("viewer"), access.roleKeys());
    }

    @Test
    @DisplayName("a project grant does not leak into another project")
    void projectGrantIsScoped() {
      List<ResolvedGrant> grants =
          List.of(grant(PROJECT_A, "release", PermissionKey.FNI_SIGNOFF));

      assertTrue(Permissions.resolveEffectiveAccess(grants, PROJECT_A).has(PermissionKey.FNI_SIGNOFF));
      assertFalse(Permissions.resolveEffectiveAccess(grants, PROJECT_B).has(PermissionKey.FNI_SIGNOFF));
    }

    @Test
    @DisplayName("org-wide and project roles union — neither overrides the other")
    void rolesUnion() {
      EffectiveAccess access =
          Permissions.resolveEffectiveAccess(
              List.of(
                  grant(null, "viewer", PermissionKey.PROJECT_VIEW),
                  grant(PROJECT_A, "release", PermissionKey.FNI_SIGNOFF)),
              PROJECT_A);

      assertTrue(access.has(PermissionKey.PROJECT_VIEW), "kept the org-wide permission");
      assertTrue(access.has(PermissionKey.FNI_SIGNOFF), "gained the project permission");
      assertEquals(Set.of("viewer", "release"), access.roleKeys());
    }

    @Test
    @DisplayName("a null project asks for org-wide permissions only")
    void nullProjectIsOrgWideOnly() {
      EffectiveAccess access =
          Permissions.resolveEffectiveAccess(
              List.of(
                  grant(null, "viewer", PermissionKey.PROJECT_VIEW),
                  grant(PROJECT_A, "admin", PermissionKey.ADMIN_ROLES_MANAGE)),
              null);

      assertTrue(access.has(PermissionKey.PROJECT_VIEW));
      assertFalse(
          access.has(PermissionKey.ADMIN_ROLES_MANAGE),
          "a project-scoped admin is not an org-wide admin");
    }

    @Test
    @DisplayName("an unrecognised key is dropped, not granted, and does not throw")
    void unknownKeyIsDropped() {
      EffectiveAccess access =
          Permissions.resolveEffectiveAccess(
              List.of(new ResolvedGrant(null, List.of("project.view", "wat.nope"), "custom")),
              PROJECT_A);

      assertEquals(Set.of(PermissionKey.PROJECT_VIEW), access.permissions());
    }

    @Test
    @DisplayName("no grants means no permissions")
    void noGrants() {
      assertTrue(Permissions.resolveEffectiveAccess(List.of(), PROJECT_A).permissions().isEmpty());
    }
  }

  @Nested
  @DisplayName("unGrantablePermissions")
  class Escalation {

    @Test
    @DisplayName("names the permissions the granter does not hold")
    void namesTheGap() {
      List<PermissionKey> ungrantable =
          Permissions.unGrantablePermissions(
              Set.of(PermissionKey.PROJECT_VIEW, PermissionKey.DEFECT_CREATE),
              List.of("project.view", "admin.roles.manage", "fni.signoff"));

      assertEquals(
          List.of(PermissionKey.ADMIN_ROLES_MANAGE, PermissionKey.FNI_SIGNOFF), ungrantable);
    }

    @Test
    @DisplayName("granting only what you hold is allowed")
    void grantingWhatYouHold() {
      assertTrue(
          Permissions.unGrantablePermissions(
                  Set.of(PermissionKey.PROJECT_VIEW), List.of("project.view"))
              .isEmpty());
    }

    @Test
    @DisplayName("an unknown key cannot be granted and is not reported as a gap")
    void unknownKeyIgnored() {
      assertTrue(
          Permissions.unGrantablePermissions(Set.of(), List.of("wat.nope")).isEmpty(),
          "an unrecognised key is not a permission, so it is not an escalation either");
    }
  }

  @Nested
  @DisplayName("seeded roles")
  class SeededRoles {

    @Test
    @DisplayName("admin holds every key")
    void adminHoldsEverything() {
      Permissions.SeededRole admin =
          Permissions.SEEDED_ROLES.stream()
              .filter(role -> role.key().equals("admin"))
              .findFirst()
              .orElseThrow();

      assertEquals(PermissionKey.values().length, admin.permissions().size());
    }

    @Test
    @DisplayName("sub-admin is admin minus creating projects and editing roles")
    void subAdminIsDelegated() {
      Permissions.SeededRole subadmin =
          Permissions.SEEDED_ROLES.stream()
              .filter(role -> role.key().equals("subadmin"))
              .findFirst()
              .orElseThrow();

      assertFalse(subadmin.permissions().contains(PermissionKey.PROJECT_CREATE));
      assertFalse(subadmin.permissions().contains(PermissionKey.ADMIN_ROLES_MANAGE));
      assertTrue(subadmin.permissions().contains(PermissionKey.ADMIN_USERS_MANAGE));
      assertEquals(PermissionKey.values().length - 2, subadmin.permissions().size());
    }

    @Test
    @DisplayName("viewer can only view — every seeded role is a superset of that")
    void viewerIsReadOnly() {
      Permissions.SeededRole viewer =
          Permissions.SEEDED_ROLES.stream()
              .filter(role -> role.key().equals("viewer"))
              .findFirst()
              .orElseThrow();

      assertEquals(Set.of(PermissionKey.PROJECT_VIEW), viewer.permissions());

      for (Permissions.SeededRole role : Permissions.SEEDED_ROLES) {
        assertTrue(
            role.permissions().contains(PermissionKey.PROJECT_VIEW),
            role.key() + " must be able to view the project it works in");
      }
    }
  }
}
