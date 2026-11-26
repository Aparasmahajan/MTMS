package io.mtms.application.usecase;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.mtms.MtmsProperties;
import io.mtms.application.Actor;
import io.mtms.application.ServiceException;
import io.mtms.domain.PermissionKey;
import io.mtms.domain.model.Projects;
import io.mtms.domain.model.Tenancy;
import io.mtms.infrastructure.mail.LoggingMailer;
import io.mtms.infrastructure.notify.LoggingNotifier;
import io.mtms.infrastructure.persistence.memory.InMemoryNotificationRepository;
import io.mtms.infrastructure.persistence.memory.InMemoryAccessRepository;
import io.mtms.infrastructure.persistence.memory.InMemoryDatabase;
import io.mtms.infrastructure.persistence.memory.InMemoryDiscussionRepository;
import io.mtms.infrastructure.persistence.memory.InMemoryOwnerRepository;
import io.mtms.infrastructure.persistence.memory.InMemoryProjectRepository;
import io.mtms.infrastructure.persistence.memory.InMemoryStepRepository;
import io.mtms.infrastructure.persistence.memory.InMemorySupportRepositories;
import io.mtms.infrastructure.security.ScryptPasswordHasher;
import java.time.Instant;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

/**
 * Two buttons that both say "remove", and the line between them.
 *
 * <p>This exists because somebody using the real deployment could not tell what the project
 * screen's remove actually did, and they were right not to be sure: the screen offered one word
 * for the narrow act and had no control at all for the wide one. So "take this person off the
 * system" was done by removing them from each project in turn, which never catches an
 * organisation-wide membership because no project screen lists one as removable.
 *
 * <p>Everything here is a property somebody could reasonably get wrong by reading the screen.
 * The first test is the one the whole feature turns on.
 */
@DisplayName("project membership and organisation membership")
class OrganisationMembershipTest {

  private static final UUID TENANT = UUID.randomUUID();

  private InMemoryAccessRepository access;
  private AccessUseCases useCases;
  private ProjectUseCases projectUseCases;

  private UUID projectId;
  private UUID otherProjectId;
  private UUID adminRoleId;
  private UUID viewerRoleId;
  private UUID adminUserId;
  private UUID projectAdminUserId;

  @BeforeEach
  void setUp() {
    InMemoryDatabase db = new InMemoryDatabase();
    access = new InMemoryAccessRepository(db);

    InMemoryProjectRepository projects =
        new InMemoryProjectRepository(
            db,
            new InMemoryStepRepository(db),
            new InMemoryOwnerRepository(db),
            new InMemoryDiscussionRepository(db));

    MutationSupport support =
        new MutationSupport(
            new InMemorySupportRepositories.AuditEntries(db),
            new InMemorySupportRepositories.Outbox(db),
            projects);

    useCases =
        new AccessUseCases(
            access,
            new ScryptPasswordHasher(),
            new LoggingMailer(),
            support,
            // Real, not a stub: inviting and resetting now write a notification to the issuer's
            // own inbox, and a null here would have turned that into a NullPointerException on
            // a path every one of these tests goes through.
            new NotificationUseCases(
                new InMemoryNotificationRepository(db), access, new LoggingNotifier()),
            new MtmsProperties("https://tms.internal/browse", "http://localhost:6010"));

    projectUseCases = new ProjectUseCases(projects, access, support);

    projectId = UUID.randomUUID();
    projects.insert(
        new Projects.Project(
            projectId, TENANT, "CR_AUTOMATION", "CR", "", true, false, Instant.now()));

    otherProjectId = UUID.randomUUID();
    projects.insert(
        new Projects.Project(
            otherProjectId, TENANT, "CMDB", "CMDB", "", true, false, Instant.now()));

    adminRoleId = role("admin", "Admin");
    viewerRoleId = role("viewer", "Viewer");
    adminUserId = user("Anand", false);
    // Backed by a real organisation-wide membership. Organisation-wide actions now read what is
    // held across the organisation from the memberships, not from the Actor's per-project union,
    // so an Actor whose permissions nothing in the repository grants would be refused.
    grantOrgWide(
        adminUserId,
        PermissionKey.PROJECT_VIEW,
        PermissionKey.PROJECT_MEMBERS_MANAGE,
        PermissionKey.ADMIN_USERS_MANAGE);
    // A different person: holds nothing organisation-wide.
    projectAdminUserId = user("Priya", false);
  }

