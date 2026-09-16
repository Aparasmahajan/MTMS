package io.mtms.infrastructure.persistence.memory;

import io.mtms.application.port.NotificationRepository;
import io.mtms.domain.model.Notifications;
import java.time.Instant;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import java.util.function.Predicate;
import java.util.function.UnaryOperator;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Repository;

/** Inboxes, over {@link InMemoryDatabase}. */
@Repository
@ConditionalOnProperty(name = "mtms.storage", havingValue = "memory", matchIfMissing = true)
public class InMemoryNotificationRepository implements NotificationRepository {

  private final InMemoryDatabase db;

  public InMemoryNotificationRepository(InMemoryDatabase db) {
    this.db = db;
  }

  @Override
  public List<Notifications.Notification> inbox(UUID tenantId, UUID userId, int limit) {
    return mine(tenantId, userId)
        // Unread first, then newest — the same order the SQL produces, and for the same reason:
        // reading down an inbox should not mean scrolling past last week to find this morning.
        .sorted(
            Comparator.comparing(Notifications.Notification::isUnread)
                .reversed()
                .thenComparing(Notifications.Notification::createdAt, Comparator.reverseOrder()))
        .limit(limit)
        .toList();
  }

  @Override
  public int unreadCount(UUID tenantId, UUID userId) {
    return (int) mine(tenantId, userId).filter(Notifications.Notification::isUnread).count();
  }

  @Override
  public void insert(Collection<Notifications.Notification> notifications) {
    db.notifications.addAll(notifications);
  }

  @Override
  public void markRead(UUID tenantId, UUID userId, UUID notificationId, Instant at) {
    replace(
        notification ->
            notification.id().equals(notificationId)
                && notification.tenantId().equals(tenantId)
                && notification.userId().equals(userId)
                && notification.isUnread(),
        notification -> withRead(notification, at));
  }

  @Override
  public void markAllRead(UUID tenantId, UUID userId, Instant at) {
    replace(
        notification ->
            notification.tenantId().equals(tenantId)
                && notification.userId().equals(userId)
                && notification.isUnread(),
        notification -> withRead(notification, at));
  }

  @Override
  public void markDelivered(Collection<UUID> notificationIds, Instant at) {
    replace(
        notification -> notificationIds.contains(notification.id()),
        notification ->
            new Notifications.Notification(
                notification.id(),
                notification.tenantId(),
                notification.projectId(),
                notification.userId(),
                notification.kind(),
                notification.title(),
                notification.body(),
                notification.link(),
                notification.createdAt(),
                notification.readAt(),
                at));
  }

  private java.util.stream.Stream<Notifications.Notification> mine(UUID tenantId, UUID userId) {
    return db.notifications.stream()
        .filter(
            notification ->
                notification.tenantId().equals(tenantId) && notification.userId().equals(userId));
  }

  private static Notifications.Notification withRead(
      Notifications.Notification notification, Instant at) {
    return new Notifications.Notification(
        notification.id(),
        notification.tenantId(),
        notification.projectId(),
        notification.userId(),
        notification.kind(),
        notification.title(),
        notification.body(),
        notification.link(),
        notification.createdAt(),
        at,
        notification.deliveredAt());
  }

  private void replace(
      Predicate<Notifications.Notification> matches,
      UnaryOperator<Notifications.Notification> change) {
    for (int i = 0; i < db.notifications.size(); i++) {
      if (matches.test(db.notifications.get(i))) {
        db.notifications.set(i, change.apply(db.notifications.get(i)));
      }
    }
  }
}
