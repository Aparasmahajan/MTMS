package io.mtms.application.usecase;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.mtms.MtmsProperties;
import io.mtms.application.Actor;
import io.mtms.application.ServiceException;
import io.mtms.domain.PermissionKey;
import io.mtms.domain.model.Modules;
import io.mtms.domain.model.Owners;
import io.mtms.domain.model.Projects;
import io.mtms.domain.model.Scope;
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
import io.mtms.infrastructure.persistence.memory.InMemorySubModuleRepository;
import io.mtms.infrastructure.persistence.memory.InMemorySupportRepositories;
import io.mtms.infrastructure.security.ScryptPasswordHasher;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

/**
 * Roles a project can shape, and the owners that read from them.
 *
 * <p>Built together because they are one feature seen from two screens: the teams a project has
 * <em>are</em> its roles, and there is deliberately no second list to keep in step. What that
 * buys is tested here — hiding the QA role removes the QA owner row — and what it costs is
 * tested here too, because a role somebody still holds cannot simply vanish.
 */
@DisplayName("roles and owners")
class RolesAndOwnersTest {

  private static final UUID TENANT = UUID.randomUUID();

  private InMemoryDatabase db;
  private InMemoryAccessRepository access;
  private InMemoryOwnerRepository ownerRows;
  private InMemorySubModuleRepository subModules;
  private AccessUseCases roles;
  private OwnerUseCases owners;

  private UUID projectId;
  private UUID subModuleId;
  private UUID adminRoleId;
  private UUID qaRoleId;

  @BeforeEach
  void setUp() {
    db = new InMemoryDatabase();
    access = new InMemoryAccessRepository(db);
    ownerRows = new InMemoryOwnerRepository(db);
    subModules = new InMemorySubModuleRepository(db);

    InMemoryProjectRepository projects =
        new InMemoryProjectRepository(
            db,
            new InMemoryStepRepository(db),
            ownerRows,
            new InMemoryDiscussionRepository(db));

    MutationSupport support =
        new MutationSupport(
            new InMemorySupportRepositories.AuditEntries(db),
            new InMemorySupportRepositories.Outbox(db),
            projects);

    roles =
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
    owners = new OwnerUseCases(ownerRows, subModules, access, support);

    projectId = UUID.randomUUID();
    projects.insert(
        new Projects.Project(projectId, TENANT, "CR_AUTOMATION", "CR", "", true, false, Instant.now()));

    subModuleId = UUID.randomUUID();
    subModules.insert(
        new Modules.SubModule(
            subModuleId, projectId, "SBC", "5_SIP_FILTER", null, null, null, null, null, Instant.now()));

    adminRoleId = role("admin", "Admin");
    qaRoleId = role("qa", "QA");
  }

  private UUID role(String key, String name) {
    UUID id = UUID.randomUUID();
    access.insertRole(
        new Tenancy.Role(id, TENANT, key, name, "", "", true, Set.of(PermissionKey.PROJECT_VIEW)));
    return id;
  }

  private UUID user(String name) {
    UUID id = UUID.randomUUID();
    access.insertUser(
        new Tenancy.UserWithSecret(
            new Tenancy.User(
                id, TENANT, name.toLowerCase() + "@azalio.io", name, false,
                Tenancy.UserStatus.ACTIVE, null, Instant.now()),
            "hash", null, null));
    return id;
  }

  private Actor admin() {
    return new Actor(
        user("Anand"), TENANT, "Anand", "anand@azalio.io", false, projectId,
        Set.of(
            PermissionKey.PROJECT_VIEW,
            PermissionKey.PROJECT_CONFIG,
            PermissionKey.MODULE_EDIT,
            PermissionKey.ADMIN_ROLES_MANAGE),
        Set.of());
  }

  private Tenancy.Role roleById(UUID id) {
    return access.role(TENANT, id).orElseThrow();
  }

  @Nested
  @DisplayName("adding a role")
  class Adding {

    @Test
    @DisplayName("it arrives with no permissions, rather than inheriting its creator's")
    void startsWithNothing() {
      // The alternative is somebody granting more than they meant to by clicking "add".
      UUID id = roles.createRole(admin(), "Field Engineer", "hardware");

      assertTrue(roleById(id).permissions().isEmpty());
      assertFalse(roleById(id).isSystem());
      assertEquals("field-engineer", roleById(id).key());
    }

    @Test
    @DisplayName("a name that collides is refused rather than keyed something else")
    void refusesACollision() {
      roles.createRole(admin(), "Field Engineer", "");

      assertThrows(
          ServiceException.class, () -> roles.createRole(admin(), "field engineer", ""));
    }

    @Test
    @DisplayName("a name that would key as admin is refused, because code looks that one up")
    void refusesAReservedKey() {
      // The platform console grants "admin" by key when it assigns an administrator. A second
      // role keyed admin makes that lookup ambiguous in a way nothing would report.
      assertThrows(ServiceException.class, () -> roles.createRole(admin(), "Admin", ""));
    }

    @Test
    @DisplayName("a name with nothing to key it by is refused")
    void refusesAnEmptyKey() {
      assertThrows(ServiceException.class, () -> roles.createRole(admin(), "!!!", ""));
    }
  }

  @Nested
  @DisplayName("hiding a role")
  class Hiding {

    @Test
    @DisplayName("an unused role hides, and comes back")
    void hideAndShow() {
      roles.setRoleHidden(admin(), qaRoleId, true);
      assertTrue(roleById(qaRoleId).isHidden());

      roles.setRoleHidden(admin(), qaRoleId, false);
      assertFalse(roleById(qaRoleId).isHidden());
    }