  /** Gives somebody a fresh role holding exactly {@code keys}, across the organisation. */
  private void grantOrgWide(UUID userId, PermissionKey... keys) {
    UUID role = UUID.randomUUID();
    access.insertRole(
        new Tenancy.Role(
            role, TENANT, "r-" + role, "Role " + role, "", "", false, Set.of(keys)));
    access.insertMembership(
        new Tenancy.Membership(UUID.randomUUID(), TENANT, userId, null, role, Instant.now()));
  }

  private UUID role(String key, String name) {
    UUID id = UUID.randomUUID();
    access.insertRole(
        new Tenancy.Role(
            id, TENANT, key, name, "", "", true, Set.of(PermissionKey.PROJECT_VIEW)));
    return id;
  }

  private UUID user(String name, boolean superAdmin) {
    UUID id = UUID.randomUUID();
    access.insertUser(
        new Tenancy.UserWithSecret(
            new Tenancy.User(
                id,
                TENANT,
                name.toLowerCase() + "@azalio.io",
                name,
                superAdmin,
                Tenancy.UserStatus.ACTIVE,
                null,
                Instant.now()),
            "hash",
            null,
            null));
    return id;
  }

  private UUID membership(UUID userId, UUID project) {
    UUID id = UUID.randomUUID();
    access.insertMembership(
        new Tenancy.Membership(id, TENANT, userId, project, viewerRoleId, Instant.now()));
    return id;
  }

  /** An organisation administrator: both keys, on the project currently open. */
  private Actor admin() {
    return new Actor(
        adminUserId,
        TENANT,
        "Anand",
        "anand@azalio.io",
        false,
        projectId,
        Set.of(
            PermissionKey.PROJECT_VIEW,
            PermissionKey.PROJECT_MEMBERS_MANAGE,
            PermissionKey.ADMIN_USERS_MANAGE),
        Set.of());
  }

  /** A project administrator: may manage this project's members and nothing wider. */
  private Actor projectAdmin() {
    return new Actor(
        projectAdminUserId,
        TENANT,
        "Priya",
        "priya@azalio.io",
        false,
        projectId,
        Set.of(PermissionKey.PROJECT_VIEW, PermissionKey.PROJECT_MEMBERS_MANAGE),
        Set.of());
  }

  private Tenancy.User userById(UUID id) {
    return access.findUser(TENANT, id).orElseThrow();
  }

  private long membershipCount(UUID userId) {
    return access.memberships(TENANT).stream().filter(m -> m.userId().equals(userId)).count();
  }

  @Nested
  @DisplayName("removing from a project")
  class FromAProject {

    @Test
    @DisplayName("leaves the account in the organisation, and on every other project")
    void doesNotTouchTheOrganisation() {
      // The reported confusion, written as an assertion. Bhavnish is on two projects; taking him
      // off one must leave the account, and the other project, exactly as they were.
      UUID bhavnish = user("Bhavnish", false);
      UUID here = membership(bhavnish, projectId);
      membership(bhavnish, otherProjectId);

      useCases.removeMember(admin(), here);

      assertEquals(
          Tenancy.UserStatus.ACTIVE,
          userById(bhavnish).status(),
          "removing somebody from a project must not deactivate their account");
      assertEquals(1, membershipCount(bhavnish), "their other project must survive");
    }

    @Test
    @DisplayName("a project administrator may do it")
    void projectAdminMay() {
      UUID dhruv = user("Dhruv", false);
      UUID here = membership(dhruv, projectId);

      useCases.removeMember(projectAdmin(), here);

      assertEquals(0, membershipCount(dhruv));
      assertEquals(Tenancy.UserStatus.ACTIVE, userById(dhruv).status());
    }

    @Test
    @DisplayName("refuses an organisation-wide row, which is not this project's to remove")
    void refusesOrgWide() {
      UUID muskan = user("Muskan", false);
      UUID everywhere = membership(muskan, null);

      assertThrows(ServiceException.class, () -> useCases.removeMember(admin(), everywhere));
      assertEquals(1, membershipCount(muskan));
    }
  }

