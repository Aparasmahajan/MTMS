package io.mtms.application.usecase;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.mtms.application.Actor;
import io.mtms.application.ServiceException;
import io.mtms.application.port.StepData;
import io.mtms.domain.PermissionKey;
import io.mtms.domain.model.Modules;
import io.mtms.domain.model.Scope;
import io.mtms.domain.model.Steps;
import io.mtms.domain.model.Tenancy;
import io.mtms.infrastructure.persistence.memory.InMemoryAccessRepository;
import io.mtms.infrastructure.persistence.memory.InMemoryDatabase;
import io.mtms.infrastructure.persistence.memory.InMemoryDiscussionRepository;
import io.mtms.infrastructure.persistence.memory.InMemoryNotificationRepository;
import io.mtms.infrastructure.persistence.memory.InMemoryOwnerRepository;
import io.mtms.infrastructure.persistence.memory.InMemoryProjectRepository;
import io.mtms.infrastructure.persistence.memory.InMemoryStepRepository;
import io.mtms.infrastructure.persistence.memory.InMemorySubModuleRepository;
import io.mtms.infrastructure.persistence.memory.InMemorySupportRepositories;
import io.mtms.domain.model.Projects;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

/**
 * The checklist, driven through the use case the controller calls.
 *
 * <p>Written because the gate is only half the feature. {@code StepGateTest} pins the rules as
 * functions; this pins what actually happens when somebody clicks — which refusal they get,
 * whether the event is written, and whether an override is recorded as one rather than passing
 * itself off as an ordinary tick. That last one is the whole difference between an audit trail
 * and a decoration, and it cannot be tested from the pure functions.
 */
@DisplayName("ticking a step")
class StepUseCasesTest {

  private static final UUID TENANT = UUID.randomUUID();

  private InMemoryDatabase db;
  private InMemoryStepRepository steps;
  private InMemorySubModuleRepository subModules;
  private InMemoryAccessRepository access;
  private StepUseCases useCases;

  private UUID projectId;
  private UUID subModuleId;
  private UUID qaRole;
  private UUID devRole;

  @BeforeEach
  void setUp() {
    db = new InMemoryDatabase();
    steps = new InMemoryStepRepository(db);
    subModules = new InMemorySubModuleRepository(db);
    access = new InMemoryAccessRepository(db);

    InMemoryProjectRepository projects =
        new InMemoryProjectRepository(
            db, steps, new InMemoryOwnerRepository(db), new InMemoryDiscussionRepository(db));
    InMemoryOwnerRepository ownerRows = new InMemoryOwnerRepository(db);
    NotificationUseCases notifier =
        new NotificationUseCases(
            new InMemoryNotificationRepository(db),
            access,
            // The default transport: writes a log line and reports that nothing was sent, which
            // is what every deployment without a webhook does.
            new io.mtms.infrastructure.notify.LoggingNotifier());

    useCases =
        new StepUseCases(
            steps,
            subModules,
            access,
            ownerRows,
            notifier,
            new MutationSupport(
                new InMemorySupportRepositories.AuditEntries(db),
                new InMemorySupportRepositories.Outbox(db),
                projects));

    projectId = UUID.randomUUID();
    projects.insert(
        new Projects.Project(projectId, TENANT, "CR_AUTOMATION", "CR", "", true, false, Instant.now()));

    subModuleId = UUID.randomUUID();
    subModules.insert(
        new Modules.SubModule(
            subModuleId, projectId, "SBC", "5_SIP_FILTER", null, null, null, null, null, Instant.now()));

    qaRole = role("qa", "QA");
    devRole = role("dev", "Developer");
  }

  private UUID role(String key, String name) {
    UUID id = UUID.randomUUID();
    access.insertRole(
        new Tenancy.Role(id, TENANT, key, name, "", "", true, Set.of(PermissionKey.PROJECT_VIEW)));
    return id;
  }

