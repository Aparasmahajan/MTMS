package io.mtms.application.usecase;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.mtms.application.Actor;
import io.mtms.application.port.Notifier;
import io.mtms.domain.PermissionKey;
import io.mtms.domain.model.Modules;
import io.mtms.domain.model.Notifications;
import io.mtms.domain.model.Projects;
import io.mtms.domain.model.Scope;
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
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

/**
 * Who gets told, and who deliberately does not.
 *
 * <p>The tests that matter here are the negative ones. A notification system is judged by what
 * it does not send: told too much, people mute it on day three and the channel is gone
 * permanently, and the one message that mattered goes with it.
 */
@DisplayName("notifications")
class NotificationsTest {

  private static final UUID TENANT = UUID.randomUUID();

  /** Records what a transport was asked to send, so "was it attempted" is answerable. */
  private static final class RecordingNotifier implements Notifier {
    final List<String> sent = new ArrayList<>();
    boolean accept = false;

    @Override
    public boolean deliver(Notifications.Notification notification, String recipientEmail) {
      sent.add(notification.kind().wire() + " -> " + recipientEmail);
      return accept;
    }
  }

  private InMemoryDatabase db;
  private InMemoryAccessRepository access;
  private InMemoryNotificationRepository inbox;
  private InMemoryOwnerRepository ownerRows;
  private InMemorySubModuleRepository subModules;
  private InMemoryStepRepository steps;
  private RecordingNotifier notifier;
  private NotificationUseCases notifications;
  private StepUseCases stepUseCases;
  private DiscussionUseCases discussionUseCases;

  private UUID projectId;
  private UUID subModuleId;
  private UUID qaRoleId;

  @BeforeEach
  void setUp() {
    db = new InMemoryDatabase();
    access = new InMemoryAccessRepository(db);
    inbox = new InMemoryNotificationRepository(db);
    ownerRows = new InMemoryOwnerRepository(db);
    subModules = new InMemorySubModuleRepository(db);
    steps = new InMemoryStepRepository(db);
    notifier = new RecordingNotifier();

    InMemoryDiscussionRepository discussions = new InMemoryDiscussionRepository(db);
    InMemoryProjectRepository projects =
        new InMemoryProjectRepository(db, steps, ownerRows, discussions);
    MutationSupport support =
        new MutationSupport(
            new InMemorySupportRepositories.AuditEntries(db),
            new InMemorySupportRepositories.Outbox(db),
            projects);

    notifications = new NotificationUseCases(inbox, access, notifier);
    stepUseCases =
        new StepUseCases(steps, projects, subModules, access, ownerRows, notifications, support);
    discussionUseCases =
        new DiscussionUseCases(discussions, subModules, access, notifications, support);

    projectId = UUID.randomUUID();
    projects.insert(
        new Projects.Project(projectId, TENANT, "CR_AUTOMATION", "CR", "", true, false, Instant.now()));

    subModuleId = UUID.randomUUID();
    subModules.insert(
        new Modules.SubModule(
            subModuleId, projectId, "SBC", "5_SIP_FILTER", null, null, null, null, null, Instant.now()));

    qaRoleId = UUID.randomUUID();
    access.insertRole(
        new Tenancy.Role(qaRoleId, TENANT, "qa", "QA", "", "", true, Set.of(PermissionKey.PROJECT_VIEW)));
  }

  private UUID user(String name, Tenancy.UserStatus status) {
    UUID id = UUID.randomUUID();
    access.insertUser(
        new Tenancy.UserWithSecret(
            new Tenancy.User(
                id, TENANT, name.toLowerCase() + "@azalio.io", name, false, status, null, Instant.now()),
            "hash", null, null));
    return id;
  }

  private Actor actorFor(UUID userId, String name, PermissionKey... permissions) {
    return new Actor(
        userId, TENANT, name, name.toLowerCase() + "@azalio.io", false, projectId,
        Set.of(permissions), Set.of());
  }

  private Actor admin() {
    return actorFor(
        user("Anand", Tenancy.UserStatus.ACTIVE),
        "Anand",
        PermissionKey.PROJECT_VIEW,
        PermissionKey.PROJECT_CONFIG,
        PermissionKey.MODULE_EDIT);
  }

  @Nested
  @DisplayName("who is left out")
  class LeftOut {

    @Test
    @DisplayName("never the person who caused it")
    void neverTheActor() {
      // Being told about something you just did is the fastest way to teach somebody to
      // ignore the badge.
      Actor anand = admin();

      notifications.notify(
          anand, List.of(anand.userId()), Notifications.Kind.MENTION, "You did a thing", "", "/");

      assertEquals(0, notifications.unread(anand));
      assertTrue(notifier.sent.isEmpty());
    }