  @Nested
  @DisplayName("removing from the organisation")
  class FromTheOrganisation {

    @Test
    @DisplayName("takes every membership, including the organisation-wide one")
    void takesEverything() {
      UUID manu = user("Manu", false);
      membership(manu, projectId);
      membership(manu, otherProjectId);
      membership(manu, null);

      useCases.removeFromOrganisation(admin(), manu);

      assertEquals(0, membershipCount(manu));
      assertEquals(Tenancy.UserStatus.DEACTIVATED, userById(manu).status());
    }

    @Test
    @DisplayName("deactivates rather than deletes, so the account can be restored")
    void deactivatesRatherThanDeletes() {
      UUID manu = user("Manu", false);
      membership(manu, projectId);

      useCases.removeFromOrganisation(admin(), manu);
      assertNotNull(access.findUser(TENANT, manu).orElse(null), "the row must still be there");

      useCases.restoreToOrganisation(admin(), manu);

      assertEquals(Tenancy.UserStatus.ACTIVE, userById(manu).status());
      // Restored with nothing. Whatever they had is not stored through the removal, on purpose —
      // "removed" must not be a state that quietly still holds live grants.
      assertEquals(0, membershipCount(manu));
    }

    @Test
    @DisplayName("a project administrator may not: it reaches past their project")
    void projectAdminMayNot() {
      UUID manu = user("Manu", false);
      membership(manu, projectId);

      assertThrows(
          ServiceException.class, () -> useCases.removeFromOrganisation(projectAdmin(), manu));
      assertEquals(Tenancy.UserStatus.ACTIVE, userById(manu).status());
    }

    @Test
    @DisplayName("nobody may remove themselves — the one mistake they could not undo")
    void notYourself() {
      assertThrows(
          ServiceException.class, () -> useCases.removeFromOrganisation(admin(), adminUserId));
      assertEquals(Tenancy.UserStatus.ACTIVE, userById(adminUserId).status());
    }

    @Test
    @DisplayName("an organisation admin may not remove a super admin")
    void notASuperAdmin() {
      UUID platform = user("Paras", true);

      assertThrows(
          ServiceException.class, () -> useCases.removeFromOrganisation(admin(), platform));
      assertEquals(Tenancy.UserStatus.ACTIVE, userById(platform).status());
    }
  }

  @Nested
  @DisplayName("organisation-wide access")
  class OrganisationWide {

    @Test
    @DisplayName("is one row with no project, and is additional to per-project access")
    void grantsOneRow() {
      UUID muskan = user("Muskan", false);
      membership(muskan, projectId);

      useCases.grantOrganisationWide(admin(), muskan, viewerRoleId);

      assertEquals(2, membershipCount(muskan));
      assertTrue(
          access.memberships(TENANT).stream()
              .anyMatch(m -> m.userId().equals(muskan) && m.projectId() == null));
    }

    @Test
    @DisplayName("revoking it keeps every per-project membership")
    void revokingKeepsProjects() {
      UUID muskan = user("Muskan", false);
      membership(muskan, projectId);
      UUID everywhere = membership(muskan, null);

      useCases.revokeOrganisationWide(admin(), everywhere);

      assertEquals(1, membershipCount(muskan));
      assertFalse(
          access.memberships(TENANT).stream()
              .anyMatch(m -> m.userId().equals(muskan) && m.projectId() == null));
      assertEquals(Tenancy.UserStatus.ACTIVE, userById(muskan).status());
    }

    @Test
    @DisplayName("a project administrator may not grant it — it covers projects they cannot open")
    void projectAdminMayNotGrant() {
      UUID muskan = user("Muskan", false);

      assertThrows(
          ServiceException.class,
          () -> useCases.grantOrganisationWide(projectAdmin(), muskan, viewerRoleId));
      assertEquals(0, membershipCount(muskan));
    }

    @Test
    @DisplayName("refuses a second one rather than granting two roles everywhere")
    void refusesADuplicate() {
      UUID muskan = user("Muskan", false);
      useCases.grantOrganisationWide(admin(), muskan, viewerRoleId);

      assertThrows(
          ServiceException.class,
          () -> useCases.grantOrganisationWide(admin(), muskan, adminRoleId));
      assertEquals(1, membershipCount(muskan));
    }

