package io.mtms.domain.view;

import io.mtms.domain.model.Audit;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * What the super admin console reads.
 *
 * <p>Counts, names and status. Deliberately no sub-module name, deliverable, defect, ticket key or
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

  /**
   * One person's administrator access to one project.
   *
   * <p>Many administrators to a project and many projects to an administrator, both — the
   * membership row is {@code (user, project, role)}, so both directions are just rows.
   *
   * @param orgWide true when the access is organisation-wide and therefore covers every
   *     project, this one included. The console shows it differently and refuses to remove
   *     it from a single project's row, because doing so would take away far more than the
   *     row suggests — it is removed from {@link Organisation#orgWideAdmins} instead, where
   *     the scope of what is being taken away is what the reader is already looking at.
   */
  public record ProjectAdministrator(
      UUID userId, UUID membershipId, String displayName, String email, String status, boolean orgWide) {}

  /**
   * @param admins everyone who can administer this project. A project with none is a project
   *     nobody can configure, so the console shows that rather than leaving it to be found.
   */
  public record ProjectSummary(
      UUID id,
      String key,
      String name,
      boolean configured,
      int subModuleCount,
      List<ProjectAdministrator> admins) {}

  /**
   * @param configuredProjectCount projects with at least one deliverable column. The rest are
   *     shells awaiting their owner's set-up, which is a different thing from an empty project
   *     and worth distinguishing on the screen.
   * @param admins everyone who can administer the organisation, by any route — for the summary
   *     line, which only wants names.
   * @param orgWideAdmins the subset whose access is organisation-wide, carrying the membership
   *     id so it can be revoked. This is the only place an organisation-wide grant is offered
   *     for removal: it is the one screen position where "every project" is the visible scope.
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
      int subModuleCount,
      List<Administrator> admins,
      List<ProjectAdministrator> orgWideAdmins,
      List<ProjectSummary> projects) {}
}
