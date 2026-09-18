package io.mtms.api;

import io.mtms.application.Actor;
import io.mtms.application.SnapshotService;
import io.mtms.application.usecase.NotificationUseCases;
import io.mtms.domain.view.Snapshot;
import java.util.UUID;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The reader's own inbox.
 *
 * <p>Only writes here. The inbox itself rides on every {@link Snapshot}, so the badge and the
 * list are already on screen without a second request firing on every page — and a tick that
 * unblocks somebody updates their badge in the same round trip that updates the checklist.
 *
 * <p>No permission check on either route, and that is not an oversight. A notification is
 * addressed to one person; the tenant and the user are in the WHERE clause, so somebody else's
 * id matches no row. There is nothing here that a permission could usefully gate.
 */
@RestController
@RequestMapping("/api/v1/notifications")
public class NotificationController {

  private final NotificationUseCases notifications;
  private final SnapshotService snapshots;

  public NotificationController(
      NotificationUseCases notifications, SnapshotService snapshots) {
    this.notifications = notifications;
    this.snapshots = snapshots;
  }

  /**
   * Marks one read.
   *
   * <p>POST rather than PATCH on a field: what the caller is doing is dismissing a message, not
   * editing a record. An id that is not theirs matches nothing and answers 200 — the alternative
   * is a 404 that confirms the id exists.
   */
  @PostMapping("/{id}/read")
  public ApiResponse.Success<Snapshot> markRead(
      @PathVariable("id") UUID notificationId, Actor actor) {

    notifications.markRead(actor, notificationId);
    return ApiResponse.ok(snapshots.of(actor));
  }

  @PostMapping("/read")
  public ApiResponse.Success<Snapshot> markAllRead(Actor actor) {
    notifications.markAllRead(actor);
    return ApiResponse.ok(snapshots.of(actor));
  }
}