    @Test
    @DisplayName("refuses somebody who has been removed, rather than granting into a dead account")
    void refusesARemovedAccount() {
      UUID manu = user("Manu", false);
      useCases.removeFromOrganisation(admin(), manu);

      assertThrows(
          ServiceException.class,
          () -> useCases.grantOrganisationWide(admin(), manu, viewerRoleId));
    }
  }

  @Nested
  @DisplayName("creating a project")
  class CreatingProjects {

    /** A role carrying project.create, to hang on one membership or another. */
    private UUID creatorRole() {
      UUID id = UUID.randomUUID();
      access.insertRole(
          new Tenancy.Role(
              id,
              TENANT,
              "creator",
              "Creator",
              "",
              "",
              false,
              Set.of(PermissionKey.PROJECT_VIEW, PermissionKey.PROJECT_CREATE)));
      return id;
    }

    private Actor actorWith(UUID userId) {
      return new Actor(
          userId,
          TENANT,
          "Somebody",
          "somebody@azalio.io",
          false,
          projectId,
          // The union a real request would resolve to: they hold project.create *here*, which
          // is exactly the case that used to pass and now must not.
          Set.of(PermissionKey.PROJECT_VIEW, PermissionKey.PROJECT_CREATE),
          Set.of());
    }

    @Test
    @DisplayName("project.create on ONE project is not enough — it says nothing about the org")
    void projectScopedGrantIsNotEnough() {
      UUID person = user("Kavya", false);
      UUID role = creatorRole();
      access.insertMembership(
          new Tenancy.Membership(UUID.randomUUID(), TENANT, person, projectId, role, Instant.now()));

      // actor.permissions() contains PROJECT_CREATE, so the old actor.require(...) passed here.
      assertThrows(
          ServiceException.class,
          () -> projectUseCases.create(actorWith(person), "NEW_ONE", "New One", ""));
    }

    @Test
    @DisplayName("project.create held across the organisation is")
    void organisationWideGrantIs() {
      UUID person = user("Kavya", false);
      UUID role = creatorRole();
      access.insertMembership(
          new Tenancy.Membership(UUID.randomUUID(), TENANT, person, null, role, Instant.now()));

      UUID created = projectUseCases.create(actorWith(person), "NEW_ONE", "New One", "");
      assertNotNull(created);
    }

    @Test
    @DisplayName("a super admin may, holding nothing at all")
    void superAdminMay() {
      UUID platform = user("Paras", true);
      Actor superAdmin =
          new Actor(
              platform, TENANT, "Paras", "paras@azalio.io", true, projectId, Set.of(), Set.of());

      assertNotNull(projectUseCases.create(superAdmin, "NEW_TWO", "New Two", ""));
    }

    @Test
    @DisplayName("the refusal names what is actually needed, rather than repeating the key")
    void theRefusalIsActionable() {
      UUID person = user("Kavya", false);
      UUID role = creatorRole();
      access.insertMembership(
          new Tenancy.Membership(UUID.randomUUID(), TENANT, person, projectId, role, Instant.now()));

      ServiceException refused =
          assertThrows(
              ServiceException.class,
              () -> projectUseCases.create(actorWith(person), "NEW_ONE", "New One", ""));

      // "You do not have create projects (project.create)" would be actively misleading to
      // somebody who can see that they do have it, on the project they are looking at.
      assertTrue(
          refused.getMessage().contains("across the whole organisation"),
          "the message must say the grant has to be organisation-wide: " + refused.getMessage());
    }
  }

  @Nested
  @DisplayName("repairing a role that was wiped")
  class Repair {

    /**
     * The state the production deployment reached, and the way out of it.
     *
     * <p>The old grants endpoint read {@code {permissions: [...]}} while the screen had always
     * sent {@code {permission, granted}}, so one click rewrote a role's whole set to empty and
     * answered 200. When the role that lost everything was Admin, every account holding it lost
     * {@code admin.roles.manage} — and the only screen that could put it back refused them.
     */
    @Test
    @DisplayName("a super admin can grant a permission they do not themselves hold")
    void superAdminCanRepair() {
      UUID wiped = UUID.randomUUID();
      access.insertRole(new Tenancy.Role(wiped, TENANT, "admin2", "Admin", "", "", true, Set.of()));

      // Holds nothing at all — which is exactly the state a wipe leaves its own administrator in.
      Actor superAdmin =
          new Actor(
              user("Paras", true),
              TENANT,
              "Paras",
              "paras@azalio.io",
              true,
              projectId,
              Set.of(),
              Set.of());

      useCases.setRolePermission(superAdmin, wiped, "admin.roles.manage", true);

      assertEquals(
          Set.of(PermissionKey.ADMIN_ROLES_MANAGE),
          access.role(TENANT, wiped).orElseThrow().permissions());
    }