    @Test
    @DisplayName("the admin role cannot be hidden")
    void adminCannotBeHidden() {
      // It is the role the platform console grants. Hiding it would make the organisation
      // unadministrable from outside itself.
      ServiceException refused =
          assertThrows(ServiceException.class, () -> roles.setRoleHidden(admin(), adminRoleId, true));

      assertTrue(refused.getMessage().contains("admin role"), refused.getMessage());
    }

    @Test
    @DisplayName("a role somebody still holds cannot be hidden, and the refusal counts them")
    void heldRoleCannotBeHidden() {
      UUID vinayak = user("Vinayak");
      access.insertMembership(
          new Tenancy.Membership(
              UUID.randomUUID(), TENANT, vinayak, projectId, qaRoleId, Instant.now()));

      ServiceException refused =
          assertThrows(ServiceException.class, () -> roles.setRoleHidden(admin(), qaRoleId, true));

      assertTrue(refused.getMessage().startsWith("1 person still holds QA"), refused.getMessage());
      assertFalse(roleById(qaRoleId).isHidden());
    }

    @Test
    @DisplayName("hiding one never touches what was recorded against it")
    void hidingKeepsTheRecord() {
      UUID vinayak = user("Vinayak");
      owners.assign(admin(), Scope.SUB_MODULE, subModuleId, qaRoleId, vinayak);

      roles.setRoleHidden(admin(), qaRoleId, true);

      // The owner row stands. Hiding a role stops it being offered; it does not decide that the
      // work was never owned.
      List<Owners.Owner> rows = ownerRows.findByScope(projectId, Scope.SUB_MODULE, subModuleId);
      assertEquals(1, rows.size());
      assertEquals(qaRoleId, rows.get(0).roleId());
    }
  }

  @Nested
  @DisplayName("owners")
  class OwnerRows {

    @Test
    @DisplayName("one overall owner, plus one per team, on the same thing")
    void overallAndPerTeam() {
      UUID paras = user("Paras");
      UUID vinayak = user("Vinayak");

      owners.assign(admin(), Scope.SUB_MODULE, subModuleId, null, paras);
      owners.assign(admin(), Scope.SUB_MODULE, subModuleId, qaRoleId, vinayak);

      List<Owners.Owner> rows = ownerRows.findByScope(projectId, Scope.SUB_MODULE, subModuleId);
      assertEquals(2, rows.size());
      assertEquals(1, rows.stream().filter(Owners.Owner::isOverall).count());
    }

    @Test
    @DisplayName("several people can own one thing for one team")
    void severalPerTeam() {
      owners.assign(admin(), Scope.SUB_MODULE, subModuleId, qaRoleId, user("Vinayak"));
      owners.assign(admin(), Scope.SUB_MODULE, subModuleId, qaRoleId, user("Muskan"));

      assertEquals(2, ownerRows.findByScope(projectId, Scope.SUB_MODULE, subModuleId).size());
    }

    @Test
    @DisplayName("assigning the same person twice is one row, not two")
    void idempotent() {
      UUID vinayak = user("Vinayak");
      owners.assign(admin(), Scope.SUB_MODULE, subModuleId, qaRoleId, vinayak);
      owners.assign(admin(), Scope.SUB_MODULE, subModuleId, qaRoleId, vinayak);

      assertEquals(1, ownerRows.findByScope(projectId, Scope.SUB_MODULE, subModuleId).size());
    }

    @Test
    @DisplayName("levels do not inherit — a sub-module's owners are its own")
    void levelsAreIndependent() {
      UUID moduleId = UUID.randomUUID();
      owners.assign(admin(), Scope.MODULE, moduleId, null, user("Paras"));

      assertTrue(ownerRows.findByScope(projectId, Scope.SUB_MODULE, subModuleId).isEmpty());
      assertEquals(1, ownerRows.findByScope(projectId, Scope.MODULE, moduleId).size());
    }

    @Test
    @DisplayName("a hidden role is not a team anything can be owned for")
    void cannotOwnForAHiddenTeam() {
      roles.setRoleHidden(admin(), qaRoleId, true);
      UUID vinayak = user("Vinayak");

      ServiceException refused =
          assertThrows(
              ServiceException.class,
              () -> owners.assign(admin(), Scope.SUB_MODULE, subModuleId, qaRoleId, vinayak));

      assertTrue(refused.getMessage().contains("hidden"), refused.getMessage());
    }

    @Test
    @DisplayName("an owner has to be a real account in this organisation")
    void mustBeARealAccount() {
      // The whole reason owners stopped being typed-in names: nothing can be sent to a name.
      assertThrows(
          ServiceException.class,
          () -> owners.assign(admin(), Scope.SUB_MODULE, subModuleId, null, UUID.randomUUID()));
    }

    @Test
    @DisplayName("removing one takes the row and nothing else")
    void unassign() {
      UUID vinayak = user("Vinayak");
      UUID ownerId = owners.assign(admin(), Scope.SUB_MODULE, subModuleId, qaRoleId, vinayak);

      owners.unassign(admin(), ownerId);

      assertTrue(ownerRows.findByScope(projectId, Scope.SUB_MODULE, subModuleId).isEmpty());
      assertTrue(access.findUser(TENANT, vinayak).isPresent(), "the account is untouched");
    }
  }
}
