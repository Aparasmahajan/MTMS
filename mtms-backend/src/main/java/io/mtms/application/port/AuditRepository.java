package io.mtms.application.port;

import io.mtms.domain.model.Audit;
import java.util.List;
import java.util.UUID;

/**
 * The audit feeds.
 *
 * <p>Append-only by design: there is no update and no delete on this interface, and adding one
 * would defeat the point. The question this application exists to answer is "who changed this,
 * and when", months later, and an editable audit trail answers it only until somebody edits it.
 */
public interface AuditRepository {

  void append(Audit.AuditEntry entry);

  /** Most recent first. The feed is always read that way, and the index is built for it. */
  List<Audit.AuditEntry> recent(UUID projectId, int limit);

  void appendPlatform(Audit.PlatformAuditEntry entry);

  List<Audit.PlatformAuditEntry> recentPlatform(int limit);
}