    @Test
    @DisplayName("an organisation admin still cannot grant beyond themselves")
    void escalationStillRefused() {
      UUID limitedUser = user("Limited", false);
      grantOrgWide(limitedUser, PermissionKey.ADMIN_ROLES_MANAGE);
      Actor limited =
          new Actor(
              limitedUser,
              TENANT,
              "Anand",
              "anand@azalio.io",
              false,
              projectId,
              Set.of(PermissionKey.ADMIN_ROLES_MANAGE),
              Set.of());

      assertThrows(
          ServiceException.class,
          () -> useCases.setRolePermission(limited, viewerRoleId, "fni.signoff", true));
    }

    @Test
    @DisplayName("granting one permission leaves the rest of the role alone")
    void oneToggleIsOneChange() {
      // The bug itself, as an assertion: five permissions plus one must be six, never zero.
      UUID id = UUID.randomUUID();
      access.insertRole(
          new Tenancy.Role(
              id,
              TENANT,
              "qa",
              "QA",
              "",
              "",
              false,
              Set.of(
                  PermissionKey.PROJECT_VIEW,
                  PermissionKey.MODULE_EDIT,
                  PermissionKey.DEFECT_CREATE,
                  PermissionKey.DEFECT_ASSIGN,
                  PermissionKey.DEFECT_TRANSITION)));

      UUID rolesAdminUser = user("RolesAdmin", false);
      grantOrgWide(
          rolesAdminUser,
          PermissionKey.ADMIN_ROLES_MANAGE,
          PermissionKey.ADMIN_AUDIT_VIEW,
          PermissionKey.PROJECT_VIEW,
          PermissionKey.MODULE_EDIT,
          PermissionKey.DEFECT_CREATE,
          PermissionKey.DEFECT_ASSIGN,
          PermissionKey.DEFECT_TRANSITION);
      Actor rolesAdmin =
          new Actor(
              rolesAdminUser,
              TENANT,
              "Anand",
              "anand@azalio.io",
              false,
              projectId,
              Set.of(
                  PermissionKey.ADMIN_ROLES_MANAGE,
                  PermissionKey.ADMIN_AUDIT_VIEW,
                  PermissionKey.PROJECT_VIEW,
                  PermissionKey.MODULE_EDIT,
                  PermissionKey.DEFECT_CREATE,
                  PermissionKey.DEFECT_ASSIGN,
                  PermissionKey.DEFECT_TRANSITION),
              Set.of());

      useCases.setRolePermission(rolesAdmin, id, "admin.audit.view", true);

      assertEquals(6, access.role(TENANT, id).orElseThrow().permissions().size());
    }
  }

  /**
   * The escalation the review found: a project administrator holds the seeded admin role on
   * their project, which carries every key, so the per-project union says they hold
   * admin.users.manage. Every one of these used to succeed.
   */
  @Nested
  @DisplayName("a project administrator holding every key on their project")
  class ProjectScopedEscalation {

    private UUID projectAdminUser;
    private Actor fullProjectAdmin;

    @BeforeEach
    void projectAdminWithEverything() {
      projectAdminUser = user("Rahul", false);
      UUID everything = UUID.randomUUID();
      access.insertRole(
          new Tenancy.Role(
              everything, TENANT, "all", "All", "", "", false,
              java.util.EnumSet.allOf(PermissionKey.class)));
      access.insertMembership(
          new Tenancy.Membership(
              UUID.randomUUID(), TENANT, projectAdminUser, projectId, everything, Instant.now()));
      fullProjectAdmin =
          new Actor(
              projectAdminUser, TENANT, "Rahul", "rahul@azalio.io", false, projectId,
              java.util.EnumSet.allOf(PermissionKey.class), Set.of());
    }

