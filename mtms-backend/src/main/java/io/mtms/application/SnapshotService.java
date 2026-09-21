package io.mtms.application;

import io.mtms.application.port.AccessRepository;
import io.mtms.application.port.NotificationRepository;
import io.mtms.application.port.ProjectData;
import io.mtms.application.port.ProjectRepository;
import io.mtms.application.port.SnapshotCache;
import io.mtms.domain.model.Notifications;
import io.mtms.domain.view.Snapshot;
import java.time.Instant;
import java.util.List;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Reads the project, cached.
 *
 * <p>Thin on purpose: fetch, check the cache, project, store. The interesting decisions are in
 * the two things it composes — the key design in {@link SnapshotCache} and the single-pass
 * assembly in {@link SnapshotProjection} — and this class exists so neither of them has to know
 * about the other.
 */
@Service
public class SnapshotService {

  /** One page of inbox on the snapshot. Older than this is history, reachable from its own screen. */
  private static final int INBOX_LIMIT = 50;

  private final ProjectRepository projects;
  private final AccessRepository access;
  private final NotificationRepository notifications;
  private final SnapshotCache cache;
  private final SnapshotProjection projection;

  public SnapshotService(
      ProjectRepository projects,
      AccessRepository access,
      NotificationRepository notifications,
      SnapshotCache cache,
      @Value("${mtms.ticket-base-url:https://tms.internal/browse}") String ticketBaseUrl) {
    this.projects = projects;
    this.access = access;
    this.notifications = notifications;
    this.cache = cache;
    this.projection = new SnapshotProjection(ticketBaseUrl);
  }

  @Transactional(readOnly = true)
  public Snapshot of(Actor actor) {
    ProjectData data =
        projects
            .load(actor.tenantId(), actor.projectId())
            .orElseThrow(() -> ServiceException.notFound("That project does not exist."));

    // The inbox is NOT in the cache key and the snapshot is NOT cached with it.
    //
    // The key is (tenant, project, user, revision), and a notification arriving does not move
    // the project's revision — it is not a change to the project. Caching the two together
    // would serve a stale badge until somebody happened to tick something, which is exactly
    // the bug that made a new project take ten minutes to appear in the switcher.
    //
    // So the expensive half is cached and the inbox is read every time. It is one indexed
    // query against an index whose leading columns are (user_id, read_at).
    List<Notifications.Notification> inbox =
        notifications.inbox(actor.tenantId(), actor.userId(), INBOX_LIMIT);

    SnapshotCache.Key key =
        new SnapshotCache.Key(
            actor.tenantId(), actor.projectId(), actor.userId(), data.revision());

    Snapshot cached = cache.get(key).orElse(null);
    if (cached != null) {
      return withInbox(cached, inbox);
    }

    Snapshot snapshot =
        projection.build(
            actor,
            data,
            access.load(actor.tenantId()),
            projects.findAllByTenant(actor.tenantId()),
            projects.subModuleCounts(actor.tenantId()),
            inbox,
            Instant.now());

    // Cached with an empty inbox, so a projection built for one reader cannot carry their
    // messages to the next — the key includes the user, but being explicit costs nothing and
    // the alternative failure is somebody reading another person's notifications.
    cache.put(key, withInbox(snapshot, List.of()));
    return snapshot;
  }

  /** The same snapshot with a different inbox on it. Records are immutable; this is the copy. */
  private static Snapshot withInbox(Snapshot snapshot, List<Notifications.Notification> inbox) {
    List<io.mtms.domain.view.Views.NotificationView> views =
        inbox.stream()
            .map(
                notification ->
                    new io.mtms.domain.view.Views.NotificationView(
                        notification.id().toString(),
                        notification.kind().wire(),
                        notification.title(),
                        notification.body(),
                        notification.link(),
                        notification.createdAt() == null ? null : notification.createdAt().toString(),
                        notification.isUnread()))
            .toList();

    return new Snapshot(
        snapshot.me(), snapshot.org(), snapshot.project(), snapshot.projects(), snapshot.config(),
        snapshot.subModules(), snapshot.audit(), snapshot.defects(), snapshot.library(),
        snapshot.roles(), snapshot.users(), snapshot.members(), snapshot.invitations(),
        snapshot.stepLibrary(),
        views,
        (int) inbox.stream().filter(Notifications.Notification::isUnread).count(),
        snapshot.drift(),
        snapshot.timing());
  }
}