  /** A person holding one role in this project, with the permissions given. */
  private Actor person(String name, UUID roleId, PermissionKey... permissions) {
    UUID userId = UUID.randomUUID();
    access.insertUser(
        new Tenancy.UserWithSecret(
            new Tenancy.User(
                userId, TENANT, name.toLowerCase() + "@azalio.io", name, false,
                Tenancy.UserStatus.ACTIVE, null, Instant.now()),
            "hash", null, null));
    access.insertMembership(
        new Tenancy.Membership(UUID.randomUUID(), TENANT, userId, projectId, roleId, Instant.now()));

    return new Actor(
        userId, TENANT, name, name.toLowerCase() + "@azalio.io", false, projectId,
        Set.of(permissions), Set.of());
  }

  private Actor admin() {
    return person("Anand", devRole, PermissionKey.PROJECT_VIEW, PermissionKey.PROJECT_CONFIG);
  }

  /** A checklist of the given steps, each gated to QA, attached to the sub-module. */
  private List<UUID> checklist(boolean enforceOrder, String... names) {
    Actor anand = admin();
    List<UUID> definitions =
        java.util.Arrays.stream(names)
            .map(name -> useCases.createDefinition(anand, name, "", List.of(qaRole)))
            .toList();

    useCases.createList(
        anand, Scope.SUB_MODULE, subModuleId, "config1", enforceOrder, definitions);
    return entryIds();
  }

  private List<UUID> entryIds() {
    StepData data = steps.load(projectId);
    return data.resolve(Scope.SUB_MODULE, subModuleId).get(0).entries().stream()
        .map(entry -> entry.entry().id())
        .toList();
  }

  private Steps.State stateOf(UUID entryId) {
    return steps.progressOf(entryId).map(Steps.Progress::state).orElse(Steps.State.TODO);
  }

  @Nested
  @DisplayName("who may tick")
  class Gating {

    @Test
    @DisplayName("the named role ticks it, and the event is written")
    void namedRoleTicks() {
      List<UUID> entries = checklist(false, "Testing done");
      Actor vinayak = person("Vinayak", qaRole, PermissionKey.PROJECT_VIEW);

      useCases.setState(vinayak, entries.get(0), Steps.State.DONE, null);

      assertEquals(Steps.State.DONE, stateOf(entries.get(0)));
      List<Steps.Event> events = steps.load(projectId).eventsOf(entries.get(0));
      assertEquals(1, events.size());
      assertEquals("Vinayak", events.get(0).byName());
      assertTrue(!events.get(0).isOverride());
    }

    @Test
    @DisplayName("somebody else is refused, and told which role it is")
    void otherRoleRefused() {
      List<UUID> entries = checklist(false, "Testing done");
      Actor bhavnish = person("Bhavnish", devRole, PermissionKey.PROJECT_VIEW);

      ServiceException refused =
          assertThrows(
              ServiceException.class,
              () -> useCases.setState(bhavnish, entries.get(0), Steps.State.DONE, null));

      assertEquals(ServiceException.Code.FORBIDDEN, refused.code());
      assertTrue(refused.getMessage().contains("QA"), refused.getMessage());
      assertEquals(Steps.State.TODO, stateOf(entries.get(0)));
    }

    @Test
    @DisplayName("an admin may tick anything, and it is recorded as an override on their behalf")
    void adminOverrideIsRecordedAsOne() {
      // The case this whole flag exists for: QA is unavailable and the release is going out.
      // The tick has to be possible and it must not read as QA having checked it.
      List<UUID> entries = checklist(false, "Testing done");
      Actor anand = admin();

      useCases.setState(anand, entries.get(0), Steps.State.DONE, "QA are on leave, I verified it");

      Steps.Event event = steps.load(projectId).eventsOf(entries.get(0)).get(0);
      assertTrue(event.isOverride());
      assertEquals("Anand", event.byName());
      assertEquals("QA are on leave, I verified it", event.reason());
    }
  }

  @Nested
  @DisplayName("order")
  class Order {

