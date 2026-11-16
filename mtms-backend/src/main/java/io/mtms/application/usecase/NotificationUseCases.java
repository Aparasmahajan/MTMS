package io.mtms.application.usecase;

import io.mtms.application.Actor;
import io.mtms.application.port.AccessRepository;
import io.mtms.application.port.NotificationRepository;
import io.mtms.application.port.Notifier;
import io.mtms.domain.model.Notifications;
import io.mtms.domain.model.Tenancy;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Writing notifications, and attempting to send them.
 *
 * <p>Called by the use cases that cause them — a comment that names somebody, a step that gets
 * blocked, a step that becomes tickable — rather than by a listener over the event outbox. The
 * outbox would decouple them, and it would also mean a notification could exist for a tick that
 * was rolled back. These are written in the same transaction as the thing they are about, so
 * neither ever exists without the other.
 *
 * <p><strong>Sending is not.</strong> The transport is attempted after the write and its failure
 * is swallowed: the notification is already in the recipient's inbox, so a chat server being
 * down has degraded the delivery and lost nothing. Rolling back somebody's tick because a
 * webhook timed out would be absurd.
 */
@Service
public class NotificationUseCases {

  /** One page of inbox. Older than this is history, and the thing it points at is still there. */
  private static final int INBOX_LIMIT = 50;

  private final NotificationRepository notifications;
  private final AccessRepository access;
  private final Notifier notifier;

  public NotificationUseCases(
      NotificationRepository notifications, AccessRepository access, Notifier notifier) {
    this.notifications = notifications;
    this.access = access;
    this.notifier = notifier;
  }

  // --- Reading ---------------------------------------------------------------

  @Transactional(readOnly = true)
  public List<Notifications.Notification> inbox(Actor actor) {
    return notifications.inbox(actor.tenantId(), actor.userId(), INBOX_LIMIT);
  }

  @Transactional(readOnly = true)
  public int unread(Actor actor) {
    return notifications.unreadCount(actor.tenantId(), actor.userId());
  }

  /**
   * Marks one read.
   *
   * <p>No permission check and no not-found. The tenant and the user are in the WHERE clause, so
   * somebody else's id matches nothing — which is the right answer, and quieter than a refusal
   * that would confirm the id exists.
   */
  @Transactional
  public void markRead(Actor actor, UUID notificationId) {
    notifications.markRead(actor.tenantId(), actor.userId(), notificationId, Instant.now());
  }

  @Transactional
  public void markAllRead(Actor actor) {
    notifications.markAllRead(actor.tenantId(), actor.userId(), Instant.now());
  }

  // --- Writing ---------------------------------------------------------------

  /**
   * Writes one notification per recipient and tries to send each.
   *
   * <p>Two rules about who is left out, and both are about not being noisy:
   *
   * <ul>
   *   <li><strong>Never the actor.</strong> Being told about something you just did is the
   *       fastest way to teach somebody to ignore the badge.
   *   <li><strong>Never a deactivated account.</strong> Nobody is reading it.
   * </ul>
   */
  @Transactional
  public void notify(
      Actor actor,
      Collection<UUID> recipients,
      Notifications.Kind kind,
      String title,
      String body,
      String link) {

    Instant now = Instant.now();
    List<Tenancy.User> users = access.findUsers(actor.tenantId());

    List<Notifications.Notification> written = new ArrayList<>();
    List<String> emails = new ArrayList<>();

    Set<UUID> unique = Set.copyOf(recipients);
    for (UUID userId : unique) {
      if (userId.equals(actor.userId())) {
        continue;
      }
      Tenancy.User user =
          users.stream().filter(candidate -> candidate.id().equals(userId)).findFirst().orElse(null);
      if (user == null || user.status() == Tenancy.UserStatus.DEACTIVATED) {
        continue;
      }

      written.add(
          Notifications.Notification.of(
              actor.tenantId(), actor.projectId(), userId, kind, title, body, link, now));
      emails.add(user.email());
    }

    if (written.isEmpty()) {
      return;
    }

    notifications.insert(written);

    // Attempted after the write, and its result only recorded. `delivered_at` stays null when
    // no transport is configured, which is the normal state and is honest: the column says
    // which rows were also sent somewhere, not that they all were.
    List<UUID> delivered = new ArrayList<>();
    for (int i = 0; i < written.size(); i++) {
      if (notifier.deliver(written.get(i), emails.get(i))) {
        delivered.add(written.get(i).id());
      }
    }
    if (!delivered.isEmpty()) {
      notifications.markDelivered(delivered, now);
    }
  }

  /**
   * Writes one notification to the actor themselves, and sends it nowhere.
   *
   * <p>Two deliberate departures from {@link #notify}, and both are the point of the method.
   *
   * <p><strong>It is addressed to the actor</strong>, which {@code notify} refuses. That refusal
   * is right for the three "somebody is waiting for you" kinds — nobody needs telling about
   * their own tick — and wrong here, where the whole purpose is handing the person who just
   * acted something they have to keep.
   *
   * <p><strong>No transport is attempted.</strong> The body carries a live, single-use
   * credential, and the configured {@link Notifier} is a Teams or Slack webhook — posting a
   * password-reset link into a chat channel that the account's owner is not even in would be a
   * worse outcome than the banner this replaces. The row goes in the recipient's own inbox and
   * stays there.
   *
   * <p>What that costs, stated rather than buried: the link is now <b>at rest in the
   * notifications table</b>, where before it existed only in a banner and in the recipient's
   * mailbox. It is single-use and expires in seven days, so the window is bounded — but anybody
   * who can read that table during those seven days can use it. That is the trade for a link
   * that survives a page refresh, and it is the reason this does not also go to a webhook.
   */
  @Transactional
  public void notifySelf(
      Actor actor, Notifications.Kind kind, String title, String body, String link) {

    notifications.insert(
        List.of(
            Notifications.Notification.of(
                actor.tenantId(),
                actor.projectId(),
                actor.userId(),
                kind,
                title,
                body,
                link,
                Instant.now())));
  }

  /** Everybody in this organisation holding any of these roles — who a team notification reaches. */
  public Set<UUID> holdersOf(Actor actor, Collection<UUID> roleIds) {
    if (roleIds.isEmpty()) {
      return Set.of();
    }
    return access.memberships(actor.tenantId()).stream()
        .filter(membership -> roleIds.contains(membership.roleId()))
        // Organisation-wide grants count: they apply to every project, this one included.
        .filter(
            membership ->
                membership.projectId() == null
                    || membership.projectId().equals(actor.projectId()))
        .map(Tenancy.Membership::userId)
        .collect(java.util.stream.Collectors.toUnmodifiableSet());
  }
}