    @Test
    @DisplayName("never a deactivated account")
    void neverDeactivated() {
      Actor anand = admin();
      UUID leaver = user("Leaver", Tenancy.UserStatus.DEACTIVATED);

      notifications.notify(anand, List.of(leaver), Notifications.Kind.MENTION, "Hello", "", "/");

      assertTrue(inbox.inbox(TENANT, leaver, 10).isEmpty());
      assertTrue(notifier.sent.isEmpty());
    }

    @Test
    @DisplayName("the same person named twice gets one notification")
    void deduplicated() {
      Actor anand = admin();
      UUID vinayak = user("Vinayak", Tenancy.UserStatus.ACTIVE);

      notifications.notify(
          anand, List.of(vinayak, vinayak), Notifications.Kind.MENTION, "Hello", "", "/");

      assertEquals(1, inbox.inbox(TENANT, vinayak, 10).size());
    }
  }

  @Nested
  @DisplayName("delivery")
  class Delivery {

    @Test
    @DisplayName("the inbox is written whether or not a transport accepts it")
    void inboxIsIndependentOfTransport() {
      // The reason a webhook outage is not an outage: every notification is in the inbox
      // before anything is attempted.
      Actor anand = admin();
      UUID vinayak = user("Vinayak", Tenancy.UserStatus.ACTIVE);
      notifier.accept = false;

      notifications.notify(anand, List.of(vinayak), Notifications.Kind.MENTION, "Hello", "", "/");

      List<Notifications.Notification> theirs = inbox.inbox(TENANT, vinayak, 10);
      assertEquals(1, theirs.size());
      assertTrue(theirs.get(0).isUnread());
      // Not marked delivered, which is the honest record: nothing sent it anywhere.
      assertEquals(null, theirs.get(0).deliveredAt());
      assertEquals(1, notifier.sent.size(), "it was still attempted");
    }

    @Test
    @DisplayName("a transport that accepts it marks the row delivered")
    void acceptedIsRecorded() {
      Actor anand = admin();
      UUID vinayak = user("Vinayak", Tenancy.UserStatus.ACTIVE);
      notifier.accept = true;

      notifications.notify(anand, List.of(vinayak), Notifications.Kind.MENTION, "Hello", "", "/");

      assertFalse(inbox.inbox(TENANT, vinayak, 10).get(0).deliveredAt() == null);
    }

    @Test
    @DisplayName("reading one clears it, and the count follows")
    void markRead() {
      Actor anand = admin();
      UUID vinayakId = user("Vinayak", Tenancy.UserStatus.ACTIVE);
      Actor vinayak = actorFor(vinayakId, "Vinayak", PermissionKey.PROJECT_VIEW);

      notifications.notify(anand, List.of(vinayakId), Notifications.Kind.MENTION, "Hello", "", "/");
      assertEquals(1, notifications.unread(vinayak));

      notifications.markRead(vinayak, inbox.inbox(TENANT, vinayakId, 10).get(0).id());
      assertEquals(0, notifications.unread(vinayak));
    }

    @Test
    @DisplayName("somebody else cannot mark your notification read")
    void cannotReadAnothersInbox() {
      Actor anand = admin();
      UUID vinayakId = user("Vinayak", Tenancy.UserStatus.ACTIVE);
      Actor bhavnish =
          actorFor(user("Bhavnish", Tenancy.UserStatus.ACTIVE), "Bhavnish", PermissionKey.PROJECT_VIEW);

      notifications.notify(anand, List.of(vinayakId), Notifications.Kind.MENTION, "Hello", "", "/");
      UUID id = inbox.inbox(TENANT, vinayakId, 10).get(0).id();

      // No exception: the user is in the WHERE clause, so it simply matches nothing. A refusal
      // would confirm the id exists.
      notifications.markRead(bhavnish, id);

      assertTrue(inbox.inbox(TENANT, vinayakId, 10).get(0).isUnread());
    }
  }

  @Nested
  @DisplayName("the events that produce one")
  class Producers {

    /** A checklist of two steps gated to QA, in a strict order, on the sub-module. */
    private List<UUID> orderedChecklist(Actor admin) {
      UUID first = stepUseCases.createDefinition(admin, "Received CIQ", "", List.of(qaRoleId));
      UUID second = stepUseCases.createDefinition(admin, "Testing done", "", List.of(qaRoleId));
      stepUseCases.createList(
          admin, Scope.SUB_MODULE, subModuleId, "config1", true, List.of(first, second));

      return steps.load(projectId).resolve(Scope.SUB_MODULE, subModuleId).get(0).entries().stream()
          .map(entry -> entry.entry().id())
          .toList();
    }