    @Test
    @DisplayName("a strict list refuses step 2 until step 1 is done, and names step 1")
    void refusesOutOfTurn() {
      List<UUID> entries = checklist(true, "Received CIQ", "Testing done");
      Actor vinayak = person("Vinayak", qaRole, PermissionKey.PROJECT_VIEW);

      ServiceException refused =
          assertThrows(
              ServiceException.class,
              () -> useCases.setState(vinayak, entries.get(1), Steps.State.DONE, null));

      assertTrue(refused.getMessage().contains("Received CIQ"), refused.getMessage());
    }

    @Test
    @DisplayName("and allows it once step 1 is done")
    void allowsInTurn() {
      List<UUID> entries = checklist(true, "Received CIQ", "Testing done");
      Actor vinayak = person("Vinayak", qaRole, PermissionKey.PROJECT_VIEW);

      useCases.setState(vinayak, entries.get(0), Steps.State.DONE, null);
      useCases.setState(vinayak, entries.get(1), Steps.State.DONE, null);

      assertEquals(Steps.State.DONE, stateOf(entries.get(1)));
    }

    @Test
    @DisplayName("un-ticking is never held up by the order")
    void unTickingIsNotOrdered() {
      // A sequence is a claim about the order work is done in, not a reason to stop somebody
      // recording that something they marked done is not, in fact, done.
      List<UUID> entries = checklist(true, "Received CIQ", "Testing done");
      Actor vinayak = person("Vinayak", qaRole, PermissionKey.PROJECT_VIEW);

      useCases.setState(vinayak, entries.get(0), Steps.State.DONE, null);
      useCases.setState(vinayak, entries.get(1), Steps.State.DONE, null);
      useCases.setState(vinayak, entries.get(0), Steps.State.TODO, null);

      assertEquals(Steps.State.TODO, stateOf(entries.get(0)));
      // Step 2 stays done. It was done; an earlier step being reopened does not un-happen it.
      assertEquals(Steps.State.DONE, stateOf(entries.get(1)));
    }
  }

  @Nested
  @DisplayName("blocking")
  class Blocking {

    @Test
    @DisplayName("a block without a reason is refused")
    void reasonRequired() {
      List<UUID> entries = checklist(false, "Prod load");
      Actor vinayak = person("Vinayak", qaRole, PermissionKey.PROJECT_VIEW);

      assertThrows(
          ServiceException.class,
          () -> useCases.setState(vinayak, entries.get(0), Steps.State.BLOCKED, "  "));
      assertEquals(Steps.State.TODO, stateOf(entries.get(0)));
    }

    @Test
    @DisplayName("a block with one is kept, and the reason goes into the change feed")
    void reasonIsKept() {
      List<UUID> entries = checklist(false, "Prod load");
      Actor vinayak = person("Vinayak", qaRole, PermissionKey.PROJECT_VIEW);

      useCases.setState(vinayak, entries.get(0), Steps.State.BLOCKED, "no lab slot until Tuesday");

      assertEquals("no lab slot until Tuesday", steps.progressOf(entries.get(0)).orElseThrow().blockedReason());
      assertTrue(
          db.audit.stream().anyMatch(entry -> entry.what().contains("no lab slot until Tuesday")),
          "the reason should reach the change feed, not just the step");
    }
  }

  @Nested
  @DisplayName("configuration")
  class Configuration {

    @Test
    @DisplayName("the same step is first in one checklist and third in another")
    void orderIsPerList() {
      Actor anand = admin();
      UUID ciq = useCases.createDefinition(anand, "Received CIQ", "", List.of(qaRole));
      UUID test = useCases.createDefinition(anand, "Testing done", "", List.of(qaRole));
      UUID prod = useCases.createDefinition(anand, "Loaded in prod", "", List.of(qaRole));

      UUID other = UUID.randomUUID();
      subModules.insert(
          new Modules.SubModule(
              other, projectId, "SBC", "147_OTHER", null, null, null, null, null, Instant.now()));

      useCases.createList(anand, Scope.SUB_MODULE, subModuleId, "a", true, List.of(ciq, test, prod));
      useCases.createList(anand, Scope.SUB_MODULE, other, "b", true, List.of(prod, test, ciq));

      StepData data = steps.load(projectId);
      assertEquals(
          "Received CIQ",
          data.resolve(Scope.SUB_MODULE, subModuleId).get(0).entries().get(0).definition().name());
      assertEquals(
          "Received CIQ",
          data.resolve(Scope.SUB_MODULE, other).get(0).entries().get(2).definition().name());
    }