    @Test
    @DisplayName("cannot make themselves organisation-wide admin")
    void cannotGrantThemselvesOrgWide() {
      assertThrows(
          ServiceException.class,
          () -> useCases.grantOrganisationWide(fullProjectAdmin, projectAdminUser, adminRoleId));
      assertFalse(
          access.memberships(TENANT).stream()
              .anyMatch(m -> m.userId().equals(projectAdminUser) && m.projectId() == null));
    }

    @Test
    @DisplayName("cannot remove somebody from the organisation")
    void cannotRemoveFromOrganisation() {
      UUID manu = user("Manu", false);
      assertThrows(
          ServiceException.class, () -> useCases.removeFromOrganisation(fullProjectAdmin, manu));
    }

    @Test
    @DisplayName("cannot reset anybody's password")
    void cannotResetPasswords() {
      assertThrows(
          ServiceException.class, () -> useCases.resetPassword(fullProjectAdmin, adminUserId));
    }

    @Test
    @DisplayName("cannot rewrite a role every project uses")
    void cannotEditRoles() {
      assertThrows(
          ServiceException.class,
          () -> useCases.setRolePermission(fullProjectAdmin, viewerRoleId, "fni.signoff", true));
    }

    @Test
    @DisplayName("cannot invite to every project, or to a project other than their own")
    void cannotInviteBeyondTheirProject() {
      assertThrows(
          ServiceException.class,
          () -> useCases.invite(fullProjectAdmin, "a@azalio.io", "A", viewerRoleId, true));
      assertThrows(
          ServiceException.class,
          () ->
              useCases.invite(
                  fullProjectAdmin, "b@azalio.io", "B", viewerRoleId, false, otherProjectId));
    }

    @Test
    @DisplayName("may still invite to the project they administer")
    void mayInviteToTheirOwnProject() {
      useCases.invite(fullProjectAdmin, "c@azalio.io", "C", viewerRoleId, false);
      assertTrue(
          access.memberships(TENANT).stream()
              .anyMatch(
                  m ->
                      projectId.equals(m.projectId())
                          && access.findUser(TENANT, m.userId())
                              .map(u -> u.email().equals("c@azalio.io"))
                              .orElse(false)));
    }
  }

  @Nested
  @DisplayName("password resets and removed accounts")
  class ResetsAndRemoval {

    @Test
    @DisplayName("an organisation admin cannot reset a super admin's password")
    void notASuperAdmin() {
      UUID platform = user("Paras", true);
      assertThrows(ServiceException.class, () -> useCases.resetPassword(admin(), platform));
    }

    @Test
    @DisplayName("nor the password of somebody holding more than they do")
    void notSomebodyMorePrivileged() {
      UUID boss = user("Boss", false);
      grantOrgWide(boss, PermissionKey.ADMIN_USERS_MANAGE, PermissionKey.ADMIN_ROLES_MANAGE);
      assertThrows(ServiceException.class, () -> useCases.resetPassword(admin(), boss));
    }

    @Test
    @DisplayName("but may reset somebody holding less")
    void mayResetSomebodyJunior() {
      UUID junior = user("Junior", false);
      membership(junior, projectId);
      assertNotNull(useCases.resetPassword(admin(), junior).resetUrl());
    }

    @Test
    @DisplayName("an invited account that is removed loses its outstanding link")
    void removalKillsTheInvitationLink() {
      AccessUseCases.Invited invited =
          useCases.invite(admin(), "late@azalio.io", "Late", viewerRoleId, false);
      String token = invited.acceptUrl().substring(invited.acceptUrl().indexOf("token=") + 6);
      UUID late = access.findByEmail("late@azalio.io").get(0).user().id();

      useCases.removeFromOrganisation(admin(), late);

      assertTrue(
          access.findByInviteTokenHash(new ScryptPasswordHasher().sha256(token)).isEmpty(),
          "a removed account's invitation link must not still work");
    }

    @Test
    @DisplayName("a removed account cannot be added back to a project without being restored")
    void addMemberRefusesARemovedAccount() {
      UUID manu = user("Manu", false);
      useCases.removeFromOrganisation(admin(), manu);
      assertThrows(ServiceException.class, () -> useCases.addMember(admin(), manu, viewerRoleId));
    }
  }
}
