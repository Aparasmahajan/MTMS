package io.mtms.application.port;

import io.mtms.domain.view.Snapshot;
import java.util.Optional;
import java.util.UUID;

/**
 * The projection cache.
 *
 * <p>The key is the interesting part. A snapshot is cached per <strong>(tenant, project, user,
 * revision)</strong>, and each of those four is load-bearing:
 *
 * <ul>
 *   <li><strong>revision</strong> is what makes this correct without invalidation. After any
 *       write the project's revision moves, so the old key is simply never asked for again and
 *       a stale read is not possible. There is no cache-busting code to get wrong, because
 *       there is no cache busting.
 *   <li><strong>user</strong> is what keeps it honest. A snapshot carries that user's
 *       permissions and their members list. A cache shared across users would serve an admin's
 *       view to a viewer — the same object, with the buttons enabled.
 *   <li><strong>tenant and project</strong> scope it to what was actually assembled.
 * </ul>
 *
 * <p>Entries are left to expire rather than deleted: superseded keys are unreachable the moment
 * the revision moves, so a TTL is the cheapest correct way to reclaim them.
 */
public interface SnapshotCache {

  record Key(UUID tenantId, UUID projectId, UUID userId, long revision) {

    /** Flat, readable, and collision-free — the four parts cannot run together ambiguously. */
    public String asString() {
      return "snapshot:" + tenantId + ':' + projectId + ':' + userId + ':' + revision;
    }
  }

  Optional<Snapshot> get(Key key);

  void put(Key key, Snapshot snapshot);

  /**
   * Drops everything. Only for administrative use and tests — ordinary writes rely on the
   * revision moving, not on eviction.
   */
  void clear();
}