    @Test
    @DisplayName("retiring a step hides it from the checklist and keeps its history")
    void retiringKeepsHistory() {
      List<UUID> entries = checklist(false, "Old step");
      Actor vinayak = person("Vinayak", qaRole, PermissionKey.PROJECT_VIEW);
      useCases.setState(vinayak, entries.get(0), Steps.State.DONE, null);

      UUID definition = steps.load(projectId).definitions().get(0).id();
      useCases.archiveDefinition(admin(), definition);

      StepData data = steps.load(projectId);
      assertTrue(data.resolve(Scope.SUB_MODULE, subModuleId).get(0).entries().isEmpty());
      assertEquals(1, data.eventsOf(entries.get(0)).size());
    }

    @Test
    @DisplayName("taking a ticked step off a checklist is refused, because it would destroy the record")
    void cannotRemoveATickedEntry() {
      List<UUID> entries = checklist(false, "Testing done");
      Actor vinayak = person("Vinayak", qaRole, PermissionKey.PROJECT_VIEW);
      useCases.setState(vinayak, entries.get(0), Steps.State.DONE, null);

      ServiceException refused =
          assertThrows(ServiceException.class, () -> useCases.removeEntry(admin(), entries.get(0)));

      assertTrue(refused.getMessage().contains("Retire the step"), refused.getMessage());
      assertEquals(Steps.State.DONE, stateOf(entries.get(0)));
    }

    @Test
    @DisplayName("an untouched step can be taken off")
    void canRemoveAnUntouchedEntry() {
      List<UUID> entries = checklist(false, "Not started");

      useCases.removeEntry(admin(), entries.get(0));

      assertTrue(steps.load(projectId).entries().isEmpty());
    }

    @Test
    @DisplayName("building the library needs the configure permission")
    void buildingIsAdminOnly() {
      Actor vinayak = person("Vinayak", qaRole, PermissionKey.PROJECT_VIEW);

      assertThrows(
          ServiceException.class,
          () -> useCases.createDefinition(vinayak, "Testing done", "", List.of(qaRole)));
    }
  }

  @Nested
  @DisplayName("comments")
  class Comments {

    @Test
    @DisplayName("anyone on the project may comment, including somebody who cannot tick")
    void commentingIsNotGated() {
      List<UUID> entries = checklist(false, "Testing done");
      Actor dhruv = person("Dhruv", devRole, PermissionKey.PROJECT_VIEW);

      useCases.comment(dhruv, entries.get(0), "The vendor said Thursday.");

      List<Steps.Comment> comments = steps.load(projectId).commentsOf(entries.get(0));
      assertEquals(1, comments.size());
      assertEquals("Dhruv", comments.get(0).authorName());
    }

    @Test
    @DisplayName("somebody else's comment cannot be removed by an ordinary member")
    void onlyAuthorOrAdminRemoves() {
      List<UUID> entries = checklist(false, "Testing done");
      Actor dhruv = person("Dhruv", devRole, PermissionKey.PROJECT_VIEW);
      useCases.comment(dhruv, entries.get(0), "The vendor said Thursday.");
      UUID commentId = steps.load(projectId).commentsOf(entries.get(0)).get(0).id();

      Actor bhavnish = person("Bhavnish", devRole, PermissionKey.PROJECT_VIEW);
      assertThrows(ServiceException.class, () -> useCases.archiveComment(bhavnish, commentId));

      useCases.archiveComment(dhruv, commentId);
      assertTrue(steps.load(projectId).commentsOf(entries.get(0)).isEmpty());
    }
  }
}
