package io.mtms.application;

import io.mtms.application.port.AccessRepository;
import io.mtms.application.port.ProjectData;
import io.mtms.application.port.ProjectRepository;
import io.mtms.application.port.SnapshotCache;
import io.mtms.domain.view.Snapshot;
import java.time.Instant;
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

  private final ProjectRepository projects;
  private final AccessRepository access;
  private final SnapshotCache cache;
  private final SnapshotProjection projection;

  public SnapshotService(
      ProjectRepository projects,
      AccessRepository access,
      SnapshotCache cache,
      @Value("${mtms.ticket-base-url:https://tms.internal/browse}") String ticketBaseUrl) {
    this.projects = projects;
    this.access = access;
    this.cache = cache;
    this.projection = new SnapshotProjection(ticketBaseUrl);
  }

  @Transactional(readOnly = true)
  public Snapshot of(Actor actor) {
    ProjectData data =
        projects
            .load(actor.tenantId(), actor.projectId())
            .orElseThrow(() -> ServiceException.notFound("That project does not exist."));

    SnapshotCache.Key key =
        new SnapshotCache.Key(
            actor.tenantId(), actor.projectId(), actor.userId(), data.revision());

    return cache
        .get(key)
        .orElseGet(
            () -> {
              Snapshot snapshot =
                  projection.build(
                      actor,
                      data,
                      access.load(actor.tenantId()),
                      projects.findAllByTenant(actor.tenantId()),
                      projects.moduleCounts(actor.tenantId()),
                      Instant.now());
              cache.put(key, snapshot);
              return snapshot;
            });
  }
}
