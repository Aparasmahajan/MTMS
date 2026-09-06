package io.mtms.domain.view;

import io.mtms.domain.model.Audit;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * What the super admin console reads.
 *
 * <p>Counts, names and status. Deliberately no module name, deliverable, defect, ticket key or
 * project audit entry appears anywhere in this shape, and none should be added: a platform
 * operator provisions organisations, they do not work inside them. The type is the boundary —
 * if the data is not in the record, no careless projection can leak it.
 *
 * <p>Mirrors {@code PlatformView} in the TypeScript implementation field for field, so the same
 * frontend renders against either back end.
 */
public record PlatformView(Me me, List<Organisation> organisations, List<Audit.PlatformAuditEntry> audit) {

  public record Me(String displayName, String email) {}

  /** Somebody who can administer an organisation, so one is never left without an owner. */
  public record Administrator(String displayName, String email, String status) {}

  public record ProjectSummary(UUID id, String key, String name, boolean configured, int moduleCount) {}

  /**
   * @param configuredProjectCount projects with at least one deliverable column. The rest are
   *     shells awaiting their owner's set-up, which is a different thing from an empty project
   *     and worth distinguishing on the screen.
   */
  public record Organisation(
      UUID id,
      String name,
      String slug,
      String status,
      Instant createdAt,
      int projectCount,
      int configuredProjectCount,
      int userCount,
      int moduleCount,
      List<Administrator> admins,
      List<ProjectSummary> projects) {}
}