    @Test
    @DisplayName("an @mention tells the person named")
    void mentionNotifies() {
      Actor anand = admin();
      UUID vinayak = user("Vinayak", Tenancy.UserStatus.ACTIVE);

      UUID thread =
          discussionUseCases.openThread(
              anand, Scope.SUB_MODULE, subModuleId, "Vendor", "@Vinayak can you chase them?");

      List<Notifications.Notification> theirs = inbox.inbox(TENANT, vinayak, 10);
      assertEquals(1, theirs.size());
      assertEquals(Notifications.Kind.MENTION, theirs.get(0).kind());
      assertTrue(theirs.get(0).title().contains("Anand"), theirs.get(0).title());
      // The link goes to the thing, not to a list of everything.
      assertEquals("/sub-modules/" + subModuleId, theirs.get(0).link());
      assertTrue(thread != null);
    }

    @Test
    @DisplayName("blocking a step tells its owners, with the reason")
    void blockNotifiesOwners() {
      Actor anand = admin();
      UUID paras = user("Paras", Tenancy.UserStatus.ACTIVE);
      ownerRows.insert(
          new io.mtms.domain.model.Owners.Owner(
              UUID.randomUUID(), projectId, Scope.SUB_MODULE, subModuleId, null, paras, Instant.now()));

      List<UUID> entries = orderedChecklist(anand);
      stepUseCases.setState(anand, entries.get(0), io.mtms.domain.model.Steps.State.BLOCKED,
          "no lab slot until Tuesday");

      List<Notifications.Notification> theirs = inbox.inbox(TENANT, paras, 10);
      assertEquals(1, theirs.size());
      assertEquals(Notifications.Kind.STEP_BLOCKED, theirs.get(0).kind());
      assertEquals("no lab slot until Tuesday", theirs.get(0).body());
    }

    @Test
    @DisplayName("finishing step 1 tells whoever can tick step 2 — the reason this exists")
    void unblockingNotifiesTheNextRole() {
      // A strict order blocks the owner of step 2 until step 1 is ticked, and nothing else in
      // the application would ever tell them it was.
      Actor anand = admin();
      UUID vinayak = user("Vinayak", Tenancy.UserStatus.ACTIVE);
      access.insertMembership(
          new Tenancy.Membership(
              UUID.randomUUID(), TENANT, vinayak, projectId, qaRoleId, Instant.now()));

      List<UUID> entries = orderedChecklist(anand);
      stepUseCases.setState(anand, entries.get(0), io.mtms.domain.model.Steps.State.DONE, "done");

      List<Notifications.Notification> theirs = inbox.inbox(TENANT, vinayak, 10);
      assertEquals(1, theirs.size());
      assertEquals(Notifications.Kind.STEP_READY, theirs.get(0).kind());
      assertTrue(theirs.get(0).title().startsWith("Testing done"), theirs.get(0).title());
    }

    @Test
    @DisplayName("an unordered checklist tells nobody — there was nothing to be waiting for")
    void unorderedListDoesNotNotify() {
      Actor anand = admin();
      UUID vinayak = user("Vinayak", Tenancy.UserStatus.ACTIVE);
      access.insertMembership(
          new Tenancy.Membership(
              UUID.randomUUID(), TENANT, vinayak, projectId, qaRoleId, Instant.now()));

      UUID first = stepUseCases.createDefinition(anand, "One", "", List.of(qaRoleId));
      UUID second = stepUseCases.createDefinition(anand, "Two", "", List.of(qaRoleId));
      stepUseCases.createList(
          anand, Scope.SUB_MODULE, subModuleId, "any order", false, List.of(first, second));

      List<UUID> entries =
          steps.load(projectId).resolve(Scope.SUB_MODULE, subModuleId).get(0).entries().stream()
              .map(entry -> entry.entry().id())
              .toList();
      stepUseCases.setState(anand, entries.get(0), io.mtms.domain.model.Steps.State.DONE, null);

      assertTrue(
          inbox.inbox(TENANT, vinayak, 10).isEmpty(),
          "step 2 was never blocked, so nobody was waiting to be told");
    }

    @Test
    @DisplayName("ticking the last step tells nobody — there is no next one")
    void lastStepNotifiesNobody() {
      Actor anand = admin();
      UUID vinayak = user("Vinayak", Tenancy.UserStatus.ACTIVE);
      access.insertMembership(
          new Tenancy.Membership(
              UUID.randomUUID(), TENANT, vinayak, projectId, qaRoleId, Instant.now()));

      List<UUID> entries = orderedChecklist(anand);
      stepUseCases.setState(anand, entries.get(0), io.mtms.domain.model.Steps.State.DONE, null);
      int afterFirst = inbox.inbox(TENANT, vinayak, 10).size();

      stepUseCases.setState(anand, entries.get(1), io.mtms.domain.model.Steps.State.DONE, null);

      assertEquals(afterFirst, inbox.inbox(TENANT, vinayak, 10).size());
    }
  }
}
