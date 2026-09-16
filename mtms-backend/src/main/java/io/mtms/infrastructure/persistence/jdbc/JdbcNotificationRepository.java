package io.mtms.infrastructure.persistence.jdbc;

import io.mtms.application.port.NotificationRepository;
import io.mtms.domain.model.Notifications;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** Inboxes, on MySQL. */
@Repository
@ConditionalOnProperty(name = "mtms.storage", havingValue = "mysql")
public class JdbcNotificationRepository implements NotificationRepository {

  private final Db jdbc;

  public JdbcNotificationRepository(JdbcTemplate jdbc) {
    this.jdbc = new Db(jdbc);
  }

  @Override
  public List<Notifications.Notification> inbox(UUID tenantId, UUID userId, int limit) {
    // Unread first, then newest. Reading down an inbox should not mean scrolling past last
    // week's read items to find this morning's unread one.
    //
    // LIMIT is a bind parameter. It was concatenated once elsewhere in this package and a Java
    // text block ate the trailing space, producing LIMIT1000 and a query that failed on every
    // call — see the note in JdbcStepRepository.
    return jdbc.query(
        """
        SELECT * FROM notifications
         WHERE tenant_id = ? AND user_id = ?
         ORDER BY (read_at IS NOT NULL), created_at DESC
         LIMIT ?
        """,
        Rows.NOTIFICATION,
        tenantId,
        userId,
        limit);
  }

  @Override
  public int unreadCount(UUID tenantId, UUID userId) {
    Integer count =
        jdbc.queryForObject(
            """
            SELECT count(*) FROM notifications
             WHERE tenant_id = ? AND user_id = ? AND read_at IS NULL
            """,
            Integer.class,
            tenantId,
            userId);
    return count == null ? 0 : count;
  }

  @Override
  public void insert(Collection<Notifications.Notification> notifications) {
    for (Notifications.Notification notification : notifications) {
      jdbc.update(
          """
          INSERT INTO notifications
                 (id, tenant_id, project_id, user_id, kind, title, body, link, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          """,
          notification.id(),
          notification.tenantId(),
          notification.projectId(),
          notification.userId(),
          notification.kind().wire(),
          notification.title(),
          notification.body(),
          notification.link(),
          Sql.timestamp(notification.createdAt()));
    }
  }

  @Override
  public void markRead(UUID tenantId, UUID userId, UUID notificationId, Instant at) {
    // The user and tenant are in the WHERE rather than checked beforehand. Somebody else's id
    // matches no row, which is the right answer and not an error worth distinguishing — a
    // refusal would confirm that the id exists.
    jdbc.update(
        """
        UPDATE notifications SET read_at = ?
         WHERE id = ? AND tenant_id = ? AND user_id = ? AND read_at IS NULL
        """,
        Sql.timestamp(at),
        notificationId,
        tenantId,
        userId);
  }

  @Override
  public void markAllRead(UUID tenantId, UUID userId, Instant at) {
    jdbc.update(
        """
        UPDATE notifications SET read_at = ?
         WHERE tenant_id = ? AND user_id = ? AND read_at IS NULL
        """,
        Sql.timestamp(at),
        tenantId,
        userId);
  }

  @Override
  public void markDelivered(Collection<UUID> notificationIds, Instant at) {
    for (UUID id : notificationIds) {
      jdbc.update("UPDATE notifications SET delivered_at = ? WHERE id = ?", Sql.timestamp(at), id);
    }
  }
}
