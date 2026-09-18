package io.mtms.application.port;

import io.mtms.domain.model.Notifications;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.UUID;

/**
 * One person's inbox.
 *
 * <p>Read per user rather than per project, which is the one read in this application that is
 * not project-scoped — a notification is addressed to a person and follows them across every
 * project they are in. It is still tenant-scoped: an inbox that could show a row from another
 * organisation would be the only place in the system where that was possible.
 */
public interface NotificationRepository {

  /** Newest first, capped. The inbox shows a page; the count below is the badge. */
  List<Notifications.Notification> inbox(UUID tenantId, UUID userId, int limit);

  int unreadCount(UUID tenantId, UUID userId);

  /** Written in the same transaction as the thing they are about, so neither exists alone. */
  void insert(Collection<Notifications.Notification> notifications);

  /** Marks one as read. Ignores a notification belonging to somebody else. */
  void markRead(UUID tenantId, UUID userId, UUID notificationId, Instant at);

  void markAllRead(UUID tenantId, UUID userId, Instant at);

  /** Set when an external transport accepted it. Null stays null when none is configured. */
  void markDelivered(Collection<UUID> notificationIds, Instant at);
}
